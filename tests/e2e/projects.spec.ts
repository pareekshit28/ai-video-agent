import { expect, test } from "@playwright/test";

test("projects contain independent scenes and import existing scenes", async ({ page }, info) => {
  let deleteFailures = 1;
  const parents: { id: string; title: string; updatedAt: number }[] = [];
  type Scene = { id: string; collectionId?: string; title: string; script: string; [key: string]: unknown };
  function scene(id: string, title: string, script: string, collectionId?: string): Scene { return { id, title, script, collectionId, summary: "", model: "", createdAt: Date.now(), updatedAt: Date.now(), status: "ready", active: false, folder: "C:/Videos/Scene", references: [], clips: [], clipCount: 0, completed: 0, settings: { steps: 6, megapixels: 1, aspectRatio: "16:9", refImageSize: "max" } }; }
  const scenes: Scene[] = [scene("66880bc9-b44c-4926-a22b-31d1a2226700", "Existing scene", "Original script")];
  const assets: { id: string; collectionId: string; name: string; kind: string; description: string; images: unknown[]; voices: unknown[] }[] = [];
  await page.route("**/api/agent/codex", route => route.fulfill({ json: { connected: false, imageGeneration: false, models: [], skills: [] } }));
  await page.route("**/api/characters*", async route => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON(); const asset = { ...data, id: String(assets.length), images: [], voices: [] }; assets.push(asset); await route.fulfill({ json: { character: asset } });
    } else await route.fulfill({ json: { characters: assets.filter(item => item.collectionId === new URL(route.request().url()).searchParams.get("collectionId")) } });
  });
  await page.route("**/api/video/settings", route => route.fulfill({ json: { configured: true, endpoint: "test-endpoint" } }));
  await page.route("**/api/projects", async route => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON();
      if (data.action === "organize") { await route.fulfill({ json: { ok: true } }); }
      else if (data.action === "delete") {
        expect(data.title).toBe("Station film");
        if (deleteFailures--) return route.fulfill({status:409,json:{error:"This project has unfinished Runpod jobs."}});
        const index = parents.findIndex(item=>item.id===data.projectId); parents.splice(index,1);
        for (let index=scenes.length-1;index>=0;index--) if(scenes[index].collectionId===data.projectId) scenes.splice(index,1);
        await route.fulfill({json:{deleted:{id:data.projectId,trashFolders:["C:/Videos/.trash/deleted-project"]}}});
      }
      else if (data.action === "create") {
        const parent = { id: `76880bc9-b44c-4926-a22b-31d1a222670${parents.length}`, title: data.title, updatedAt: Date.now() }; parents.push(parent);
        await route.fulfill({ json: { project: parent } });
      } else if (data.action === "rename") {
        const parent = parents.find(item => item.id === data.projectId)!; parent.title = data.title; await route.fulfill({ json: { project: parent } });
      } else { scenes.find(item => item.id === data.sceneId)!.collectionId = data.projectId; await route.fulfill({ json: { ok: true } }); }
    } else await route.fulfill({ json: { projects: parents.map(parent => ({ ...parent, sceneCount: scenes.filter(item => item.collectionId === parent.id).length, clipCount: 0, completed: 0, active: false })) } });
  });
  await page.route("**/api/agent/projects", async route => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON(); let item: Scene;
      if (data.action === "create") { item = scene(`66880bc9-b44c-4926-a22b-31d1a222670${scenes.length}`, data.title, data.script, data.collectionId); scenes.push(item); }
      else { item = scenes.find(item => item.id === data.projectId)!; if (data.action === "rename") item.title = data.title; else item.script = data.script; }
      await route.fulfill({ json: { project: item } });
    } else await route.fulfill({ json: { folder: "C:/Videos", projects: scenes } });
  });
  await page.route("**/api/agent/project?*", route => route.fulfill({ json: { project: scenes.find(item => item.id === new URL(route.request().url()).searchParams.get("projectId")) } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create your first project", exact: true })).toBeVisible();

  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await expect(page.getByRole("button", {name:"Projects", exact:true})).toHaveCount(0);
  await page.getByRole("combobox", {name:"Active project"}).selectOption("__manage");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", {name:"Project name", exact:true}).fill("Station film");
  await page.getByRole("button", {name:"Create project",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("combobox", {name:"Active project"})).toHaveValue(parents[0].id);
  await page.getByRole("button", {name:"Manage scenes",exact:true}).click();
  await page.getByRole("dialog").getByRole("button", {name:"New scene",exact:true}).click();
  await page.getByRole("textbox", {name:"Scene name",exact:true}).fill("Arrival");
  await page.getByRole("textbox", {name:"Script (optional)",exact:true}).fill("A traveler arrives.");
  await page.getByRole("button", {name:"Create and open scene"}).click();
  await expect(page.getByRole("textbox", {name:"Your scene"})).toHaveValue("A traveler arrives.");
  await page.getByRole("button", {name:"Manage scenes",exact:true}).click();
  await page.getByRole("combobox", {name:"Add an existing scene"}).selectOption(scenes[0].id);
  await expect(page.getByRole("heading", {name:"Existing scene",exact:true})).toBeVisible();
  await page.getByRole("button", {name:"Close scenes"}).click();
  await page.route("**/api/storage", route=>route.fulfill({json:{folder:"G:/My Drive/Video",previousFolders:[]}}));
  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await page.getByRole("button", {name:"Settings",exact:true}).click();
  await expect(page.getByRole("heading", {name:"Codex connection",exact:true})).toBeVisible();
  await expect(page.getByRole("textbox", {name:"Project storage folder"})).toHaveValue("G:/My Drive/Video");
  await expect(page.getByText("Project files are saved under Base location / Project name", {exact:false})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await page.getByRole("combobox",{name:"Active project"}).selectOption("__delete");
  await expect(page.getByRole("dialog")).toContainText("Station film");
  await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).click();
  expect(parents).toHaveLength(1);
  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await page.getByRole("combobox",{name:"Active project"}).selectOption("__delete");
  await page.getByRole("button",{name:"Delete project",exact:true}).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("unfinished Runpod");
  await page.getByRole("button",{name:"Delete project",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("combobox",{name:"Active project"})).toHaveValue("");
  await expect(page.getByRole("combobox",{name:"Active project"}).locator("option",{hasText:"Station film"})).toHaveCount(0);
  await expect(page.getByRole("status").filter({hasText:"Deleted"})).toContainText(".trash");
  await expect(page.getByRole("heading", { name: "Create your first project", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox",{name:"Active project"})).toHaveValue("");
  await page.screenshot({path:"test-results/"+info.project.name+"-common-settings.png",fullPage:true,animations:"disabled"});
});
