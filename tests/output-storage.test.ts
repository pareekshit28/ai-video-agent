import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { outputRoot, saveStorage, storageInfo } from "../src/lib/output-storage";
import { createProject, getProject, listProjects, projectFolder, writeAsset } from "../src/lib/agent-store";
import { saveCharacter, getCharacter, characterPath, listCharacters } from "../src/lib/characters";
import { defaultGeneration, type AgentProject } from "../src/lib/agent-types";
import { POST } from "../src/app/api/storage/route";
import { createCollection, getCollection, listCollections, renameCollection, organizeCollection } from "../src/lib/project-collections";
import { updateProject, assignScene } from "../src/lib/agent-store";
import { assignCharacter } from "../src/lib/characters";

let root: string, initial: string, destination: string;
it("does not restore stale flat backups beside organized project assets during a later storage copy", async () => {
  const parent = await createCollection("Film"), scene = await project(), asset = await saveCharacter({ name: "Prop", kind: "prop" });
  await saveStorage({ folder: destination, copyExisting: true });
  await assignScene(scene.id, parent.id); await assignCharacter(asset.id, parent.id);
  const third = join(root, "third"); await saveStorage({ folder: third, copyExisting: true });
  expect(await readdir(third)).not.toContain(scene.id);
  expect(projectFolder(scene.id)).toBe(join(third, parent.title, "scenes", scene.id));
  expect(characterPath(asset.id)).toBe(join(third, parent.title, "library", asset.id, "character.json"));
  expect(await readFile(join(projectFolder(scene.id), "clips/saved.mp4"), "utf8")).toBe("durable-video");
});
it("copies parent projects together with scene membership and supports old roots without copying", async () => {
  const parent = await createCollection("Film"); const scene = await project();
  await assignScene(scene.id, parent.id);
  const item = await saveCharacter({ collectionId: parent.id, kind: "prop", name: "Bag" });
  await saveStorage({ folder: destination, copyExisting: true });
  expect(JSON.parse(await readFile(join(destination, parent.title, "workspace.json"), "utf8")).title).toBe("Film");
  expect((await getProject(scene.id)).collectionId).toBe(parent.id); expect(await listCollections()).toHaveLength(1);
  expect(projectFolder(scene.id)).toBe(join(destination, parent.title, "scenes", scene.id));
  expect(characterPath(item.id)).toBe(join(destination, parent.title, "library", item.id, "character.json"));
  await saveStorage({ folder: join(root, "third"), copyExisting: false });
  await renameCollection(parent.id, "Renamed film");
  expect((await getCollection(parent.id)).title).toBe("Renamed film");
  expect(JSON.parse(await readFile(join(destination, "Renamed film", "workspace.json"), "utf8")).title).toBe("Renamed film");
});
beforeEach(async () => {
  const runtime = (globalThis as typeof globalThis & { studioStore?: { key?:Buffer; directory?:string; queue:Promise<unknown> } }).studioStore;
  if (runtime) { await runtime.queue; runtime.key=undefined; runtime.directory=undefined; }
  root = await mkdtemp(join(tmpdir(), "output-storage-tests-"));
  initial = join(root, "original"); destination = join(root, "drive", "AI Video Agent");
  vi.stubEnv("VIDEO_OUTPUT_DIR", initial); vi.stubEnv("AGENT_STORAGE_DIR", join(root, "settings"));
  vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel.startsWith("output-storage-tests-") && !rel.includes("..") && !isAbsolute(rel)) await rm(root, { recursive: true, force: true });
});
async function project() {
  const value: AgentProject = { id: crypto.randomUUID(), title: "Saved scene", script: "A scene", summary: "A scene", model: "test", createdAt: Date.now(), updatedAt: Date.now(), status: "ready", references: [], clips: [], settings: { ...defaultGeneration } };
  await createProject(value);
  await writeAsset(value.id, "clips/saved.mp4", Buffer.from("durable-video"), "video/mp4", "saved.mp4");
  return value;
}
it("copies projects and library, preserves originals, and persists the root across subsequent reads", async () => {
  const value = await project();
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBXkAAAAASUVORK5CYII=", "base64");
  const item = await saveCharacter({ kind: "location", name: "Station", images: [{ name: "station.png", bytes: image.length, base64: image.toString("base64") }] });
  const result = await saveStorage({ folder: destination, copyExisting: true });
  expect(result).toMatchObject({ copiedProjects: 1, copiedLibraryItems: 1 });
  expect(outputRoot()).toBe(destination); expect(projectFolder(value.id)).toBe(join(destination, value.id));
  expect(await readFile(join(initial, value.id, "clips/saved.mp4"), "utf8")).toBe("durable-video");
  expect(await readFile(join(projectFolder(value.id), "clips/saved.mp4"), "utf8")).toBe("durable-video");
  expect(await readFile(characterPath(item.id, item.images[0].path))).toEqual(image);
  expect((await getCharacter(item.id)).kind).toBe("location");
  expect(await listProjects()).toHaveLength(1); expect(await listCharacters()).toHaveLength(1);
  expect((await getProject(value.id)).id).toBe(value.id);
  vi.stubEnv("VIDEO_OUTPUT_DIR", join(root, "different-environment-default"));
  expect(storageInfo().folder).toBe(destination);
  expect(JSON.parse(await readFile(join(root, "settings", "output-storage.json"), "utf8")).folder).toBe(destination);
  expect(await readdir(destination)).not.toContain("credentials.enc");
});
it("keeps earlier items accessible without copying, and writes new projects in the new folder", async () => {
  const old = await project(); const item = await saveCharacter({ name: "Original character" });
  await saveStorage({ folder: destination, copyExisting: false });
  expect(projectFolder(old.id)).toBe(join(initial, old.id));
  await saveCharacter({ id: item.id, name: "Edited character" });
  expect((await getCharacter(item.id)).name).toBe("Edited character");
  expect(characterPath(item.id)).toBe(join(initial, "characters", item.id, "character.json"));
  const next = await project(); expect(projectFolder(next.id)).toBe(join(destination, next.id));
  expect(await listProjects()).toHaveLength(2);
});
it("rejects invalid, unwritable and conflicting destinations without changing the active folder", async () => {
  const value = await project();
  await expect(saveStorage({ folder: "relative/folder" })).rejects.toThrow("absolute path");
  await expect(saveStorage({ folder: join(initial, "nested") })).rejects.toThrow("outside");
  const file = join(root, "not-a-folder"); await writeFile(file, "keep");
  await expect(saveStorage({ folder: file })).rejects.toThrow("unavailable");
  expect(outputRoot()).toBe(initial);
  await saveStorage({ folder: destination });
  await expect(saveStorage({ folder: initial })).rejects.toThrow("same ID");
  expect(outputRoot()).toBe(destination);
  expect((await getProject(value.id)).id).toBe(value.id);
});
it("blocks changes during generation and enforces the local request guard", async () => {
  const globals = globalThis as typeof globalThis & { videoAgentRunner?: { active?: unknown } };
  const previous = globals.videoAgentRunner;
  globals.videoAgentRunner = { active: { projectId: "test" } };
  try { await expect(saveStorage({ folder: destination })).rejects.toThrow("Pause"); }
  finally { globals.videoAgentRunner = previous; }
  const response = await POST(new Request("http://127.0.0.1:3000/api/storage", { method: "POST", headers: { Origin: "https://attacker.example", Host: "127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify({ folder: destination }) }));
  expect(response.status).toBe(400); expect(outputRoot()).toBe(initial);
});

it("uses project names and migrates UUID folders without changing scene media", async () => {
  const parent = await createCollection("My film"), scene = await project(); await assignScene(scene.id, parent.id);
  expect(projectFolder(scene.id)).toBe(join(initial, "My film", "scenes", scene.id));
  await rename(join(initial, "My film"), join(initial, parent.id));
  expect((await listCollections())[0].id).toBe(parent.id);
  await organizeCollection(parent.id);
  expect(projectFolder(scene.id)).toBe(join(initial, "My film", "scenes", scene.id));
  await renameCollection(parent.id, "New film");
  expect(projectFolder(scene.id)).toBe(join(initial, "New film", "scenes", scene.id));
  expect(await readFile(join(projectFolder(scene.id), "clips/saved.mp4"), "utf8")).toBe("durable-video");
  expect(await readdir(initial)).not.toContain(parent.id);
});
it("rejects unsafe and conflicting project folder names", async () => {
  for (const name of ["../outside", "CON", "A/B", "A:film", "Film.", "characters"]) await expect(createCollection(name)).rejects.toThrow("valid project folder name");
  const parent = await createCollection("Film");
  await expect(createCollection("film")).rejects.toThrow("already exists");
  await createCollection("Other");
  await expect(renameCollection(parent.id, "other")).rejects.toThrow("already exists");
  expect((await getCollection(parent.id)).title).toBe("Film");
});

it("deletes all project copies without resurfacing scenes and keeps unrelated files recoverable", async () => {
  const { deleteCollection } = await import("../src/lib/project-collections");
  const parent = await createCollection("Film"), scene = await project(), other = await createCollection("Other film");
  const asset = await saveCharacter({ name:"Actor" });
  await saveStorage({folder:destination,copyExisting:true});
  await assignScene(scene.id,parent.id); await assignCharacter(asset.id,parent.id);
  const result = await deleteCollection(parent.id,parent.title);
  expect(await listCollections()).toEqual([other]);
  expect(await listProjects()).toHaveLength(0); expect(await listCharacters()).toHaveLength(0);
  await expect(getCollection(parent.id)).rejects.toThrow("could not be opened");
  expect(result.trashFolders).toHaveLength(2);
  const files: string[] = [];
  for (const folder of result.trashFolders) for (const entry of await readdir(folder)) files.push(join(folder,entry));
  const recovered = await Promise.all(files.map(file=>readFile(join(file,"scenes",scene.id,"clips/saved.mp4"),"utf8").catch(()=>null)));
  expect(recovered).toContain("durable-video");
  await saveStorage({folder:join(root,"third"),copyExisting:true});
  expect((await listCollections()).map(item=>item.id)).toEqual([other.id]);
  expect(await listProjects()).toHaveLength(0);
});
it("requires the current name and blocks deletion during generation and unfinished jobs", async () => {
  const { deleteCollection } = await import("../src/lib/project-collections");
  const { withDatabase } = await import("../src/lib/store");
  const parent = await createCollection("Film");
  await expect(deleteCollection(parent.id,"Old name")).rejects.toThrow("name changed");
  const globals = globalThis as typeof globalThis & { videoAgentRunner?: {active?:unknown} };
  const previous = globals.videoAgentRunner; globals.videoAgentRunner={active:{projectId:"test"}};
  try { await expect(deleteCollection(parent.id,parent.title)).rejects.toThrow("Pause"); } finally { globals.videoAgentRunner=previous; }
  await withDatabase(db=>{db.h3Jobs=[{collectionId:parent.id,localId:crypto.randomUUID(),endpoint:"test",prompt:"test",createdAt:Date.now(),status:"IN_QUEUE"}];});
  await expect(deleteCollection(parent.id,parent.title)).rejects.toThrow("unfinished Runpod");
  expect((await getCollection(parent.id)).title).toBe("Film");
  await withDatabase(db=>{db.h3Jobs=[];});
  await deleteCollection(parent.id,parent.title); expect(await listCollections()).toHaveLength(0);
});
