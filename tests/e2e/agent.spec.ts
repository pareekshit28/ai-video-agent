import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { PublicProject } from "../../src/lib/agent-types";
import { mockProject, testProjectId } from "./project-context";
const defaultGeneration = { aspectRatio: "16:9 (Widescreen)" as const, megapixels: 1, steps: 6, refImageSize: "max" as const };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBXkAAAAASUVORK5CYII=", "base64");
const video = readFileSync(new URL("../fixtures/agent-preview.mp4", import.meta.url));
function planned(): PublicProject {
  return { collectionId: testProjectId, id: "f01aaeed-aaaa-4aaa-8aaa-000000000000", title: "Station arrival", summary: "A traveler waits, then boards a train.", script: "A traveler arrives at a station, then boards a train.", model: "codex:test-model", createdAt: Date.now(), updatedAt: Date.now(), status: "ready", sequentialPrompts: false, reviewBeforeEachClip: false, reviewAfterEachClip: false, active: false, folder: "D:\\Videos\\AI Video Agent\\station-arrival", settings: { ...defaultGeneration }, references: [{ id: "traveler", name: "Traveler", kind: "character", description: "The main traveler." }, { id: "station", name: "Station", kind: "location", description: "The old station." }], clips: [{ id: "arrival", title: "Arrival", duration: 5, prompt: "A traveler approaches the station.", referenceIds: ["traveler", "station"], continuation: false, status: "pending" }, { id: "boarding", title: "Boarding", duration: 10, prompt: "The traveler boards the arriving train.", referenceIds: ["traveler", "station"], continuation: true, status: "pending" }] };
}
async function setup(page: Page, initial?: PublicProject) {
  await mockProject(page);
  await page.route("**/api/characters*", route => route.fulfill({ json: { characters: [] } }));
  let project = initial; const requests: { path: string; body: any }[] = []; let polls = 0; let runningClip: string | undefined;
  await page.route("**/api/agent/codex", route => route.fulfill({ json: { connected: true, imageGeneration: true, models: [{ slug: "codex:test-model", displayName: "Test · Codex", reasoningEfforts: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }, { effort: "high", description: "Thorough" }], defaultReasoningEffort: "low" }], skills: ["imagegen"] } }));
  await page.route("**/api/video/settings", route => route.fulfill({ json: { endpoint: "xnnd4qobofshqz", configured: true, environmentKey: true } }));
  await page.route("**/api/agent/projects", route => route.fulfill({ json: { folder: "D:\\Videos\\AI Video Agent", projects: project ? [{ id: project.id, collectionId: project.collectionId, title: project.title, status: project.status, active: project.active, completed: project.clips.filter(clip => clip.status === "complete").length, clipCount: 2 }] : [] } }));
  await page.route("**/api/agent/media?*", route => route.fulfill({ body: new URL(route.request().url()).searchParams.get("kind") === "video" ? video : png, contentType: new URL(route.request().url()).searchParams.get("kind") === "video" ? "video/mp4" : "image/png" }));
  await page.route("**/api/agent/analyze", route => { requests.push({ path: "analyze", body: route.request().postDataJSON() }); project = planned(); project.clips = []; project.referencesIdentified = true; project.reasoningEffort = route.request().postDataJSON().reasoningEffort; return route.fulfill({ json: { project } }); });
  await page.route("**/api/agent/reference", route => { const body = route.request().postDataJSON(); requests.push({ path: "reference", body }); project!.references.find(slot => slot.id === body.slotId)!.asset = body.file ? { path: `references/${body.slotId}.png`, name: body.file.name, bytes: body.file.bytes, mime: "image/png" } : undefined; return route.fulfill({ json: { project } }); });
  await page.route("**/api/agent/frame", route => {
    const body = route.request().postDataJSON(); requests.push({ path: "frame", body });
    const index = project!.clips.findIndex(clip => clip.id === body.clipId); const clip = project!.clips[index];
    clip.extractedFrame ||= clip.frame;
    clip.frame = body.file ? { path: `frames/${clip.id}-replacement.png`, bytes: body.file.bytes, name: body.file.name, mime: "image/png" } : clip.extractedFrame;
    clip.frameReplaced = Boolean(body.file);
    if (project!.clips[index + 1]?.status === "complete") project!.clips[index + 1].continuityOutdated = true;
    if (project!.sequentialPrompts !== false && project!.clips[index + 1]) project!.clips[index + 1].promptContextKey = undefined;
    return route.fulfill({ json: { project } });
  });
  await page.route("**/api/agent/run", route => {
    const body = route.request().postDataJSON(); requests.push({ path: "run", body });
    runningClip = body.clipId; polls = 0;
    if (body.action === "rerender" || body.action === "retry") {
      const clip = project!.clips.find(clip => clip.id === body.clipId)!;
      const { versions, revision, ...take } = clip;
      Object.assign(clip, { versions: [...(versions || []), { archivedAt: Date.now(), clip: take }], referenceIds: body.action === "retry" ? clip.referenceIds : revision!.referenceIds ?? clip.referenceIds, prompt: body.action === "retry" ? clip.prompt : revision!.prompt, revisionComments: body.action === "retry" ? clip.revisionComments : revision!.comments, revision: undefined, status: "pending", video: undefined, frame: undefined });
    }
    project!.active = body.action !== "pause"; project!.status = project!.active ? "running" : "paused";
    return route.fulfill({ json: { project } });
  });
  await page.route(url => url.pathname === "/api/agent/project", route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); requests.push({ path: "project", body });
      if (body.action === "plan") { project!.maxClipDuration = body.maxClipDuration; project!.sequentialPrompts = true; project!.clips = planned().clips.map((clip, index) => ({ ...clip, duration: Math.min(clip.duration, body.maxClipDuration ?? 30), outline: clip.prompt, compiledPrompt: index ? undefined : clip.prompt, referenceIds: project!.references.filter(slot => slot.asset || slot.audios?.length).map(slot => slot.id) })); }
      if (body.action === "planNextPrompt") { const index = project!.clips.findIndex(clip => clip.id === body.clipId); const clip = project!.clips[index], previous = project!.clips[index - 1]; Object.assign(clip, { compiledPrompt: "Static shot. Continue from the observed replacement pose.", promptContextKey: "refreshed-frame-key", promptFromLatent: previous.latentId, promptFromFrame: previous.frame!.path, promptFromJob: previous.jobId, referenceIds: body.referenceIds || clip.referenceIds }); }
      if (body.action === "prepareClip") {
        const clip = project!.clips.find(clip => clip.id === body.clipId)!;
        if (["complete", "failed"].includes(clip.status)) clip.revision = { prompt: body.prompt, referenceIds: body.referenceIds, comments: clip.revision?.comments || "", model: project!.model, createdAt: Date.now() };
        else Object.assign(clip, { prompt: body.prompt, compiledPrompt: body.prompt, referenceIds: body.referenceIds, revision: undefined, status: "pending" });
      }
      if (body.action === "setDuration") {
        const clip = project!.clips.find(clip => clip.id === body.clipId)!;
        if (project!.active || clip.jobId || clip.requestId || clip.source || !["pending", "awaiting-approval"].includes(clip.status)) clip.nextDuration = body.duration;
        else clip.duration = body.duration;
        clip.promptContextKey = undefined; clip.approvedPromptKey = undefined;
      }
      if (body.clip) Object.assign(project!.clips.find(clip => clip.id === body.clip.id)!, body.clip);
      if (body.reviewAfterEachClip !== undefined) project!.reviewAfterEachClip = body.reviewAfterEachClip;
      if (body.reasoningEffort !== undefined) project!.reasoningEffort = body.reasoningEffort;
      if (body.settings) project!.settings = body.settings;
      if (body.action === "editRevision") Object.assign(project!.clips.find(clip => clip.id === body.clipId)!.revision!, { prompt: body.prompt, referenceIds: body.referenceIds });
      if (body.action === "revise") project!.clips.find(clip => clip.id === body.clipId)!.revision = { referenceIds: body.referenceIds, prompt: "A slow low-angle tracking shot follows the traveler.", comments: body.comments, model: body.model, createdAt: Date.now() };
      if (body.action === "optimize") project!.clips = [{ ...project!.clips[0], duration: 10, prompt: project!.clips.map(clip => clip.prompt).join(" Then "), transition: "first", continuityReason: "Start of the scene.", autoContinuation: false, continuityMode: "auto", continuation: false }];
      if (body.action === "recover") { project!.clips[0].status = "recoverable"; project!.clips[0].jobId = body.jobId; }
      return route.fulfill({ json: { project } });
    }
    if (project?.active && (runningClip || !initial?.active) && ++polls >= 2) {
      project.active = false;
      const pending = project.clips.filter(clip => clip.status !== "complete" && (!runningClip || clip.id === runningClip));
      const targets = project.reviewAfterEachClip !== false && !runningClip ? pending.slice(0, 1) : pending;
      targets.forEach(clip => { const index = project!.clips.indexOf(clip); Object.assign(clip, { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", jobId: `job-${index}`, video: { path: `clips/${clip.id}${clip.versions?.length ? "-take2" : ""}.mp4`, bytes: video.length, name: `${clip.id}.mp4`, mime: "video/mp4" }, frame: { path: `frames/${clip.id}.jpg`, bytes: png.length, name: "last-frame.jpg", mime: "image/jpeg" }, media: { width: 320, height: 180, duration: clip.duration, fps: 24 }, ...(index ? { firstFrameFrom: "arrival" } : {}) }); });
      if (project.sequentialPrompts !== false) { for (const clip of targets) { const next = project.clips[project.clips.indexOf(clip) + 1]; if (next && next.status === "pending") Object.assign(next, { compiledPrompt: "Static shot. Continue from the observed last frame at the door.", promptContextKey: "planned-frame-key", promptFromLatent: clip.latentId, promptFromFrame: clip.frame!.path, promptFromJob: clip.jobId }); } }
      project.status = project.clips.every(clip => clip.status === "complete") ? "complete" : "paused";
    }
    return route.fulfill({ json: { project } });
  });
  await page.goto("/"); return requests;
}

for (const provider of ["runpod", "apimart"] as const) {
  test(`maximum clip duration is validated before ${provider} planning and saved with the scene`, async ({ page }, info) => {
    const value = planned(); value.clips = []; value.referencesIdentified = true; value.settings.provider = provider;
    value.references[0].asset = { path: "references/traveler.png", name: "traveler.png", bytes: png.length, mime: "image/png" };
    await page.route("**/api/apimart/settings", route => route.fulfill({ json: { configured: true, environmentKey: true } }));
    const requests = await setup(page, value);
    const maximum = page.getByLabel("Maximum clip duration", { exact: true });
    const limit = provider === "apimart" ? 30 : 10;
    await expect(maximum).toBeEditable();
    await expect(maximum).toHaveValue(String(limit));
    await expect(maximum).toHaveAttribute("max", String(limit));
    await maximum.fill(String(limit + 1));
    await page.getByRole("button", { name: "Understand references & plan clips", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Use a maximum from" }).first()).toBeVisible();
    expect(requests.filter(item => item.body.action === "plan")).toHaveLength(0);
    const selected = provider === "apimart" ? 12 : 6;
    await maximum.fill(String(selected));
    await page.locator(".agent-generation").screenshot({ path: `test-results/${info.project.name}-${provider}-planning-maximum.png` });
    await page.getByRole("button", { name: "Understand references & plan clips", exact: true }).click();
    await expect(page.getByLabel("Prompt for clip 1", { exact: true })).toBeVisible();
    expect(requests.find(item => item.body.action === "plan")?.body.maxClipDuration).toBe(selected);
    expect(requests.filter(item => item.path === "run")).toHaveLength(0);
    await page.reload();
    await expect(maximum).toHaveValue(String(selected));
    await expect(maximum).toBeDisabled();
    await expect(page.getByLabel("Clip 1 duration", { exact: true })).toBeEditable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("clip duration stays editable after generation and persists on reload", async ({ page }, info) => {
  const value = planned();
  Object.assign(value.clips[0], { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", jobId: "saved-job", video: { path: "clips/arrival.mp4", name: "arrival.mp4", bytes: video.length, mime: "video/mp4" }, media: { width: 320, height: 180, fps: 24, duration: 5 } });
  const requests = await setup(page, value);
  await expect(page.getByLabel("Clip 1 duration", { exact: true })).toHaveAttribute("max", "10");
  await page.getByLabel("Clip 1 duration", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Save duration for clip 1", exact: true }).click();
  await expect(page.getByLabel("Clip 1 duration", { exact: true })).toHaveValue("10");
  await expect(page.getByRole("link", { name: "Download clip 1", exact: true })).toBeVisible();
  await expect(page.getByText("10s saved for the next take.", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Clip 1 duration", { exact: true })).toHaveValue("10");
  expect(requests.filter(item => item.path === "run")).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(".agent-clip").first().screenshot({ path: `test-results/${info.project.name}-editable-duration.png` });
});

test("duration can be saved during an active job without pausing generation", async ({ page }) => {
  const value = planned(); value.active = true; value.status = "running";
  Object.assign(value.clips[0], { status: "rendering", jobId: "active-job", requestId: "active-request" });
  const requests = await setup(page, value);
  await expect(page.getByLabel("Clip 1 duration", { exact: true })).toBeEditable();
  await page.getByLabel("Clip 1 duration", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Save duration for clip 1", exact: true }).click();
  await expect(page.getByLabel("Clip 1 duration", { exact: true })).toHaveValue("8");
  await expect(page.getByRole("button", { name: "Pause generation", exact: true })).toBeVisible();
  expect(requests.filter(item => item.body.action === "setDuration").at(-1)?.body.duration).toBe(8);
  expect(requests.filter(item => item.path === "run")).toHaveLength(0);
});

test("reference-first planning, editable prompts and individual generation preserve local playback", async ({ page }, info) => {
  const requests = await setup(page);
  await page.getByLabel("Your scene", { exact: true }).fill("A traveler arrives at a station, then boards a train.");
  await page.getByRole("button", { name: "Identify references", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene references" })).toBeVisible();
  await expect(page.getByLabel("Prompt for clip 1", { exact: true })).toHaveCount(0);
  expect(requests.filter(item => item.path === "run")).toHaveLength(0);
  await page.getByLabel("Upload reference for Traveler").setInputFiles({ name: "traveler.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("Traveler reference")).toBeVisible();
  await page.getByRole("button", { name: "Understand references & plan clips", exact: true }).click();
  await expect(page.getByLabel("Prompt for clip 1", { exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: "Generate clip 2", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Prompt for clip 2", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Prompt for clip 2", { exact: true })).toBeDisabled();
  await page.getByLabel("Clip 1 duration", { exact: true }).fill("4");
  await page.getByLabel("Prompt for clip 1", { exact: true }).fill("Static shot. The traveler approaches holding a letter.");
  await page.getByLabel("Comments for clip 1", { exact: true }).fill("Have her pause at the door.");
  await page.locator(".agent-clip").first().getByRole("button", { name: "Apply comments", exact: true }).click();
  expect(requests.find(item => item.body.action === "revise")?.body.prompt).toContain("holding a letter");
  await page.getByLabel("Prompt for clip 1", { exact: true }).fill("Static shot. The traveler pauses by the station door.");
  await page.locator(".agent-clip-grid").first().screenshot({ path: `test-results/${info.project.name}-unified-clip-editor.png` });
  await page.getByRole("button", { name: "Generate clip 1", exact: true }).click();
  expect(requests.filter(item => item.body.action === "prepareClip").at(-1)?.body.prompt).toBe("Static shot. The traveler pauses by the station door.");
  await expect(page.getByRole("link", { name: "Download clip 1", exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Prompt for clip 2", { exact: true })).toBeEditable();
  await page.getByRole("button", { name: "Generate clip 2", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toBeVisible({ timeout: 10000 });
  expect(requests.filter(item => item.path === "run").map(item => item.body.clipId)).toEqual(["arrival", "boarding"]);
  await expect(page.getByText("Last frame saved", { exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toBeVisible();
});

test("Wan provider choice persists and exposes its connection and resolution", async ({ page }) => {
  const value = planned();
  await setup(page, value);
  let configured = false;
  await page.route("**/api/apimart/settings", route => {
    if (route.request().method() === "POST") { expect(route.request().postDataJSON()).toEqual({ apiKey: "wan-test-key" }); configured = true; }
    return route.fulfill({ json: { configured, environmentKey: false } });
  });
  await page.getByLabel("Video generation model", { exact: true }).selectOption("apimart");
  await expect(page.getByLabel("Wan resolution", { exact: true })).toHaveValue("720P");
  await expect(page.getByLabel("Wan duration mode", { exact: true })).toHaveValue("auto");
  await expect(page.getByLabel("Clip 1 duration", { exact: true })).toHaveAttribute("max", "30");
  await page.getByLabel("Clip 1 duration", { exact: true }).fill("25");
  await page.getByLabel("Wan duration mode", { exact: true }).selectOption("fixed");
  await expect(page.getByLabel("Wan duration mode", { exact: true })).toHaveValue("fixed");
  await expect(page.getByLabel("Sampling steps", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "API Mart connection", exact: true }).click();
  await page.getByLabel("API Mart API key", { exact: true }).fill("wan-test-key");
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Wan resolution", { exact: true }).selectOption("480P");
  await expect(page.getByLabel("Wan resolution", { exact: true })).toHaveValue("480P");
  await expect(page.getByLabel("Wan duration mode", { exact: true })).toHaveValue("fixed");
  await page.reload();
  await expect(page.getByLabel("Video generation model", { exact: true })).toHaveValue("apimart");
  await expect(page.getByLabel("Wan resolution", { exact: true })).toHaveValue("480P");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("replacing the previous frame requires a refreshed editable prompt before the next generation", async ({ page }, info) => {
  const value = planned(); value.sequentialPrompts = true;
  Object.assign(value.clips[0], { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", jobId: "first-take", video: { path: "clips/arrival.mp4", name: "arrival.mp4", bytes: video.length, mime: "video/mp4" }, frame: { path: "frames/arrival.png", name: "arrival.png", bytes: png.length, mime: "image/png" } });
  Object.assign(value.clips[1], { outline: value.clips[1].prompt, compiledPrompt: "Static shot. Continue from the original pose.", promptContextKey: "original-key", promptFromLatent: value.clips[0].latentId, promptFromFrame: value.clips[0].frame!.path, promptFromJob: "first-take" });
  const requests = await setup(page, value);
  await expect(page.getByLabel("Prompt for clip 2", { exact: true })).toBeEditable();
  await page.getByLabel("Replace last frame for clip 1").setInputFiles({ name: "new-pose.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Generate clip 2", exact: true })).toBeDisabled();
  expect(requests.filter(item => item.path === "run")).toHaveLength(0);
  await page.getByRole("button", { name: "Plan prompt from last frame", exact: true }).click();
  await expect(page.getByLabel("Prompt for clip 2", { exact: true })).toHaveValue("Static shot. Continue from the observed replacement pose.");
  await page.getByLabel("Prompt for clip 2", { exact: true }).fill("Static shot. She steps aboard from the new pose.");
  await page.locator(".agent-clip").nth(1).screenshot({ path: `test-results/${info.project.name}-frame-aware-prompt.png` });
  await page.getByRole("button", { name: "Generate clip 2", exact: true }).click();
  expect(requests.find(item => item.body.action === "prepareClip")?.body.prompt).toBe("Static shot. She steps aboard from the new pose.");
  expect(requests.find(item => item.path === "run")?.body).toMatchObject({ action: "start", clipId: "boarding" });
});

test("a failed sequential clip can retry with new sampling steps and its existing prompt", async ({ page }) => {
  const value = planned(); value.sequentialPrompts = true; value.status = "paused";
  Object.assign(value.clips[0], { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", jobId: "previous-take", video: { path: "clips/arrival.mp4", name: "arrival.mp4", bytes: video.length, mime: "video/mp4" }, frame: { path: "frames/arrival.png", name: "arrival.png", bytes: png.length, mime: "image/png" } });
  const prompt = "Static shot. She boards from the position in the previous last frame.";
  Object.assign(value.clips[1], { status: "failed", jobId: "failed-runpod-job", requestId: crypto.randomUUID(), compiledPrompt: prompt, promptContextKey: "v2:saved-frame-key", promptFromLatent: value.clips[0].latentId, promptFromFrame: value.clips[0].frame!.path, promptFromJob: "previous-take", error: "RunPod job failed." });
  const requests = await setup(page, value);
  await page.getByLabel("Sampling steps", { exact: true }).fill("18");
  await page.getByLabel("Sampling steps", { exact: true }).press("Tab");
  await expect(page.getByLabel("Prompt for clip 2", { exact: true })).toHaveValue(prompt);
  await page.getByRole("button", { name: "Regenerate clip 2", exact: true }).click();
  expect(requests.find(item => item.body.settings)?.body.settings.steps).toBe(18);
  expect(requests.find(item => item.body.action === "prepareClip")?.body.prompt).toBe(prompt);
  expect(requests.find(item => item.path === "run")?.body).toMatchObject({ action: "rerender", clipId: "boarding" });
  expect(requests.filter(item => ["planNextPrompt", "revise"].includes(item.body.action))).toHaveLength(0);
  await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toBeVisible({ timeout: 10000 });
});

test("interrupted clips offer resume and comment-free retry after a missing RunPod result", async ({ page }) => {
  const value = planned();
  value.status = "paused";
  Object.assign(value.clips[0], { status: "recoverable", requestId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", jobId: "expired-job", error: "RunPod could not find this endpoint or job. Completed results may have expired." });
  const requests = await setup(page, value);
  const retry = page.getByRole("button", { name: "Retry clip 1", exact: true });
  await expect(retry).toBeEnabled();
  await page.getByRole("button", { name: "Resume clip 1", exact: true }).click();
  expect(requests.find(item => item.path === "run")?.body).toMatchObject({ action: "start", clipId: "arrival" });
  await page.getByRole("button", { name: "Pause generation", exact: true }).click();
  await retry.click();
  expect(requests.filter(item => item.path === "run").at(-1)?.body).toMatchObject({ action: "retry", clipId: "arrival" });
});

test("uncertain submission requires job recovery or explicit console review", async ({ page }) => {
  const project = planned(); project.status = "paused"; project.clips[0].status = "submission-unknown"; project.clips[0].requestId = crypto.randomUUID();
  const requests = await setup(page, project);
  await expect(page.getByRole("button", { name: "Generate clip 1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resolve and allow a new submission" })).toBeDisabled();
  await page.getByLabel("Recovered job ID for clip 1").fill("existing-job");
  await page.getByRole("button", { name: "Recover existing job" }).click();
  await expect(page.getByRole("button", { name: "Resume clip 1", exact: true })).toBeEnabled();
  expect(requests[0].body).toMatchObject({ action: "recover", jobId: "existing-job" });
  expect(requests.filter(request => request.path === "run")).toHaveLength(0);
});

test("continuity controls and edited prompt save together without generating", async ({ page }) => {
  const value = planned();
  Object.assign(value.clips[1], { transition: "continue", continuityReason: "Continuous action.", autoContinuation: true, continuityMode: "auto" });
  const requests = await setup(page, value);
  await page.getByLabel("Motion continuity for clip 2").selectOption("off");
  await page.getByLabel("Prompt for clip 2", { exact: true }).fill("Static shot. A new view of the station.");
  await page.locator(".agent-clip").nth(1).getByRole("button", { name: "Save prompt", exact: true }).click();
  expect(requests.find(item => item.body.clip)?.body.clip.continuityMode).toBe("off");
  expect(requests.find(item => item.body.action === "prepareClip")?.body.prompt).toBe("Static shot. A new view of the station.");
  expect(requests.filter(item => item.path === "run")).toHaveLength(0);
});

test("oversized references show actionable validation before any generation request", async ({ page }, info) => {
  const value = planned();
  value.references.forEach(slot => { slot.asset = { path: `references/${slot.id}.png`, name: `${slot.id}.png`, bytes: 3_100_000, mime: "image/png" }; });
  const requests = await setup(page, value);
  const validation = page.locator("#agent-reference-validation");
  await expect(validation).toContainText("Reduce reference uploads before generating");
  await expect(validation).toContainText("Clip 1 (Arrival): 6.20 MB");
  await expect(validation).toContainText("Reduce by at least 0.20 MB");
  await expect(page.getByRole("button", { name: "Generate clip 1", exact: true })).toBeDisabled();
  expect(requests.filter(request => request.path === "run")).toHaveLength(0);
  await validation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${info.project.name}-reference-validation.png`, fullPage: true });
  const clips = page.locator(".agent-clip");
  await clips.nth(0).getByText("References for clip 1", { exact: true }).click();
  await clips.nth(0).getByRole("checkbox", { name: /Station/ }).uncheck();
  await expect(validation).not.toContainText("Clip 1 (Arrival)");
  await expect(validation).toContainText("Clip 2 (Boarding)");
  await expect(page.getByRole("button", { name: "Generate clip 1", exact: true })).toBeEnabled();
  await clips.nth(1).getByText("References for clip 2", { exact: true }).click();
  await clips.nth(1).getByRole("checkbox", { name: /Station/ }).uncheck();
  await expect(validation).toHaveCount(0);
  await expect(clips.nth(0).locator(".agent-reference-budget")).toContainText("3.10 MB / 6 MB");
  expect(requests.filter(request => request.path === "run")).toHaveLength(0);
  await page.getByRole("button", { name: "Generate clip 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause generation", exact: true })).toBeVisible();
  expect(requests.filter(request => request.body.action === "prepareClip")).toHaveLength(1);
  expect(requests.filter(request => request.path === "run")).toHaveLength(1);
});

test("H3 motion continuity excludes the previous frame from uploads", async ({ page }) => {
  const value = planned();
  value.references.forEach(slot => { slot.asset = { path: `references/${slot.id}.png`, name: `${slot.id}.png`, bytes: 2_500_000, mime: "image/png" }; });
  Object.assign(value.clips[0], { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", frame: { path: "frames/arrival.jpg", name: "arrival.jpg", mime: "image/jpeg", bytes: 1_200_000 } });
  const requests = await setup(page, value);
  await expect(page.locator("#agent-reference-validation")).toHaveCount(0);
  await expect(page.locator("#reference-budget-boarding")).toContainText("5.00 MB / 6 MB");
  await expect(page.getByRole("button", { name: "Generate clip 2", exact: true })).toBeEnabled();
  expect(requests.filter(request => request.path === "run")).toHaveLength(0);
});

test("replaces a completed last frame and retries only the selected clip from reviewed feedback", async ({ page }, info) => {
  const value = planned(); value.status = "complete";
  value.clips.forEach((clip, index) => Object.assign(clip, { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", jobId: `old-${index}`, video: { path: `clips/${clip.id}.mp4`, name: `${clip.id}.mp4`, bytes: video.length, mime: "video/mp4" }, frame: { path: `frames/${clip.id}.jpg`, name: "frame.jpg", bytes: png.length, mime: "image/jpeg" } }));
  const requests = await setup(page, value);
  await page.getByLabel("Thinking mode", { exact: true }).selectOption("high");
  await page.getByLabel("Replace last frame for clip 1").setInputFiles({ name: "custom-frame.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("Last frame replaced", { exact: true })).toBeVisible();
  await expect(page.getByText("Regenerate this clip to update continuity.", { exact: false })).toBeVisible();
  await expect(page.getByAltText("Last frame of clip 1")).toHaveAttribute("src", /replacement/);
  await page.getByRole("button", { name: "Restore extracted frame" }).click();
  await expect(page.getByText("Last frame replaced", { exact: true })).toHaveCount(0);
  await page.getByText("References for clip 1", { exact: true }).click();
  await page.getByLabel("Comments for clip 1", { exact: true }).fill("Make the camera lower and slow down the movement.");
  await page.locator(".agent-clip").first().getByRole("button", { name: "Apply comments", exact: true }).click();
  await expect(page.getByLabel("Prompt for clip 1", { exact: true })).toHaveValue("A slow low-angle tracking shot follows the traveler.");
  expect(requests.filter(request => request.path === "run")).toHaveLength(0);
  expect(requests.find(request => request.body.action === "revise")?.body.comments).toContain("camera lower");
  await page.getByLabel("Comments for clip 1", { exact: true }).fill("Keep the lower camera, and make the lighting warmer.");
  await expect(page.getByText("Comments affect it only after Apply comments.", { exact: false }).first()).toBeVisible();
  await page.locator(".agent-clip").first().getByRole("button", { name: "Apply comments", exact: true }).click();
  await expect(page.getByRole("button", { name: "Regenerate clip 1", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Regenerate clip 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause generation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate clip 1", exact: true })).toBeEnabled({ timeout: 10000 });
  const run = requests.find(request => request.path === "run"); expect(run?.body).toMatchObject({ action: "rerender", clipId: "arrival", reasoningEffort: "high" });
  expect(requests.filter(request => request.path === "run")).toHaveLength(1);
  await page.getByText("Previous generations (1)", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Download previous video 1", exact: true })).toHaveAttribute("href", /version=0/);
  await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toBeVisible();
  await page.locator(".agent-clip-grid").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${info.project.name}-clip-review.png`, fullPage: true });
});

test("comment retry selects references and saves edited revised text before generation", async ({ page }, info) => {
  const value = planned();
  value.clips[0].status = "complete";
  value.clips[0].video = { path: "clips/arrival.mp4", name: "arrival.mp4", bytes: video.length, mime: "video/mp4" };
  value.references.forEach(slot => { slot.asset = { path: `references/${slot.id}.png`, name: `${slot.id}.png`, bytes: png.length, mime: "image/png" }; });
  const requests = await setup(page, value);
  await page.getByText("References for clip 1", { exact: true }).click();
  await page.getByLabel("Include Traveler in clip 1", { exact: true }).uncheck();
  await page.getByLabel("Comments for clip 1", { exact: true }).fill("Keep only the station reference and static framing.");
  await page.locator(".agent-clip").first().getByRole("button", { name: "Apply comments", exact: true }).click();
  expect(requests.find(item => item.body.action === "revise")?.body.referenceIds).toEqual(["station"]);
  const revised = page.getByLabel("Prompt for clip 1", { exact: true });
  await revised.fill("Static shot. The traveler waits at the station window.");
  await page.locator(".agent-clip").first().getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(revised).toHaveValue("Static shot. The traveler waits at the station window.");
  await revised.fill("Static shot. The traveler waves beside the station window.");
  await page.locator(".agent-clip-grid").first().screenshot({ path: `test-results/${info.project.name}-retry-editor.png` });
  await page.getByRole("button", { name: "Regenerate clip 1", exact: true }).click();
  expect(requests.filter(item => item.body.action === "prepareClip").at(-1)?.body).toMatchObject({ prompt: "Static shot. The traveler waves beside the station window.", referenceIds: ["station"] });
  expect(requests.filter(item => item.path === "run")).toHaveLength(1);
  expect(value.clips[0].referenceIds).toEqual(["station"]);
});

test("prepared clip prompts use the same editable prompt and explicit Generate button", async ({ page }) => {
  const value = planned(); value.reviewBeforeEachClip = true; value.status = "paused";
  value.clips[0].status = "awaiting-approval"; value.clips[0].compiledPrompt = "Prepared static shot.";
  const requests = await setup(page, value);
  await page.getByLabel("Prompt for clip 1", { exact: true }).fill("Static shot. The traveler waves.");
  expect(requests.filter(item => item.path === "run")).toHaveLength(0);
  await page.getByRole("button", { name: "Generate clip 1", exact: true }).click();
  expect(requests.find(item => item.body.action === "prepareClip")?.body.prompt).toBe("Static shot. The traveler waves.");
  expect(requests.find(item => item.path === "run")?.body).toMatchObject({ action: "start", clipId: "arrival" });
});

test("each generated clip waits for the next explicit Generate click", async ({ page }) => {
  const requests = await setup(page, planned());
  await page.getByRole("button", { name: "Generate clip 1", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download clip 1", exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Replace last frame for clip 1")).toBeEnabled();
  await page.getByRole("button", { name: "Generate clip 2", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download clip 2", exact: true })).toBeVisible({ timeout: 10000 });
  expect(requests.filter(item => item.path === "run")).toHaveLength(2);
});

test("browser tab ticker follows background generation, next-prompt planning, review and failure", async ({ page, context }, info) => {
  const value = planned(); value.sequentialPrompts = true; value.active = true; value.status = "running"; value.runClipId = "arrival";
  value.clips[0].status = "queued";
  await setup(page, value);
  await page.route(url => url.pathname === "/api/agent/project" && url.searchParams.has("projectId"), route => route.fulfill({ json: { project: value } }));
  await expect(page).toHaveTitle(/Queued clip 1\/2 · 0 saved/);
  const firstTitle = await page.title();
  await expect.poll(() => page.title()).not.toBe(firstTitle);
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const otherTab = await context.newPage(); await otherTab.goto("about:blank"); await otherTab.bringToFront();
  value.clips[0].status = "rendering";
  await expect(page).toHaveTitle(/Rendering clip 1\/2 · 0 saved/);
  value.clips[0].status = "saving";
  await expect(page).toHaveTitle(/Saving clip 1\/2/);
  value.clips[0].status = "complete";
  await expect(page).toHaveTitle(/Planning clip 2\/2 · 1 saved/);
  value.active = false; value.status = "paused"; value.runClipId = undefined;
  await expect(page).toHaveTitle(/Review clip 2\/2 · 1 saved/);
  value.clips[1].status = "failed";
  await page.bringToFront();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "AI Video Agent", exact: true }).click();
  // Reload also restores attention states from the durable scene.
  await page.reload();
  await expect(page).toHaveTitle(/⚠ Failed clip 2\/2 · 1 saved/);
  value.clips[1].status = "complete"; value.status = "complete";
  await page.reload();
  await expect(page).toHaveTitle(/✓ Done · 2\/2 clips saved/);
  await page.getByRole("button", { name: "New scene", exact: true }).click();
  await expect(page).toHaveTitle("AI Video Agent · Prompt Studio");
  await otherTab.close();
});

test("actual local agent routes reject invalid planning and cross-origin mutations", async ({ request }) => {
  const analysis = await request.post("/api/agent/analyze", { headers: { Origin: "http://127.0.0.1:3000" }, data: { model: "test", script: "" } }); expect(analysis.status()).toBe(400);
  const start = await request.post("/api/agent/run", { headers: { Origin: "http://127.0.0.1:3000" }, data: { projectId: planned().id, action: "start" } }); expect(start.status()).toBe(400);
  const crossSite = await request.post("/api/agent/reference", { headers: { Origin: "https://attacker.example" }, data: {} }); expect(crossSite.status()).toBe(400); expect((await crossSite.json()).code).toBe("invalid_request_origin");
  const invalidPath = await request.get("/api/agent/media?projectId=../outside&kind=video&id=arrival"); expect(invalidPath.status()).toBe(400);
});


test("retry generation needs no comments and preserves the previous take", async ({ page }) => {
  const value = planned(); value.status = "complete";
  value.clips.forEach(clip => Object.assign(clip, { status: "complete", latentId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", video: { path: `clips/${clip.id}.mp4`, bytes: video.length, name: "clip.mp4", mime: "video/mp4" }, frame: { path: `frames/${clip.id}.png`, bytes: png.length, name: "frame.png", mime: "image/png" } }));
  const requests = await setup(page, value);
  await page.getByRole("button", { name: "Regenerate clip 2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Regenerate clip 2", exact: true })).toBeEnabled({ timeout: 10000 });
  expect(requests.filter(item => item.path === "run")).toHaveLength(1);
  expect(requests.find(item => item.path === "run")?.body).toMatchObject({ action: "rerender", clipId: "boarding" });
  expect(requests.filter(item => item.body.action === "revise")).toHaveLength(0);
  await expect(page.getByText("Previous generations (1)", { exact: true })).toBeVisible();
});

test("thinking mode reaches analysis and optimization, reloads from the project, and adapts to model support", async ({ page }, info) => {
  const requests = await setup(page);
  await expect(page.getByLabel("Thinking mode", { exact: true })).toHaveValue("low");
  await page.getByLabel("Thinking mode", { exact: true }).selectOption("high");
  await page.getByLabel("Your scene", { exact: true }).fill("A traveler arrives, then boards a train.");
  await page.getByRole("button", { name: "Identify references", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Station arrival" })).toBeVisible();
  expect(requests.find(item => item.path === "analyze")?.body.reasoningEffort).toBe("high");
  await page.reload();
  await expect(page.getByLabel("Thinking mode", { exact: true })).toHaveValue("high");
  await page.getByLabel("Thinking mode", { exact: true }).selectOption("medium");
  await page.getByRole("button", { name: "Understand references & plan clips", exact: true }).click();
  await expect(page.getByLabel("Prompt for clip 1", { exact: true })).toBeVisible();
  expect(requests.find(item => item.body.action === "plan")?.body.reasoningEffort).toBe("medium");
  await page.route("**/api/agent/codex", route => route.fulfill({ json: { connected: true, imageGeneration: true, skills: [], models: [{ slug: "codex:test-model", displayName: "Test · Codex", reasoningEfforts: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }, { effort: "high", description: "Thorough" }] }, { slug: "codex:quick-model", displayName: "Quick · Codex", reasoningEfforts: [{ effort: "low", description: "Fast" }] }] } }));
  await page.reload();
  await page.getByLabel("Scene planning model", { exact: true }).selectOption("codex:quick-model");
  await expect(page.getByLabel("Thinking mode", { exact: true })).toHaveValue("low");
  await expect(page.getByLabel("Thinking mode", { exact: true }).locator("option")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/" + info.project.name + "-thinking-mode.png", fullPage: true });
});


test("characters, voice references and sampling steps are available without frame enhancement", async ({ page }, info) => {
  const value = planned();
  await setup(page, value);
  const characterId = "f01aaeed-aaaa-4aaa-8aaa-111111111111";
  let characters: any[] = [];
  await page.route("**/api/characters*", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      characters = [{ id: characterId, name: body.name, description: body.description, images: [{path:"face.png",name:"face.png",bytes:png.length,mime:"image/png"}], voices: [{path:"voice.wav",name:"voice.wav",bytes:80,mime:"audio/wav"}], updatedAt:Date.now() }];
      return route.fulfill({ json: { character:characters[0] } });
    }
    return route.fulfill({ json:{characters} });
  });
  await page.route(url => url.pathname === "/api/characters" && url.searchParams.has("id"), route => route.fulfill({body:png, contentType:"image/png"}));
  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await page.getByRole("button", {name:"Library",exact:true}).click();
  await page.getByLabel("Character name",{exact:true}).fill("Mira");
  await page.getByLabel("Character images",{exact:true}).setInputFiles({name:"face.png",mimeType:"image/png",buffer:png});
  await page.getByLabel("Character voice samples",{exact:true}).setInputFiles({name:"voice.wav",mimeType:"audio/wav",buffer:Buffer.alloc(80)});
  await page.getByRole("button", {name:"Save character",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Mira",exact:true})).toBeVisible();
  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await page.getByRole("button", {name:"AI Video Agent",exact:true}).click();
  await page.route("**/api/agent/reference", route => {
    const body=route.request().postDataJSON(); const slot=value.references[0];
    expect(body.characterId).toBe(characterId);
    Object.assign(slot, { name:"Mira", characterId, asset:characters[0].images[0], images:characters[0].images, audios:characters[0].voices });
    return route.fulfill({json:{project:value}});
  });
  await page.getByLabel("Choose character for Traveler",{exact:true}).selectOption(characterId);
  await expect(page.getByAltText("Mira reference",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Mira voice 1",{exact:true})).toBeVisible();
  await expect(page.getByText("<Picture 1> → Mira · <Audio 1> → Mira",{exact:true})).toHaveCount(2);
  await page.getByLabel("Sampling steps",{exact:true}).fill("18");
  await page.getByLabel("Sampling steps",{exact:true}).press("Tab");
  await expect.poll(() => value.settings.steps).toBe(18);
  await expect(page.getByLabel("Sampling steps",{exact:true})).toHaveValue("18");
  expect(value.settings.steps).toBe(18);
  await expect(page.getByRole("button",{name:"Clean & upscale frame"})).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test("library saves locations and props and offers them in scene references", async ({ page }, info) => {
  const value = planned(); await setup(page, value);
  const items: any[] = [];
  await page.route("**/api/characters*", route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      const item = { ...body, id:body.kind === "location" ? "f01aaeed-aaaa-4aaa-8aaa-222222222222" : "f01aaeed-aaaa-4aaa-8aaa-333333333333", images:[{path:"image.png",name:"image.png",bytes:png.length,mime:"image/png"}],voices:[],updatedAt:Date.now() };
      items.push(item); return route.fulfill({json:{character:item}});
    }
    return route.fulfill({json:{characters:items}});
  });
  await page.route(url => url.pathname === "/api/characters" && url.searchParams.has("id"), route => route.fulfill({body:png,contentType:"image/png"}));
  if(info.project.name === "mobile") await page.getByRole("button",{name:"Open navigation"}).click();
  await page.getByRole("button",{name:"Library",exact:true}).click();
  await page.getByRole("tab",{name:"Locations",exact:true}).click();
  await expect(page.getByLabel("Character voice samples")).toBeHidden();
  await page.getByLabel("Location name",{exact:true}).fill("Dusk station");
  await page.getByLabel("Location images",{exact:true}).setInputFiles({name:"station.png",mimeType:"image/png",buffer:png});
  await page.getByRole("button",{name:"Save location",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Dusk station",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Props",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Dusk station",exact:true})).toBeHidden();
  await page.getByLabel("Prop name",{exact:true}).fill("Letter");
  await page.getByLabel("Prop images",{exact:true}).setInputFiles({name:"letter.png",mimeType:"image/png",buffer:png});
  await page.getByRole("button",{name:"Save prop",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Letter",exact:true})).toBeVisible();
  await page.getByRole("tab",{name:"Locations",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Dusk station",exact:true})).toBeVisible();
  if(info.project.name === "mobile") await page.getByRole("button",{name:"Open navigation"}).click();
  await page.getByRole("button",{name:"AI Video Agent",exact:true}).click();
  await page.route("**/api/agent/reference", route => {
    const body=route.request().postDataJSON(); const item=items.find(item=>item.id===body.characterId);
    let slot=value.references.find(slot=>slot.id===body.slotId);
    if (!slot) { slot={ id:"letter",kind:item.kind,name:item.name,description:item.name }; value.references.push(slot); value.clips.forEach(clip=>clip.referenceIds.push(slot!.id)); }
    Object.assign(slot,{kind:item.kind,name:item.name,images:item.images,asset:item.images[0],audios:[],characterId:item.id});
    return route.fulfill({json:{project:value}});
  });
  await expect(page.getByLabel("Choose location for Station",{exact:true}).locator("option")).toHaveCount(2);
  await page.getByLabel("Choose location for Station",{exact:true}).selectOption(items[0].id);
  await expect(page.getByAltText("Dusk station reference",{exact:true})).toBeVisible();
  await page.getByLabel("Add library reference to scene",{exact:true}).selectOption(items[1].id);
  await expect(page.getByAltText("Letter reference",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Choose prop for Letter",{exact:true})).toHaveValue(items[1].id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("switching a scene location reloads its image immediately", async ({ page }) => {
  const value = planned();
  await setup(page, value);
  const locations = ["Dusk station", "Sunny platform"].map((name, index) => ({
    id: `f01aaeed-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
    collectionId: testProjectId, kind: "location", name, description: name,
    images: [{ path: `references/location-${index}.png`, name: `${name}.png`, bytes: png.length, mime: "image/png" }],
    voices: [], updatedAt: index + 1,
  }));
  await page.route("**/api/characters*", route => route.fulfill({ json: { characters: locations } }));
  const loadedPaths: string[] = [];
  await page.route("**/api/agent/media?*", route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("kind") === "reference" && params.get("id") === "station") loadedPaths.push(params.get("v") || "");
    return route.fulfill({ body: png, contentType: "image/png" });
  });
  await page.route("**/api/agent/reference", route => {
    const body = route.request().postDataJSON();
    const location = locations.find(item => item.id === body.characterId)!;
    Object.assign(value.references.find(slot => slot.id === body.slotId)!, {
      name: location.name, description: location.description, characterId: location.id,
      images: location.images, asset: location.images[0], audios: [],
    });
    return route.fulfill({ json: { project: value } });
  });
  await page.reload();
  await page.getByLabel("Choose location for Station", { exact: true }).selectOption(locations[0].id);
  await expect(page.getByAltText("Dusk station reference", { exact: true })).toBeVisible();
  await expect.poll(() => loadedPaths).toContain(locations[0].images[0].path);
  await page.getByLabel("Choose location for Dusk station", { exact: true }).selectOption(locations[1].id);
  const preview = page.getByAltText("Sunny platform reference", { exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("src", /v=references%2Flocation-1\.png$/);
  await expect.poll(() => loadedPaths).toContain(locations[1].images[0].path);
  await expect(page.getByLabel("Choose location for Sunny platform", { exact: true })).toHaveValue(locations[1].id);
});

test("project storage accepts a Drive folder, reports access errors, and reloads with the saved setting", async ({ page }, info) => {
  await setup(page, planned());
  let folder = "D:\\Videos\\AI Video Agent";
  const destination = "G:\\My Drive\\AI Video Agent";
  let fail = true;
  const requests: any[] = [];
  await page.route("**/api/storage", route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); requests.push(body);
      if (fail) return route.fulfill({ status:400, json:{ error:"This folder is unavailable or cannot be written to." } });
      folder = body.folder;
    }
    return route.fulfill({ json:{ folder, previousFolders:[], changing:false } });
  });
  if (info.project.name === "mobile") await page.getByRole("button", { name:"Open navigation" }).click();
  await page.getByRole("button", { name:"Settings", exact:true }).click();
  await expect(page.getByLabel("Project storage folder", { exact:true })).toHaveValue(folder);
  await expect(page.getByRole("checkbox", { name:"Copy existing projects and library to this folder" })).toBeChecked();
  await page.getByLabel("Project storage folder", { exact:true }).fill(destination);
  await page.getByRole("button", { name:"Save storage folder", exact:true }).click();
  await expect(page.locator(".workspace-settings").getByRole("alert")).toContainText("unavailable");
  fail = false;
  await page.getByRole("button", { name:"Save storage folder", exact:true }).click();
  await expect(page.getByRole("heading", { name:"AI video agent.", exact:true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests[1]).toEqual({ folder:destination, copyExisting:true });
  if (info.project.name === "mobile") await page.getByRole("button", { name:"Open navigation" }).click();
  await page.getByRole("button", { name:"Settings", exact:true }).click();
  await expect(page.getByLabel("Project storage folder", { exact:true })).toHaveValue(destination);
  await page.getByRole("checkbox", { name:"Copy existing projects and library to this folder" }).uncheck();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("clearing a selected library asset retains the scene slot and unsaved clip selections", async ({ page }) => {
  const value = planned();
  Object.assign(value.references[0], { characterId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", asset: { path: "references/traveler.png", name: "traveler.png", bytes: png.length, mime: "image/png" }, audios: [{ path: "references/voice.wav", name: "voice.wav", bytes: 80, mime: "audio/wav", publicUrl: "https://media.example/voice.wav" }] });
  const requests = await setup(page, value);
  await page.route("**/api/agent/reference", route => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ action: "clearLibraryAsset", slotId: "traveler" });
    Object.assign(value.references.find(slot => slot.id === body.slotId)!, { characterId: undefined, asset: undefined, images: undefined, audios: [] });
    return route.fulfill({ json: { project: value } });
  });
  await page.getByLabel("Prompt for clip 1").fill("The traveler waits at the station.");
  await page.getByRole("button", { name: "Remove selected library asset for Traveler", exact: true }).click();
  await page.getByRole("button", { name: "Cancel removal", exact: true }).click();
  await expect(page.getByLabel("Choose character for Traveler", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove selected library asset for Traveler", exact: true }).click();
  await page.getByRole("button", { name: "Clear selected library asset", exact: true }).click();
  await expect(page.getByLabel("Choose character for Traveler", { exact: true })).toHaveValue("");
  await expect(page.getByAltText("Traveler reference", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Traveler voice 1", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove selected library asset for Traveler", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Choose location for Station", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Prompt for clip 1")).toHaveValue("The traveler waits at the station.");
  await page.getByRole("button", { name: "Generate clip 1", exact: true }).click();
  expect(requests.find(item => item.body.action === "prepareClip")?.body.referenceIds).toEqual(["traveler", "station"]);
});

test("library assets clone within their categories and the unassigned selector is removed", async ({ page }, info) => {
  await setup(page, planned());
  const items = ["character", "location", "prop"].map((kind, index) => ({ id: `f01aaeed-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`, collectionId: testProjectId, kind, name: `Original ${kind}`, description: "Saved asset", images: [], voices: [], updatedAt: 100 }));
  await page.route("**/api/characters*", route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.action).toBe("clone"); expect(body.collectionId).toBe(testProjectId);
      const original = items.find(item => item.id === body.id)!;
      const clone = { ...original, id: crypto.randomUUID(), name: `${original.name} (copy)`, updatedAt: 200 };
      items.push(clone); return route.fulfill({ json: { character: clone } });
    }
    return route.fulfill({ json: { characters: items } });
  });
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByLabel("Move existing library asset", { exact: true })).toHaveCount(0);
  for (const [kind, tab] of [["character", "Characters"], ["location", "Locations"], ["prop", "Props"]]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.getByRole("button", { name: `Clone Original ${kind}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: `Original ${kind} (copy)`, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: `Original ${kind}`, exact: true })).toBeVisible();
  }
  await page.locator(".character-grid").screenshot({ path: `test-results/${info.project.name}-library-actions.png` });
});

test("removing a library reference can be cancelled and clears the edited item immediately", async ({ page }, info) => {
  await setup(page, planned());
  const item = { id: "f01aaeed-aaaa-4aaa-8aaa-111111111111", collectionId: testProjectId, kind: "character", name: "Mira", description: "Traveler", images: [], voices: [], updatedAt: 100 };
  let removed = false;
  await page.route("**/api/characters*", route => {
    if (route.request().method() === "DELETE") {
      expect(route.request().postDataJSON()).toEqual({ id: item.id, collectionId: testProjectId });
      removed = true; return route.fulfill({ json: { id: item.id } });
    }
    return route.fulfill({ json: { characters: !removed && new URL(route.request().url()).searchParams.get("collectionId") ? [item] : [] } });
  });
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Edit Mira", exact: true }).click();
  await page.getByRole("button", { name: "Remove Mira", exact: true }).click();
  await page.getByRole("button", { name: "Cancel removal", exact: true }).click();
  expect(removed).toBe(false);
  await expect(page.getByRole("heading", { name: "Mira", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Mira", exact: true }).click();
  await page.getByRole("button", { name: "Remove reference", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mira", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Character name", { exact: true })).toHaveValue("");
  await expect(page.getByText("No characters saved yet.", { exact: true })).toBeVisible();
  await page.reload();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mira", exact: true })).toHaveCount(0);
});

test("editing a character immediately updates details and reloads image and voice previews", async ({ page }, info) => {
  await setup(page, planned());
  const characterId = "f01aaeed-aaaa-4aaa-8aaa-111111111111";
  const original = { id: characterId, kind:"character", name:"Mira", description:"Original description", updatedAt:100,
    images:[{path:"face.png",name:"face.png",bytes:png.length,mime:"image/png"}],
    voices:[{path:"voice.wav",name:"voice.wav",bytes:80,mime:"audio/wav"}] };
  const imageVersions: string[] = [];
  let listRequests = 0;
  await page.route("**/api/characters*", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("id")) {
      if (url.searchParams.get("kind") === "image") imageVersions.push(url.searchParams.get("v") || "");
      return route.fulfill({body: url.searchParams.get("kind") === "image" ? png : Buffer.alloc(80), contentType: url.searchParams.get("kind") === "image" ? "image/png" : "audio/wav"});
    }
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.id).toBe(characterId); expect(body.images[0].name).toBe("new-face.png"); expect(body.voices[0].name).toBe("new-voice.wav");
      expect(body.voiceUrls).toEqual(["https://media.example/mira.wav"]);
      return route.fulfill({json:{character:{...original,name:body.name,description:body.description,updatedAt:200,voices:[{...original.voices[0],name:"new-voice.wav",publicUrl:body.voiceUrls[0]}]}}});
    }
    listRequests++;
    // Keep returning the old list: saving should use the authoritative POST record.
    return route.fulfill({json:{characters:url.searchParams.get("collectionId") ? [original] : []}});
  });
  if (info.project.name === "mobile") await page.getByRole("button", {name:"Open navigation"}).click();
  await page.getByRole("button", {name:"Library",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Mira",exact:true})).toBeVisible();
  await expect.poll(()=>imageVersions.includes("100")).toBe(true);
  const beforeSave = listRequests;
  await page.getByRole("button",{name:"Edit Mira",exact:true}).click();
  await page.getByLabel("Character name",{exact:true}).fill("Mira updated");
  await page.getByLabel("Character description",{exact:true}).fill("Updated description");
  await page.getByLabel("Character images",{exact:true}).setInputFiles({name:"new-face.png",mimeType:"image/png",buffer:png});
  await page.getByLabel("Character voice samples",{exact:true}).setInputFiles({name:"new-voice.wav",mimeType:"audio/wav",buffer:Buffer.alloc(80)});
  await page.getByLabel("Character public voice URL 1",{exact:true}).fill("https://media.example/mira.wav");
  await page.getByRole("button",{name:"Save character",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Mira updated",exact:true})).toBeVisible();
  await expect(page.getByText("Updated description",{exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Mira",exact:true})).toHaveCount(0);
  await expect.poll(()=>imageVersions.includes("200")).toBe(true);
  await expect(page.locator(".character-grid audio")).toHaveAttribute("src",/v=200$/);
  await expect(page.getByText("new-voice.wav",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Character name",{exact:true})).toHaveValue("");
  expect(listRequests).toBe(beforeSave);
  await expect(page.getByRole("link",{name:"Public voice link 1",exact:true})).toHaveAttribute("href","https://media.example/mira.wav");
  await page.getByRole("button",{name:"Edit Mira updated",exact:true}).click();
  await expect(page.getByLabel("Character public voice URL 1",{exact:true})).toHaveValue("https://media.example/mira.wav");
});

test("shows queue, generation and total times for clips and archived takes after reload", async ({ page }, info) => {
  const value = planned();
  Object.assign(value.clips[0], { status: "complete", delayTime: 1250, executionTime: 68750 });
  value.clips[0].versions = [{ archivedAt: Date.now(), clip: { ...value.clips[0], delayTime: 0, executionTime: 2500 } }];
  await setup(page, value);
  const first = page.locator(".agent-clip").first();
  await expect(first.getByLabel("Clip timing").first()).toHaveText("Queue: 1.3s · Generation: 1m 8.8s · Total: 1m 10.0s");
  await first.getByText("Previous generations (1)", { exact: true }).click();
  await expect(first.getByLabel("Clip timing").nth(1)).toHaveText("Queue: 0.0s · Generation: 2.5s · Total: 2.5s");
  await expect(page.locator(".agent-clip").nth(1).getByLabel("Clip timing")).toHaveText("Queue: — · Generation: — · Total: —");
  await page.reload();
  await expect(page.locator(".agent-clip").first().getByLabel("Clip timing").first()).toContainText("Queue: 1.3s");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(".agent-clip").first().getByLabel("Clip timing").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${info.project.name}-clip-timing.png` });
});
