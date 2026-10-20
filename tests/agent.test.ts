import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Database } from "../src/lib/store";
const memory = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown> }));
vi.mock("../src/lib/store", () => ({ withDatabase: <T>(action: (db: Database) => T) => { const next = memory.queue.then(() => action(memory.db)); memory.queue = next.catch(() => undefined); return next; } }));
const planning = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../src/lib/codex", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/codex")>(), codexJson: planning.call }));
import { planSchema, defaultGeneration, referenceBindings, finalPrompt, previousFrameDecision, suppliedImages, suppliedAudios, type AgentProject } from "../src/lib/agent-types";
import { wanReferencePromptGuidance, wanPromptGuideVersion } from "../src/lib/wan-prompt-guide";
import { analyzeScript, compilePrompts, optimizeScriptPlan } from "../src/lib/agent-llm";
import { automaticPlan, compactPlan } from "../src/lib/agent-planning";
import { createProject, getProject, updateProject, writeAsset, assetPath, projectFolder, listProjects } from "../src/lib/agent-store";
import { reserveRun, executeProject, inputFor, isProjectActive, publicProject, retryClip, recoverClip } from "../src/lib/agent-runner";
import { discardProcessedSource, downloadOutput, finalizeClip, probeMedia, publicAddress } from "../src/lib/agent-media";
import { GET as mediaRoute } from "../src/app/api/agent/media/route";
import { POST as projectRoute } from "../src/app/api/agent/project/route";
import { POST as frameRoute } from "../src/app/api/agent/frame/route";
import { POST as analyzeRoute } from "../src/app/api/agent/analyze/route";
import { POST as projectsRoute } from "../src/app/api/agent/projects/route";
import { GET as collectionsGet, POST as collectionsRoute } from "../src/app/api/projects/route";
import { reviseClipPrompt } from "../src/lib/agent-llm";
import { clipReferenceBudget, projectReferenceIssues } from "../src/lib/agent-reference-validation";
import { saveCharacter, getCharacter, characterPath, listCharacters, deleteCharacter, cloneCharacter } from "../src/lib/characters";
import { POST as referenceRoute } from "../src/app/api/agent/reference/route";
import { buildPayload, DEFAULT_ENDPOINT } from "../src/lib/h3";
import { createCollection } from "../src/lib/project-collections";
import { saveStudioInput, saveStudioOutput, studioFolder } from "../src/lib/studio-assets";
import { prepareSequentialPrompt, assertPreviousPromptReady } from "../src/lib/sequential-prompts";
import { GET as studioMedia } from "../src/app/api/video/media/route";

const plan = {
  title: "Station arrival", summary: "A traveler waits, then boards a train.",
  references: [{ id: "traveler", name: "Traveler", kind: "character" as const, description: "The main traveler." }, { id: "station", name: "Station", kind: "location" as const, description: "Old station." }],
  clips: [{ id: "arrival", title: "Arrival", duration: 2, prompt: "A traveler approaches the station.", referenceIds: ["station", "traveler"], continuation: false }, { id: "boarding", title: "Boarding", duration: 2, prompt: "The traveler moves toward the train.", referenceIds: ["traveler", "station"], continuation: true }],
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBXkAAAAASUVORK5CYII=", "base64");
describe("project drafts", () => {
  it("keeps scene files and scoped library assets inside their parent and rejects cross-project references", async () => {
    const parent = await createCollection("Film"), other = await createCollection("Other film");
    const item = await saveCharacter({ collectionId: parent.id, kind: "location", name: "Station", images: [{ name: "station.png", bytes: png.length, base64: png.toString("base64") }] });
    expect(characterPath(item.id, item.images[0].path)).toContain(join(root, parent.title, "library", item.id));
    expect(await listCharacters(parent.id)).toHaveLength(1); expect(await listCharacters(other.id)).toHaveLength(0);
    const scene = (await (await projectsRoute(localMutation("agent/projects", { action: "create", collectionId: other.id, title: "Other scene" }))).json()).project;
    expect(projectFolder(scene.id)).toBe(join(root, other.title, "scenes", scene.id));
    const response = await referenceRoute(localMutation("agent/reference", { projectId: scene.id, characterId: item.id }));
    expect((await response.json()).code).toBe("invalid_library_project"); expect((await getProject(scene.id)).references).toEqual([]);
    const legacy = await saveCharacter({ name: "Legacy prop", kind: "prop", images: [{ name: "prop.png", bytes: png.length, base64: png.toString("base64") }] });
    const old = characterPath(legacy.id);
    expect((await collectionsRoute(localMutation("projects", { action: "assignAsset", projectId: parent.id, assetId: legacy.id }))).status).toBe(200);
    await expect(readFile(old)).rejects.toThrow(); expect(await readFile(characterPath(legacy.id, legacy.images[0].path))).toEqual(png);
    expect(await listCharacters(parent.id)).toHaveLength(2); expect(await listCharacters("")).toHaveLength(0);
  });
  it("saves Studio references and completed videos inside the project once and serves local byte ranges", async () => {
    const parent = await createCollection("Film"), localId = crypto.randomUUID();
    await saveStudioInput({ collectionId: parent.id, requestId: localId, settings: { ...defaultGeneration, prompt: "A scene", duration: 2, seed: "123" }, images: [{ name: "ref.png", bytes: png.length, base64: png.toString("base64") }], audios: [] });
    const folder = studioFolder(parent.id, localId);
    const manifest = JSON.parse(await readFile(join(folder, "request.json"), "utf8"));
    expect(await readFile(join(folder, manifest.images[0].path))).toEqual(png);
    const job = { localId, collectionId: parent.id, endpoint: "test", prompt: "A scene", createdAt: Date.now(), status: "COMPLETED", output: { video: `data:video/mp4;base64,${video.toString("base64")}` } };
    const [first, second] = await Promise.all([saveStudioOutput(job, new AbortController().signal), saveStudioOutput(job, new AbortController().signal)]);
    expect(first.output).toEqual(second.output); expect(await readFile(join(folder, "output.mp4"))).toEqual(video);
    await saveStudioOutput({ ...job, output: { video: "https://invalid.test/must-not-download-again.mp4" } }, new AbortController().signal);
    expect((await readdir(folder)).filter(name => name.endsWith(".mp4"))).toEqual(["output.mp4"]);
    const response = await studioMedia(new Request(`http://127.0.0.1:3000/api/video/media?projectId=${parent.id}&localId=${localId}`, { headers: { Host: "127.0.0.1:3000", Range: "bytes=0-31" } }));
    expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(video.subarray(0, 32));
  });
  it("groups multiple independent scenes under a project and preserves existing scenes when assigned", async () => {
    const parent = (await (await collectionsRoute(localMutation("projects", { action: "create", title: "My film" }))).json()).project;
    const other = (await (await collectionsRoute(localMutation("projects", { action: "create", title: "Another film" }))).json()).project;
    const first = (await (await projectsRoute(localMutation("agent/projects", { action: "create", title: "Scene one", collectionId: parent.id, script: "Arrival" }))).json()).project;
    const second = (await (await projectsRoute(localMutation("agent/projects", { action: "create", title: "Scene two", collectionId: parent.id, script: "Departure" }))).json()).project;
    expect(first.id).not.toBe(second.id);
    const legacy = await project(); const oldFolder = projectFolder(legacy.id);
    expect((await collectionsRoute(localMutation("projects", { action: "assign", projectId: parent.id, sceneId: legacy.id }))).status).toBe(200);
    expect(projectFolder(legacy.id)).toBe(join(root, parent.title, "scenes", legacy.id));
    await expect(readFile(join(oldFolder, "project.json"))).rejects.toThrow();
    expect(await readFile(assetPath(legacy.id, legacy.references[0].asset!.path))).toEqual(png);
    expect((await getProject(legacy.id)).references).toEqual(legacy.references);
    expect((await getProject(first.id)).script).toBe("Arrival"); expect((await getProject(second.id)).script).toBe("Departure");
    const response = await collectionsGet(new Request("http://127.0.0.1:3000/api/projects", { headers: { Host: "127.0.0.1:3000" } }));
    const groups = (await response.json()).projects;
    expect(groups.find((item: { id: string }) => item.id === parent.id)).toMatchObject({ sceneCount: 3, clipCount: 2 });
    expect(groups.find((item: { id: string }) => item.id === other.id)).toMatchObject({ sceneCount: 0, clipCount: 0 });
    await collectionsRoute(localMutation("projects", { action: "rename", projectId: parent.id, title: "Renamed film" }));
    expect((await getProject(first.id)).title).toBe("Scene one");
  });
  it("rejects nonexistent parent projects before creating or moving scenes", async () => {
    const missing = crypto.randomUUID();
    expect((await projectsRoute(localMutation("agent/projects", { action: "create", title: "Scene", collectionId: missing }))).status).toBe(400);
    expect(await listProjects()).toHaveLength(0);
    const legacy = await project();
    expect((await collectionsRoute(localMutation("projects", { action: "assign", projectId: missing, sceneId: legacy.id }))).status).toBe(400);
    expect((await getProject(legacy.id)).collectionId).toBeUndefined();
  });
  it("persists named drafts, saves scripts and analyzes into the same project", async () => {
    const response = await projectsRoute(localMutation("agent/projects", { action: "create", title: "  My film  ", script: "First scene" }));
    expect(response.status).toBe(200);
    const draft = (await response.json()).project;
    expect(draft.title).toBe("My film"); expect(draft.clips).toEqual([]);
    const saved = await projectsRoute(localMutation("agent/projects", { action: "saveDraft", projectId: draft.id, script: "Traveler arrives and boards." }));
    expect(saved.status).toBe(200);
    planning.call.mockResolvedValue({ title: plan.title, summary: plan.summary, references: plan.references });
    const analyzed = await analyzeRoute(localMutation("agent/analyze", { projectId: draft.id, script: "Traveler arrives and boards.", model: "test-model" }));
    expect(analyzed.status).toBe(200);
    const result = (await analyzed.json()).project;
    expect(result.id).toBe(draft.id); expect(result.title).toBe("My film"); expect(result.createdAt).toBe(draft.createdAt);
    expect(result.clips).toEqual([]); expect(result.references).toHaveLength(2); expect(result.referencesIdentified).toBe(true); expect(await listProjects()).toHaveLength(1);
  });
  it("renames without altering saved media and rejects draft edits to analyzed plans", async () => {
    const value = await project();
    const renamed = await projectsRoute(localMutation("agent/projects", { action: "rename", projectId: value.id, title: "New film name" }));
    expect(renamed.status).toBe(200);
    const current = await getProject(value.id);
    expect(current.title).toBe("New film name"); expect(current.clips).toEqual(value.clips); expect(current.references).toEqual(value.references);
    expect((await projectsRoute(localMutation("agent/projects", { action: "saveDraft", projectId: value.id, script: "Replacement" }))).status).toBe(400);
    expect((await analyzeRoute(localMutation("agent/analyze", { projectId: value.id, script: "Replacement", model: "test-model" }))).status).toBe(400);
    expect(planning.call).not.toHaveBeenCalled(); expect((await getProject(value.id)).script).toBe(value.script);
  });
  it("rejects empty names and keeps concurrent draft edits during analysis", async () => {
    expect((await projectsRoute(localMutation("agent/projects", { action: "create", title: "   " }))).status).toBe(400);
    const draft = (await (await projectsRoute(localMutation("agent/projects", { action: "create", title: "Film" }))).json()).project;
    planning.call.mockImplementation(async () => { await updateProject(draft.id, current => { current.script = "Newer script"; return current; }); return { title: plan.title, summary: plan.summary, references: plan.references }; });
    const response = await analyzeRoute(localMutation("agent/analyze", { projectId: draft.id, script: "Original scene", model: "test-model" }));
    expect((await response.json()).code).toBe("project_changed");
    const current = await getProject(draft.id); expect(current.script).toBe("Newer script"); expect(current.clips).toEqual([]);
  });
});
let root: string;
let video: Buffer;
function audioSample(seconds = 1) {
  const bytes = Buffer.alloc(44 + 8000 * 2 * seconds);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return { name: "voice.wav", bytes: bytes.length, base64: bytes.toString("base64") };
}
function localMutation(path: string, body: unknown) {
  return new Request(`http://127.0.0.1:3000/api/${path}`, { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function project(upload = true) {
  const value: AgentProject = { ...structuredClone(plan), id: crypto.randomUUID(), script: "Traveler arrives and boards.", model: "test-model", createdAt: Date.now(), updatedAt: Date.now(), status: "ready", sequentialPrompts: false, reviewBeforeEachClip: false, reviewAfterEachClip: false, settings: { ...defaultGeneration }, clips: plan.clips.map(clip => ({ ...structuredClone(clip), status: "pending" })) };
  await createProject(value);
  if (upload) { const asset = await writeAsset(value.id, "references/traveler.png", png, "image/png", "traveler.png"); await updateProject(value.id, current => { current.references[0].asset = asset; return current; }); }
  return getProject(value.id);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "video-agent-tests-")); vi.stubEnv("VIDEO_OUTPUT_DIR", root); vi.stubEnv("AGENT_STORAGE_DIR", join(root, "app-settings"));
  vi.stubEnv("RUNPOD_API_KEY", ""); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3000");
  planning.call.mockReset();
  memory.db = { runpod: { endpoint: "xnnd4qobofshqz", apiKey: "test-runpod-key" } }; memory.queue = Promise.resolve();
  video = await readFile(new URL("./fixtures/agent-preview.mp4", import.meta.url));
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // Only remove the exact temporary workspace created by this test.
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel.startsWith("video-agent-tests-") && !isAbsolute(rel) && !rel.includes("..")) await rm(root, { recursive: true, force: true });
});

describe("reference upload validation before generation", () => {
  it("stores locations and props, preserves their category on edit, and binds them to scene references", async () => {
    const value = await project(false);
    const image = { name: "reference.png", bytes: png.length, base64: png.toString("base64") };
    const location = await saveCharacter({ kind: "location", name: "Old station", images: [image] });
    const prop = await saveCharacter({ kind: "prop", name: "Letter", images: [image] });
    await saveCharacter({ id: location.id, name: "Station at dusk" });
    expect((await getCharacter(location.id)).kind).toBe("location");
    expect((await getCharacter(location.id)).images).toHaveLength(1);
    const attached = await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "station", characterId: location.id }));
    expect(attached.status).toBe(200);
    const added = await referenceRoute(localMutation("agent/reference", { projectId: value.id, characterId: prop.id }));
    expect(added.status).toBe(200);
    const saved = await getProject(value.id);
    expect(saved.references.find(slot => slot.id === "station")?.kind).toBe("location");
    const slot = saved.references.find(slot => slot.characterId === prop.id)!;
    expect(slot.kind).toBe("prop"); expect(saved.clips[0].referenceIds).toContain(slot.id);
    const built = await inputFor(saved, saved.clips[0]);
    expect(built.input.images).toHaveLength(2); expect(built.input.audios).toHaveLength(0);
    expect(built.input.settings.prompt).toContain("Station at dusk"); expect(built.input.settings.prompt).toContain("Letter");
    const mismatch = await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "station", characterId: prop.id }));
    expect(mismatch.status).toBe(400);
    expect((await getProject(value.id)).references.find(slot => slot.id === "station")?.kind).toBe("location");
    await expect(saveCharacter({ kind: "prop", name: "Incorrect", voices: [audioSample()] })).rejects.toThrow("Voice samples");
  });
  it("copies a saved character into the scene and submits selected images, voice and sampling steps", async () => {
    const value = await project(false), voice = audioSample();
    const character = await saveCharacter({ name: "Traveler", images: [{ name: "traveler.png", bytes: png.length, base64: png.toString("base64") }], voices: [voice], voiceUrls: ["https://media.example/traveler.wav"] });
    const response = await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "traveler", characterId: character.id }));
    expect(response.status).toBe(200);
    await saveCharacter({ id: character.id, name: "New name", images: [], voices: [] });
    const edit = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "edit", settings: { ...value.settings, steps: 18 } }));
    expect(edit.status).toBe(200);
    const saved = await getProject(value.id), built = await inputFor(saved, saved.clips[0]);
    expect(built.input.images).toHaveLength(1); expect(built.input.audios).toHaveLength(1);
    expect(built.input.audios[0].base64).toBe(voice.base64);
    expect(saved.references[0].audios![0].publicUrl).toBe("https://media.example/traveler.wav");
    expect(built.input.settings.prompt).toContain("<Audio 1>"); expect(built.input.settings.prompt).toContain("Traveler");
    const payload = buildPayload(built.input.settings, built.input.images, built.input.audios);
    expect(payload.input.workflow["124"].inputs.steps).toBe(18);
    expect(Object.values(payload.input.workflow).some(node => node.class_type === "LoadAudio")).toBe(true);
    expect(payload.input.images.find(file => file.name === "reference-audio-1.wav")?.image).toBe(voice.base64);
    saved.clips[0].referenceIds = [];
    expect((await inputFor(saved, saved.clips[0])).input.audios).toEqual([]);
    expect((await listCharacters())[0].name).toBe("New name");
    expect((await getCharacter(character.id)).voices).toEqual([]);
    expect(() => characterPath(character.id, "../secret")).toThrow();
    expect(DEFAULT_ENDPOINT).toBe("6b68a4fh76ub8s");
  });
  it("clears a selected library asset while retaining the scene slot, clip bindings, library and saved video", async () => {
    const value = await project(false);
    const character = await saveCharacter({ name: "Traveler", voices: [audioSample()], voiceUrls: ["https://media.example/voice.wav"] });
    expect((await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "traveler", characterId: character.id }))).status).toBe(200);
    const videoAsset = await writeAsset(value.id, "clips/arrival.mp4", video, "video/mp4", "arrival.mp4");
    const frameAsset = await writeAsset(value.id, "frames/arrival.png", png, "image/png", "arrival.png");
    await updateProject(value.id, current => { current.clips[0].status = "complete"; current.clips[0].video = videoAsset; current.clips[0].frame = frameAsset; current.clips[1].compiledPrompt = "Stale compiled prompt"; return current; });
    const response = await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "traveler", action: "clearLibraryAsset" }));
    expect(response.status).toBe(200);
    const saved = await getProject(value.id);
    expect(saved.references.map(slot => slot.id)).toEqual(["traveler", "station"]);
    expect(saved.references[0].characterId).toBeUndefined();
    expect(saved.references[0].asset).toBeUndefined();
    expect(saved.references[0].images).toBeUndefined();
    expect(saved.references[0].audios).toEqual([]);
    expect(saved.clips.every(clip => clip.referenceIds.includes("traveler"))).toBe(true);
    expect(saved.clips[1].compiledPrompt).toBeUndefined();
    expect(saved.clips[0].status).toBe("complete");
    expect(await readFile(assetPath(value.id, videoAsset.path))).toEqual(video);
    expect((await getCharacter(character.id)).voices[0].publicUrl).toBe("https://media.example/voice.wav");
    const controller = await reserveRun(value.id, "test-model", { clipId: "boarding" });
    expect((await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "station", action: "clearLibraryAsset" }))).status).toBe(400);
    controller.abort(); await executeProject(value.id, controller, { compile: async () => [] });
  });
  it("clones each library category with independent media and preserved voice links in the same project", async () => {
    const parent = await createCollection("Clones"), other = await createCollection("Other project");
    for (const kind of ["character", "location", "prop"] as const) {
      const source = await saveCharacter({ collectionId: parent.id, kind, name: `Original ${kind}`, description: "Original description", images: [{ name: "face.png", bytes: png.length, base64: png.toString("base64") }], ...(kind === "character" ? { voices: [audioSample()], voiceUrls: ["https://media.example/voice.wav"] } : {}) });
      await expect(cloneCharacter(source.id, other.id)).rejects.toThrow("selected project");
      const clone = await cloneCharacter(source.id, parent.id);
      expect(clone).toMatchObject({ collectionId: parent.id, kind, name: `Original ${kind} (copy)`, description: "Original description" });
      expect(clone.id).not.toBe(source.id);
      expect(clone.images[0].path).not.toBe(source.images[0].path);
      expect(await readFile(characterPath(clone.id, clone.images[0].path))).toEqual(png);
      if (kind === "character") {
        expect(clone.voices[0].publicUrl).toBe("https://media.example/voice.wav");
        expect(await readFile(characterPath(clone.id, clone.voices[0].path))).toEqual(await readFile(characterPath(source.id, source.voices[0].path)));
      }
      expect((await cloneCharacter(source.id, parent.id)).name).toBe(`Original ${kind} (copy 2)`);
      await saveCharacter({ id: clone.id, name: clone.name, description: "Changed copy" });
      expect((await getCharacter(source.id)).description).toBe("Original description");
      await deleteCharacter(source.id, parent.id);
      expect(await readFile(characterPath(clone.id, clone.images[0].path))).toEqual(png);
    }
  });
  it("removes whole library references while retaining recoverable files and scene copies", async () => {
    const parent = await createCollection("Library deletion"), other = await createCollection("Other project");
    const value = await project(false);
    await updateProject(value.id, current => { current.collectionId = parent.id; return current; });
    const character = await saveCharacter({ collectionId: parent.id, name: "Traveler", images: [{ name: "traveler.png", bytes: png.length, base64: png.toString("base64") }], voices: [audioSample()], voiceUrls: ["https://media.example/traveler.wav"] });
    const response = await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "traveler", characterId: character.id }));
    expect(response.status).toBe(200);
    await expect(deleteCharacter(character.id, other.id)).rejects.toThrow("Select this reference's project");
    expect((await getCharacter(character.id)).name).toBe("Traveler");
    const removed = await deleteCharacter(character.id, parent.id);
    expect(await listCharacters(parent.id)).toEqual([]);
    await expect(getCharacter(character.id)).rejects.toThrow("could not be opened");
    const recovered = JSON.parse(await readFile(join(removed.trashFolders[0], "0", "character.json"), "utf8"));
    expect(recovered.voices[0].publicUrl).toBe("https://media.example/traveler.wav");
    expect(await readFile(join(removed.trashFolders[0], "0", character.images[0].path))).toEqual(png);
    const saved = await getProject(value.id);
    expect(await readFile(assetPath(value.id, saved.references[0].asset!.path))).toEqual(png);
    expect(saved.references[0].audios![0].publicUrl).toBe("https://media.example/traveler.wav");
    for (const kind of ["location", "prop"] as const) {
      const item = await saveCharacter({ collectionId: parent.id, kind, name: kind });
      await deleteCharacter(item.id, parent.id);
    }
    expect(await listCharacters(parent.id)).toEqual([]);
  });
  it("edits and clears library voice links without replacing audio, rejecting invalid or unmatched links", async () => {
    const character = await saveCharacter({ name: "Speaker", voices: [audioSample()], voiceUrls: ["https://media.example/original.wav"] });
    const updated = await saveCharacter({ id: character.id, name: "Speaker updated", voiceUrls: ["https://media.example/updated.wav"] });
    expect(updated.voices[0].path).toBe(character.voices[0].path);
    expect((await getCharacter(character.id)).voices[0].publicUrl).toBe("https://media.example/updated.wav");
    expect(() => saveCharacter({ id: character.id, name: "Bad", voiceUrls: ["http://localhost/voice.wav"] })).toThrow("public HTTPS");
    await expect(saveCharacter({ name: "No sample", voiceUrls: ["https://media.example/voice.wav"] })).rejects.toThrow("matching local sample");
    expect((await getCharacter(character.id)).name).toBe("Speaker updated");
    const cleared = await saveCharacter({ id: character.id, name: "Speaker updated", voiceUrls: [""] });
    expect(cleared.voices[0].publicUrl).toBeUndefined();
    expect(cleared.voices[0].path).toBe(character.voices[0].path);
  });
  it("validates real voice durations, serves audio ranges, and counts audio against the upload budget", async () => {
    const value = await project(false), voice = audioSample();
    const uploaded = await referenceRoute(localMutation("agent/reference", { projectId: value.id, slotId: "traveler", kind: "audio", file: voice }));
    expect(uploaded.status).toBe(200);
    const saved = await getProject(value.id);
    expect(clipReferenceBudget(saved, saved.clips[0])).toMatchObject({ count: 0, audioCount: 1, bytes: voice.bytes });
    const response = await mediaRoute(new Request(`http://127.0.0.1:3000/api/agent/media?projectId=${value.id}&kind=audio&id=traveler&index=0`, { headers: { Host: "127.0.0.1:3000", Range: "bytes=0-43" } }));
    expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer()).toString("ascii", 0, 4)).toBe("RIFF");
    await expect(saveCharacter({ name: "Too long", voices: [audioSample(16)] })).rejects.toThrow("0.25–15");
    saved.references[0].audios![0].bytes = 6_000_001;
    expect(clipReferenceBudget(saved, saved.clips[0]).error).toContain("6 MB");
    saved.references[0].audios = Array(4).fill(saved.references[0].audios![0]);
    expect(clipReferenceBudget(saved, saved.clips[0]).error).toContain("3-audio limit");
  });
  it("counts only selected supplied images per clip, not empty or unused slots", async () => {
    const value = await project();
    value.references[0].asset!.bytes = 4_000_000;
    value.references[1].asset = { ...value.references[0].asset!, bytes: 4_000_000 };
    value.clips[0].referenceIds = ["traveler"];
    value.clips[1].referenceIds = ["station"];
    expect(projectReferenceIssues(value)).toEqual([]);
    expect(clipReferenceBudget(value, value.clips[1])).toMatchObject({ bytes: 4_000_000, count: 1, pendingFrame: true });
    delete value.references[1].asset;
    expect(clipReferenceBudget(value, value.clips[1])).toMatchObject({ bytes: 0, count: 0 });
  });
  it("accepts exactly six MB and explains even a one-byte overage", async () => {
    const value = await project();
    value.references[0].asset!.bytes = 3_000_000;
    value.references[1].asset = { ...value.references[0].asset!, bytes: 3_000_000 };
    expect(projectReferenceIssues(value)).toEqual([]);
    value.references[1].asset.bytes++;
    expect(projectReferenceIssues(value)[0].message).toContain("Clip 1 (Arrival): 6.01 MB");
    expect(projectReferenceIssues(value)[0].message).toContain("Reduce by at least 0.01 MB");
  });
  it("includes saved continuity frames and respects a manual cut override", async () => {
    const value = await project();
    value.references[0].asset!.bytes = 3_000_000;
    value.references[1].asset = { ...value.references[0].asset!, bytes: 2_000_000 };
    value.clips[0].status = "complete";
    value.clips[0].frame = { ...value.references[0].asset!, bytes: 1_100_000 };
    expect(projectReferenceIssues(value)).toHaveLength(1);
    expect(projectReferenceIssues(value)[0].message).toContain("including the previous clip’s last frame");
    value.clips[1].continuityMode = "off";
    expect(projectReferenceIssues(value)).toEqual([]);
  });
  it("validates the nine-image limit without counting the guide as an appearance reference", async () => {
    const value = await project();
    value.references = Array.from({ length: 10 }, (_, index) => ({ ...value.references[0], id: `ref_${index}` }));
    value.clips[0].referenceIds = value.references.map(slot => slot.id);
    expect(projectReferenceIssues(value)[0].message).toContain("10 selected images exceeds the 9-image limit");
    value.clips[0].referenceIds.pop();
    expect(clipReferenceBudget(value, value.clips[0]).error).toBe("");
  });
  it("allows recovery of existing renders and retained sources without another reference upload", async () => {
    const value = await project(); value.references[0].asset!.bytes = 8_000_000;
    value.clips[0].jobId = "existing-job";
    value.clips[1].source = { ...value.references[0].asset! };
    expect(projectReferenceIssues(value)).toEqual([]);
  });
  it("rejects oversized selections on the server before preparing or submitting jobs", async () => {
    const value = await project();
    await updateProject(value.id, current => {
      current.references[0].asset!.bytes = 3_100_000;
      current.references[1].asset = { ...current.references[0].asset! };
      return current;
    });
    await expect(reserveRun(value.id, "test-model")).rejects.toThrow("Clip 1 (Arrival): 6.20 MB");
    expect(isProjectActive(value.id)).toBe(false);
    expect((await getProject(value.id)).status).toBe("ready");
    expect((await getProject(value.id)).clips[0].requestId).toBeUndefined();
  });
});

describe("scene planning and reference selection", () => {
  async function sequentialScene() {
    const value = await project();
    return updateProject(value.id, current => { current.sequentialPrompts = true; current.reviewBeforeEachClip = true; current.clips[0].compiledPrompt = current.clips[0].prompt; current.clips[1].outline = current.clips[1].prompt; return current; });
  }
  const generation = () => vi.fn(async (input) => ({ localId: input.requestId, id: `sequential-${input.requestId}`, endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
  it("stores later clips as outlines instead of prepared prompts in the initial plan", async () => {
    const value = await project(); await updateProject(value.id, current => { current.clips = []; return current; });
    planning.call.mockResolvedValue({ clips: plan.clips.map((clip, index) => ({ ...clip, duration: index ? 9 : 2, referenceIds: ["traveler"], transition: index ? "continue" : "first", continuityReason: "Continuous story." })) });
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "plan", model: "test-model" }));
    expect(response.status).toBe(200); const saved = (await response.json()).project;
    expect(saved.sequentialPrompts).toBe(true); expect(saved.clips).toHaveLength(2);
    expect(saved.clips[0].compiledPrompt).toBeTruthy(); expect(saved.clips[1].compiledPrompt).toBeUndefined(); expect(saved.clips[1].outline).toBe(plan.clips[1].prompt);
    expect(planning.call.mock.calls[0][1]).toContain("final generation-ready prompt ONLY for the first clip");
  });
  async function finishFirst(value: AgentProject) {
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "arrival", prompt: "Static shot. The traveler reaches the door.", referenceIds: ["traveler"] }))).status).toBe(200);
    const submit = generation();
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival" }), { submit });
    return submit;
  }
  it.each(["pending", "failed"] as const)("keeps a %s clip's frame-aware prompt when sampling steps change and submits the new steps", async status => {
    const value = await sequentialScene(); planning.call.mockResolvedValue({ prompt: "Static shot. She boards from her position at the door." });
    await finishFirst(value);
    const before = await getProject(value.id), prompt = before.clips[1].compiledPrompt;
    if (status === "failed") await updateProject(value.id, current => { Object.assign(current.clips[1], { status, jobId: "failed-job", requestId: crypto.randomUUID(), error: "RunPod job failed." }); return current; });
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "edit", settings: { ...before.settings, steps: 18 } }));
    expect(response.status).toBe(200);
    const changed = (await response.json()).project;
    expect(changed.clips[1].compiledPrompt).toBe(prompt); expect(changed.clips[1].promptContextKey).toBe(before.clips[1].promptContextKey);
    expect(() => assertPreviousPromptReady(changed, changed.clips[1])).not.toThrow();
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "boarding", prompt, referenceIds: changed.clips[1].referenceIds }))).status).toBe(200);
    if (status === "failed") vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "failed-job", status: "FAILED" })));
    const submit = generation();
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "boarding", revision: status === "failed" }), { submit });
    expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0][0].settings.steps).toBe(18); expect(submit.mock.calls[0][0].settings.prompt).toContain(prompt!);
    expect(planning.call).toHaveBeenCalledTimes(1); expect((await getProject(value.id)).clips[1].status).toBe("complete");
  }, 20000);
  it("recovers an older prompt fingerprint after steps were already changed without accepting a changed frame", async () => {
    const value = await sequentialScene(); planning.call.mockResolvedValue({ prompt: "Static shot. She boards." }); await finishFirst(value);
    const before = await getProject(value.id), previous = before.clips[0], clip = before.clips[1];
    // Reproduce the old fingerprint, including the original settings property order.
    const originalSettings = { ...before.settings, provider: "runpod" as const };
    const hash = createHash("sha256");
    hash.update(JSON.stringify({ previous: { id: previous.id, prompt: previous.compiledPrompt || previous.prompt, frame: previous.frame, video: previous.video, jobId: previous.jobId, media: previous.media }, target: { duration: clip.duration, references: clip.referenceIds, continuation: previousFrameDecision(clip), settings: originalSettings } }));
    const originalFrame = await readFile(assetPath(value.id, previous.frame!.path)); hash.update(originalFrame);
    for (const ref of [...suppliedImages(before, clip), ...suppliedAudios(before, clip)]) { hash.update(JSON.stringify(ref)); hash.update(await readFile(assetPath(value.id, ref.asset.path))); }
    await updateProject(value.id, current => { current.settings = { provider: "runpod", ...current.settings, steps: 22 }; Object.assign(current.clips[1], { status: "failed", jobId: "failed-old-job", requestId: crypto.randomUUID(), promptContextKey: hash.digest("hex") }); return current; });
    const changed = await getProject(value.id);
    await writeAsset(value.id, previous.frame!.path, Buffer.concat([originalFrame, Buffer.from("changed")]), previous.frame!.mime, previous.frame!.name);
    expect(() => assertPreviousPromptReady(changed, changed.clips[1])).toThrow("Plan this prompt");
    await writeAsset(value.id, previous.frame!.path, originalFrame, previous.frame!.mime, previous.frame!.name);
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "boarding", prompt: clip.compiledPrompt, referenceIds: clip.referenceIds }));
    expect(response.status).toBe(200); expect((await response.json()).project.clips[1].promptContextKey).toMatch(/^v2:/);
    expect(planning.call).toHaveBeenCalledTimes(1);
  }, 15000);
  it("defers later prompts, inspects the actual saved last frame automatically, and waits for review", async () => {
    const value = await sequentialScene();
    const blocked = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "boarding", prompt: "Do not generate yet.", referenceIds: ["traveler"] }));
    expect(blocked.status).toBe(400); expect(planning.call).not.toHaveBeenCalled();
    planning.call.mockResolvedValue({ prompt: "Static shot, camera locked off; no camera movement. From her position at the door, the traveler steps aboard." });
    const submit = await finishFirst(value);
    const saved = await getProject(value.id);
    expect(submit).toHaveBeenCalledTimes(1); expect(saved.clips[0].status).toBe("complete"); expect(saved.clips[1].status).toBe("pending"); expect(saved.status).toBe("paused");
    expect(saved.clips[1].compiledPrompt).toContain("position at the door"); expect(saved.clips[1].promptContextKey).toBeTruthy();
    const context = JSON.parse(planning.call.mock.calls[0][2]);
    expect(context.lastFrameAttachment).toBe(2); expect(context.previous.actualDuration).toBeGreaterThan(0);
    expect(context.previous.submittedPrompt).toContain("reaches the door"); expect(context.target.outline).toBe(value.clips[1].outline);
    expect(planning.call.mock.calls[0][5]).toEqual([assetPath(value.id, value.references[0].asset!.path), assetPath(value.id, saved.clips[0].frame!.path)]);
    expect(() => assertPreviousPromptReady(saved, saved.clips[1])).not.toThrow();
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "boarding", prompt: "Static shot. She steps through the open train door.", referenceIds: saved.clips[1].referenceIds }))).status).toBe(200);
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "boarding" }), { submit });
    expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[1][0].settings.prompt).toContain("open train door"); expect(planning.call).toHaveBeenCalledTimes(1);
  }, 20000);
  it("rejects stale planning after a frame replacement and replans using the replacement image", async () => {
    const value = await sequentialScene(); planning.call.mockResolvedValue({ prompt: "Static shot. She boards." });
    await finishFirst(value);
    const before = await getProject(value.id);
    expect((await frameRoute(localMutation("agent/frame", { projectId: value.id, clipId: "arrival", file: { name: "replacement.png", bytes: png.length, base64: png.toString("base64") } }))).status).toBe(200);
    const changed = await getProject(value.id); expect(changed.clips[1].promptContextKey).toBeUndefined();
    await expect(reserveRun(value.id, "test-model", { clipId: "boarding" })).rejects.toThrow("Plan this prompt");
    planning.call.mockResolvedValue({ prompt: "Static shot. She continues from the replacement pose." });
    const replanned = await prepareSequentialPrompt(value.id, "boarding", "test-model");
    expect(planning.call.mock.calls.at(-1)![5].at(-1)).toBe(assetPath(value.id, changed.clips[0].frame!.path));
    expect(replanned.clips[1].compiledPrompt).toContain("replacement pose"); expect(replanned.clips[0].video).toEqual(before.clips[0].video);
  }, 15000);
  it("retains completed video if next-prompt planning fails and retries planning without submitting video", async () => {
    const value = await sequentialScene(); planning.call.mockRejectedValue(new Error("Disconnected"));
    const submit = await finishFirst(value);
    const saved = await getProject(value.id); expect(saved.clips[0].status).toBe("complete"); expect(saved.clips[0].video).toBeDefined();
    expect(saved.clips[1].promptPlanError).toContain("retry prompt planning"); expect(saved.clips[1].requestId).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1);
    planning.call.mockResolvedValue({ prompt: "Static shot. Continue boarding." });
    const retry = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "planNextPrompt", clipId: "boarding", model: "test-model" }));
    expect(retry.status).toBe(200); expect((await retry.json()).project.clips[1].promptPlanError).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1);
  }, 15000);
  it("keeps concurrent edits during frame-aware planning and lets cuts use the frame only as story context", async () => {
    const value = await sequentialScene(); planning.call.mockResolvedValue({ prompt: "Static shot. Continue." }); await finishFirst(value);
    await updateProject(value.id, current => { current.clips[1].continuation = false; current.clips[1].continuityMode = "off"; return current; });
    planning.call.mockImplementation(async () => { await updateProject(value.id, current => { current.clips[1].prompt = "Newer manual edit"; return current; }); return { prompt: "Stale new view." }; });
    await expect(prepareSequentialPrompt(value.id, "boarding", "test-model")).rejects.toThrow("scene or previous frame changed");
    expect((await getProject(value.id)).clips[1].prompt).toBe("Newer manual edit");
    expect(JSON.parse(planning.call.mock.calls.at(-1)![2]).target.continuation).toBe(false);
    expect(planning.call.mock.calls.at(-1)![1]).toContain("story context only");
  }, 15000);
  it("supports a discovered scene without reference slots and rejects planning an unidentified draft", async () => {
    const draft = (await (await projectsRoute(localMutation("agent/projects", { action: "create", title: "Landscape", script: "Clouds over a hill." }))).json()).project;
    expect((await projectRoute(localMutation("agent/project", { projectId: draft.id, action: "plan", model: "test-model" }))).status).toBe(400);
    planning.call.mockResolvedValue({ title: "Landscape", summary: "Clouds over a hill.", references: [] });
    const discovered = await analyzeRoute(localMutation("agent/analyze", { projectId: draft.id, script: "Clouds over a hill.", model: "test-model" }));
    expect(discovered.status).toBe(200); expect((await discovered.json()).project.clips).toEqual([]);
    planning.call.mockResolvedValue({ clips: [{ ...plan.clips[0], referenceIds: [], transition: "first", continuityReason: "Start." }] });
    const response = await projectRoute(localMutation("agent/project", { projectId: draft.id, action: "plan", model: "test-model" }));
    expect(response.status).toBe(200); expect((await response.json()).project.clips).toHaveLength(1);
  });
  it("stores manual edits for completed clips as a draft take and keeps submitted jobs locked", async () => {
    const value = await project();
    const videoAsset = await writeAsset(value.id, "clips/arrival.mp4", video, "video/mp4", "arrival.mp4");
    await updateProject(value.id, current => { Object.assign(current.clips[0], { status: "complete", video: videoAsset }); return current; });
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "arrival", prompt: "Static shot. Revised manually.", referenceIds: ["traveler"] }));
    expect(response.status).toBe(200);
    const saved = await getProject(value.id);
    expect(saved.clips[0].video).toEqual(videoAsset); expect(saved.clips[0].prompt).toBe(value.clips[0].prompt);
    expect(saved.clips[0].revision?.prompt).toBe("Static shot. Revised manually.");
    await updateProject(value.id, current => { Object.assign(current.clips[1], { status: "queued", jobId: "existing-job" }); return current; });
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "boarding", prompt: "Overwrite", referenceIds: [] }))).status).toBe(400);
    expect((await getProject(value.id)).clips[1].jobId).toBe("existing-job");
  });
  it("plans from supplied image contents only after reference discovery and keeps final prompts ready for editing", async () => {
    const value = await project();
    await updateProject(value.id, current => { current.clips = []; return current; });
    planning.call.mockResolvedValue({ clips: [{ ...plan.clips[0], referenceIds: ["traveler"], transition: "first", continuityReason: "Start." }] });
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "plan", model: "test-model", reasoningEffort: "high" }));
    expect(response.status).toBe(200);
    const saved = (await response.json()).project;
    expect(saved.references).toHaveLength(2); expect(saved.clips).toHaveLength(1);
    expect(saved.clips[0].compiledPrompt).toBe(saved.clips[0].prompt);
    expect(planning.call.mock.calls[0][5]).toEqual([assetPath(value.id, value.references[0].asset!.path)]);
    const context = JSON.parse(planning.call.mock.calls[0][2]);
    expect(context.suppliedReferences.map((slot: any) => slot.id)).toEqual(["traveler"]);
    expect(context.suppliedReferences[0].images[0].attachment).toBe(1);
    expect(planning.call.mock.calls[0][4]).toBe("high");
    expect((await compilePrompts(saved)).length).toBe(0); expect(planning.call).toHaveBeenCalledTimes(1);
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "plan", model: "test-model" }))).status).toBe(400);
  });
  it("keeps references if planning fails or changes concurrently and rejects unsupplied reference IDs", async () => {
    const value = await project();
    await updateProject(value.id, current => { current.clips = []; return current; });
    planning.call.mockResolvedValue({ clips: [{ ...plan.clips[0], referenceIds: ["station"], transition: "first", continuityReason: "Start." }] });
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "plan", model: "test-model" }))).status).toBe(422);
    expect((await getProject(value.id)).clips).toEqual([]);
    planning.call.mockImplementation(async () => {
      await updateProject(value.id, current => { current.references[0].name = "Edited traveler"; return current; });
      return { clips: [{ ...plan.clips[0], referenceIds: ["traveler"], transition: "first", continuityReason: "Start." }] };
    });
    expect((await (await projectRoute(localMutation("agent/project", { projectId: value.id, action: "plan", model: "test-model" }))).json()).code).toBe("project_changed");
    expect((await getProject(value.id)).references[0].name).toBe("Edited traveler");
  });
  it("applies comments to an unsubmitted edited prompt and submits that exact reviewed text without a second LLM call", async () => {
    const value = await project();
    planning.call.mockResolvedValue({ prompt: "Static shot. The traveler waves slowly." });
    const revised = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "revise", clipId: "arrival", prompt: "My edited static shot.", referenceIds: ["traveler"], comments: "Have her wave slowly", model: "test-model" }));
    expect(revised.status).toBe(200);
    expect(JSON.parse(planning.call.mock.calls[0][2]).target.prompt).toBe("My edited static shot.");
    expect(planning.call.mock.calls[0][5]).toEqual([assetPath(value.id, value.references[0].asset!.path)]);
    await updateProject(value.id, current => { current.reviewBeforeEachClip = true; return current; });
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "prepareClip", clipId: "arrival", prompt: "Static shot. The traveler waves beside the door.", referenceIds: ["traveler"] }));
    expect(response.status).toBe(200);
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "reviewed-job", endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival" }), { submit });
    expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0][0].settings.prompt).toContain("Static shot. The traveler waves beside the door.");
    expect(planning.call).toHaveBeenCalledTimes(1); expect((await getProject(value.id)).clips[1].status).toBe("pending");
  }, 15000);
  it("passes selected thinking through scene analysis and persists it with the project", async () => {
    const planned = { ...plan, clips: plan.clips.map((clip, index) => ({ ...clip, transition: index ? "continue" : "first", continuityReason: "Same scene." })) };
    planning.call.mockResolvedValue({ title: planned.title, summary: planned.summary, references: planned.references });
    const request = (effort: string) => new Request("http://127.0.0.1:3000/api/agent/analyze", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify({ script: "A traveler arrives.", model: "codex:test-model", reasoningEffort: effort }) });
    const response = await analyzeRoute(request("medium")); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project.reasoningEffort).toBe("medium"); expect((await getProject(data.project.id)).reasoningEffort).toBe("medium");
    expect(planning.call.mock.calls[0][4]).toBe("medium");
    const count = planning.call.mock.calls.length;
    expect((await analyzeRoute(request("unknown"))).status).toBe(400); expect(planning.call).toHaveBeenCalledTimes(count);
  });
  it("uses Codex CLI exclusively, including legacy saved model slugs and accepts a validated script plan", async () => {
    const planned = { ...plan, clips: plan.clips.map((clip, index) => ({ ...clip, transition: index ? "continue" : "first", continuityReason: index ? "Same traveler, place and continuous action." : "Start of the scene." })) };
    const fetch = vi.fn().mockResolvedValue(planned); planning.call.mockImplementation(fetch);
    const optimized = await analyzeScript("A traveler arrives.", "test-model");
    expect(optimized.clips).toHaveLength(1); expect(optimized.clips[0].duration).toBe(4); expect(optimized.clips[0].prompt).toContain(plan.clips[0].prompt); expect(optimized.clips[0].prompt).toContain(plan.clips[1].prompt);
    expect(fetch.mock.calls[0][0]).toBe("codex:test-model");
    expect(fetch.mock.calls[0][1]).toContain("smallest practical number");
    expect(fetch.mock.calls[0][2]).toBe("A traveler arrives.");
    expect(fetch.mock.calls[0][4]).toBe("low");
    await analyzeScript("Scene", "codex:test-model");
    expect(fetch.mock.calls[1][0]).toBe("codex:test-model");
  });
  it("rejects overlong shots, duplicate IDs, invented references and interrupted plans", async () => {
    for (const invalid of [{ ...plan, clips: [{ ...plan.clips[0], duration: 10.5 }] }, { ...plan, clips: [plan.clips[0], plan.clips[0]] }, { ...plan, clips: [{ ...plan.clips[0], referenceIds: ["invented"] }] }, { ...plan, clips: [{ ...plan.clips[0], continuation: true }] }]) expect(planSchema.safeParse(invalid).success).toBe(false);
    planning.call.mockRejectedValue(new Error("Codex stopped before the response completed"));
    await expect(analyzeScript("Scene", "test-model")).rejects.toThrow("before the response completed");
  });
  it("omits empty slots and assigns contiguous picture tags only to provided images", async () => {
    const value = await project(); value.reasoningEffort = "medium"; let compiledContent: Record<string, any> | undefined;
    planning.call.mockImplementation(vi.fn(async (_model, _instructions, content) => {
      compiledContent = JSON.parse(content);
      return { clips: value.clips.map(clip => ({ id: clip.id, prompt: clip.prompt })) };
    }));
    expect(referenceBindings(value, value.clips[0])).toEqual([{ id: "traveler", name: "Traveler", tag: "<Picture 1>" }]);
    await compilePrompts(value);
    expect(planning.call.mock.calls[0][4]).toBe("medium");
    expect(compiledContent?.clips[0].providedReferences).toEqual([{ id: "traveler", name: "Traveler" }]);
    const built = await inputFor(value, value.clips[0]);
    expect(built.input.images).toHaveLength(1); expect(built.input.settings.prompt).toContain("<Picture 1>"); expect(built.input.settings.prompt).not.toContain("<Picture 2>");
    const empty = await project(false); expect((await inputFor(empty, empty.clips[0])).input.images).toEqual([]);
    await expect(inputFor(value, value.clips[1])).rejects.toThrow("previous clip's saved last frame");
  });
  it("rejects mismatched compiled prompts before submitting any GPU jobs", async () => {
    const value = await project(); const fetch = vi.fn().mockResolvedValue({ clips: [{ id: "invented", prompt: "Wrong" }] }); planning.call.mockImplementation(fetch);
    const controller = await reserveRun(value.id, "test-model"); await executeProject(value.id, controller);
    const saved = await getProject(value.id); expect(saved.status).toBe("paused"); expect(saved.clips[0].requestId).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("fewer clips and automatic frame continuity", () => {
  function shot(index: number, duration: number, transition: "first" | "continue" | "cut" | "scene-change" | "time-jump") { return { ...plan.clips[0], id: `shot_${index}`, title: `Action ${index}`, duration, prompt: `Action ${index}. Dialogue: "Line ${index}."`, continuation: transition === "continue", transition, continuityReason: `Boundary ${transition}.` }; }
  function mutation(id: string, data: object) { return new Request("http://127.0.0.1:3000/api/agent/project", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify({ projectId: id, ...data }) }); }
  it("packs five two-second actions into one ten-second clip without losing dialogue or reference IDs", () => {
    const input = { ...plan, clips: Array.from({ length: 5 }, (_, index) => shot(index, 2, index ? "continue" : "first")) };
    const output = automaticPlan(input);
    expect(compactPlan({ ...plan, clips: [shot(0, 6, "first"), shot(1, 4, "continue")] }).clips[0].duration).toBe(10);
    expect(output.clips).toHaveLength(1); expect(output.clips[0].duration).toBe(10); expect(output.clips[0].continuation).toBe(false);
    for (let index = 0; index < 5; index++) expect(output.clips[0].prompt).toContain(`Dialogue: "Line ${index}."`);
    expect(output.clips[0].prompt).toContain("8–10s:"); expect(output.clips[0].referenceIds).toEqual(["station", "traveler"]); expect(input.clips).toHaveLength(5);
  });
  it("reuses the last frame for direct continuation but starts fresh for cuts, locations and time jumps", async () => {
    const clips = [shot(0, 8, "first"), { ...shot(1, 8, "continue"), continuation: false }, { ...shot(2, 8, "cut"), continuation: true }, { ...shot(3, 8, "scene-change"), continuation: true }, { ...shot(4, 8, "time-jump"), continuation: true }];
    const optimized = automaticPlan({ ...plan, clips });
    expect(optimized.clips.map(clip => clip.continuation)).toEqual([false, true, false, false, false]); expect(optimized.clips).toHaveLength(5);
    const value = await project();
    await updateProject(value.id, current => { current.clips = optimized.clips.map(clip => ({ ...clip, status: "pending" })); return current; });
    const frame = await writeAsset(value.id, "frames/shot_0.jpg", Buffer.from([255, 216, 255, 217]), "image/jpeg", "last-frame.jpg");
    await updateProject(value.id, current => { current.clips[0].status = "complete"; current.clips[0].frame = frame; return current; });
    const saved = await getProject(value.id);
    expect((await inputFor(saved, saved.clips[1])).firstFrameFrom).toBe("shot_0");
    for (const clip of saved.clips.slice(2)) expect((await inputFor(saved, clip)).input.firstFrame).toBeUndefined();
  });
  it("does not merge across cuts, manual decisions, ten-second capacity or nine-reference limits", () => {
    expect(compactPlan({ ...plan, clips: [shot(0, 6, "first"), shot(1, 6, "continue")] }).clips).toHaveLength(2);
    for (const boundary of ["cut", "scene-change", "time-jump"] as const) expect(compactPlan({ ...plan, clips: [shot(0, 2, "first"), shot(1, 2, boundary)] }).clips).toHaveLength(2);
    expect(compactPlan({ ...plan, clips: [shot(0, 2, "first"), { ...shot(1, 2, "continue"), continuityMode: "off" }] }).clips).toHaveLength(2);
    const references = Array.from({ length: 10 }, (_, i) => ({ ...plan.references[0], id: `ref_${i}` }));
    const capped = compactPlan({ ...plan, references, clips: [{ ...shot(0, 2, "first"), referenceIds: references.slice(0, 5).map(ref => ref.id) }, { ...shot(1, 2, "continue"), referenceIds: references.slice(5).map(ref => ref.id) }] });
    expect(capped.clips).toHaveLength(2);
  });
  it("optimizes an existing plan while keeping supplied image files and slot assignments", async () => {
    const value = await project(); const original = value.references[0].asset;
    const fetch = vi.fn().mockResolvedValue({ clips: [{ ...shot(0, 4, "first"), referenceIds: ["station"], sourceClipIds: ["arrival", "boarding"] }] }); planning.call.mockImplementation(fetch);
    const responseValue = await projectRoute(mutation(value.id, { action: "optimize", model: "test-model" })); expect(responseValue.status).toBe(200);
    const saved = await getProject(value.id); expect(saved.clips).toHaveLength(1); expect(saved.clips[0].continuityMode).toBe("auto"); expect(saved.references[0].asset).toEqual(original); expect(await readFile(assetPath(value.id, original!.path))).toEqual(png);
    expect((await inputFor(saved, saved.clips[0])).input.images).toHaveLength(1); expect(saved.clips[0].referenceIds).toContain("traveler");
    expect(memory.db.h3Jobs).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refuses dropped story segments, removed manual boundaries, and already-submitted plans", async () => {
    const value = await project(); const fetch = vi.fn().mockResolvedValue({ clips: [{ ...shot(0, 4, "first"), sourceClipIds: ["arrival"] }] }); planning.call.mockImplementation(fetch);
    await expect(optimizeScriptPlan(value, "test-model")).rejects.toThrow("every original clip in order");
    value.clips[1].continuityMode = "off";
    fetch.mockResolvedValue({ clips: [{ ...shot(0, 4, "first"), sourceClipIds: ["arrival", "boarding"] }] });
    await expect(optimizeScriptPlan(value, "test-model")).rejects.toThrow("manual continuity boundary");
    await updateProject(value.id, current => { current.clips[0].requestId = crypto.randomUUID(); return current; }); fetch.mockClear();
    const result = await projectRoute(mutation(value.id, { action: "optimize", model: "test-model" })); expect(result.status).toBe(400); expect((await result.json()).code).toBe("plan_locked"); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps concurrent edits and permits switching from an override back to automatic continuity", async () => {
    const value = await project();
    planning.call.mockImplementation(vi.fn(async () => { await updateProject(value.id, current => { current.clips[0].prompt = "User's newest edit."; return current; }); return { clips: [{ ...shot(0, 4, "first"), sourceClipIds: ["arrival", "boarding"] }] }; }));
    const stale = await projectRoute(mutation(value.id, { action: "optimize", model: "test-model" })); expect(stale.status).toBe(400); expect((await stale.json()).code).toBe("project_changed"); expect((await getProject(value.id)).clips[0].prompt).toBe("User's newest edit.");
    await updateProject(value.id, current => { current.clips[1].transition = "continue"; current.clips[1].autoContinuation = true; return current; });
    const clip = (await getProject(value.id)).clips[1];
    const manual = await projectRoute(mutation(value.id, { action: "edit", clip: { ...clip, continuityMode: "off", continuation: false } })); expect(manual.status).toBe(200); expect((await getProject(value.id)).clips[1].continuation).toBe(false);
    const auto = await projectRoute(mutation(value.id, { action: "edit", clip: { ...clip, continuityMode: "auto", continuation: false } })); expect(auto.status).toBe(200); expect((await getProject(value.id)).clips[1].continuation).toBe(true);
  });
});

describe("last-frame replacement and feedback-driven clip retries", () => {
  function request(id: string, data: object, path = "project", origin = "http://127.0.0.1:3000") { return new Request(`http://127.0.0.1:3000/api/agent/${path}`, { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: id, ...data }) }); }
  async function completedClip() {
    const value = await project();
    const savedVideo = await writeAsset(value.id, "clips/original.mp4", video, "video/mp4", "original.mp4");
    const frame = await writeAsset(value.id, "frames/original.png", png, "image/png", "original.png");
    await updateProject(value.id, current => { Object.assign(current.clips[0], { status: "complete", requestId: crypto.randomUUID(), jobId: "original-job", video: savedVideo, frame, extractedFrame: frame }); return current; });
    return getProject(value.id);
  }
  it("keeps the video and extracted frame, replaces the guide and restores it across reloads", async () => {
    const value = await completedClip();
    await updateProject(value.id, current => { current.clips[1].status = "complete"; current.clips[1].firstFrameFrom = "arrival"; return current; });
    const result = await frameRoute(request(value.id, { clipId: "arrival", file: { name: "custom.png", bytes: png.length, base64: png.toString("base64") } }, "frame"));
    expect(result.status).toBe(200);
    const saved = await getProject(value.id);
    expect(saved.clips[0].frameReplaced).toBe(true); expect(saved.clips[0].video).toEqual(value.clips[0].video); expect(saved.clips[0].extractedFrame).toEqual(value.clips[0].frame);
    expect(saved.clips[1].continuityOutdated).toBe(true);
    expect(await readFile(assetPath(value.id, saved.clips[0].frame!.path))).toEqual(png);
    const input = await inputFor(saved, saved.clips[1]); expect(input.input.firstFrame?.name).toBe("continuity-arrival.png"); expect(input.input.firstFrame?.base64).toBe(png.toString("base64"));
    const restored = await frameRoute(request(value.id, { clipId: "arrival", restore: true }, "frame")); expect(restored.status).toBe(200);
    expect((await getProject(value.id)).clips[0].frame).toEqual(value.clips[0].frame);
    expect(await readFile(assetPath(value.id, value.clips[0].video!.path))).toEqual(video);
  });
  it("uses replacement bytes under the original filename and retries without comments", async () => {
    const value = await completedClip();
    const before = await inputFor(value, value.clips[1]);
    const changed = Buffer.concat([png, Buffer.from("replacement")]);
    const response = await frameRoute(request(value.id, { clipId: "arrival", file: { name: "replacement.png", bytes: changed.length, base64: changed.toString("base64") } }, "frame"));
    expect(response.status).toBe(200);
    const updated = await getProject(value.id), after = await inputFor(updated, updated.clips[1]);
    expect(after.input.firstFrame!.name).toBe(before.input.firstFrame!.name);
    expect(Buffer.from(after.input.firstFrame!.base64, "base64")).toEqual(changed);
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "retry-current", endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival", retryCurrent: true }), { compile: async () => [], submit });
    const saved = await getProject(value.id);
    expect(submit).toHaveBeenCalledTimes(1); expect(planning.call).not.toHaveBeenCalled();
    expect(saved.clips[0].versions).toHaveLength(1);
    expect(saved.clips[0].versions![0].clip.frame).toEqual(updated.clips[0].frame);
    expect(saved.clips[0].prompt).toBe(value.clips[0].prompt); expect(saved.clips[1].status).toBe("pending");
  });
  it("rejects forged origins, non-images and edits during generation without changing the frame", async () => {
    const value = await completedClip();
    const data = { clipId: "arrival", file: { name: "fake.png", bytes: 4, base64: Buffer.from("fake").toString("base64") } };
    expect((await frameRoute(request(value.id, data, "frame", "https://attacker.example"))).status).toBe(400);
    expect((await frameRoute(request(value.id, data, "frame"))).status).toBe(400);
    const controller = await reserveRun(value.id, "test-model");
    expect((await frameRoute(request(value.id, { clipId: "arrival", restore: true }, "frame"))).status).toBe(400);
    controller.abort(); await executeProject(value.id, controller, { compile: async () => [] });
    expect((await getProject(value.id)).clips[0].frame).toEqual(value.clips[0].frame);
  });
  it("revises only the chosen prompt from feedback and actual references without starting a GPU job", async () => {
    const value = await completedClip(); let sent: any;
    const fetch = vi.fn(async (_model, _instructions, content) => { sent = JSON.parse(content); return { prompt: "The traveler approaches slowly in a low tracking shot." }; }); planning.call.mockImplementation(fetch);
    const result = await projectRoute(request(value.id, { action: "revise", clipId: "arrival", comments: "Use a lower camera and slower walking.", model: "test-model", reasoningEffort: "high" })); expect(result.status).toBe(200);
    expect(planning.call.mock.calls[0][4]).toBe("high");
    expect(sent.feedback).toContain("lower camera"); expect(sent.target.id).toBe("arrival"); expect(sent.target.providedReferences).toEqual([{ id: "traveler", name: "Traveler" }]); expect(sent.next.title).toBe("Boarding");
    const saved = await getProject(value.id); expect(saved.clips[0].revision?.prompt).toContain("low tracking shot"); expect(saved.clips[0].status).toBe("complete"); expect(saved.clips[0].video).toEqual(value.clips[0].video); expect(saved.clips[1]).toEqual(value.clips[1]); expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue({ prompt: "Use <Picture 2>." }); await expect(reviseClipPrompt(value, "arrival", "Change it", "test-model")).rejects.toThrow("invalid revised prompt");
  });
  it("revises with selected references and renders manually edited text without changing the previous take", async () => {
    const value = await completedClip();
    await updateProject(value.id, current => { current.references[1].asset = current.references[0].asset; return current; });
    let context: any;
    planning.call.mockImplementation(async (_model, _instructions, content) => { context = JSON.parse(content); return { prompt: "Static shot. The traveler waits at the station." }; });
    const revised = await projectRoute(request(value.id, { action: "revise", clipId: "arrival", comments: "Use only the station image", model: "test-model", referenceIds: ["station"] }));
    expect(revised.status).toBe(200);
    expect(context.target.providedReferences).toEqual([{ id: "station", name: "Station" }]);
    let saved = await getProject(value.id);
    expect(saved.clips[0].referenceIds).toEqual(value.clips[0].referenceIds);
    expect(saved.clips[0].revision!.referenceIds).toEqual(["station"]);
    const prompt = "Static shot, camera locked off. The traveler smiles by the station window.";
    expect((await projectRoute(request(value.id, { action: "editRevision", clipId: "arrival", prompt, referenceIds: ["station"] }))).status).toBe(200);
    expect((await projectRoute(request(value.id, { action: "editRevision", clipId: "arrival", prompt, referenceIds: ["missing"] }))).status).toBe(400);
    expect((await projectRoute(request(value.id, { action: "editRevision", clipId: "arrival", prompt: "Use <Picture 1>", referenceIds: ["station"] }))).status).toBe(400);
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "edited-revision", endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival", revision: true }), { compile: async () => [], submit });
    saved = await getProject(value.id);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].settings.prompt).toContain(prompt);
    expect(submit.mock.calls[0][0].settings.prompt).toContain("supplied reference for Station");
    expect(submit.mock.calls[0][0].images).toHaveLength(1);
    expect(saved.clips[0].referenceIds).toEqual(["station"]);
    expect(saved.clips[0].versions![0].clip.referenceIds).toEqual(value.clips[0].referenceIds);
    expect(saved.clips[0].versions![0].clip.video).toEqual(value.clips[0].video);
  }, 15000);
  it("keeps concurrent edits and saved output if prompt revision fails or becomes stale", async () => {
    const value = await completedClip();
    planning.call.mockImplementation(vi.fn(async () => { await updateProject(value.id, current => { current.reviewAfterEachClip = true; return current; }); return { prompt: "A lower angle." }; }));
    const result = await projectRoute(request(value.id, { action: "revise", clipId: "arrival", comments: "Lower angle", model: "test-model" })); expect((await result.json()).code).toBe("project_changed");
    expect((await getProject(value.id)).clips[0].revision).toBeUndefined(); expect((await getProject(value.id)).clips[0].video).toEqual(value.clips[0].video);
  });
  it("rerenders only one revised clip, preserving original takes and untouched pending clips", async () => {
    const value = await completedClip();
    await updateProject(value.id, current => { current.clips[0].revision = { prompt: "Low tracking shot of the traveler.", comments: "Lower angle", model: "test-model", createdAt: Date.now() }; return current; });
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "revised-job", endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    const compile = vi.fn(async (context: AgentProject) => { expect(context.clips.map(clip => clip.id)).toEqual(["arrival"]); expect(context.reasoningEffort).toBe("high"); return []; });
    const controller = await reserveRun(value.id, "test-model", { clipId: "arrival", revision: true, reasoningEffort: "high" });
    await executeProject(value.id, controller, { compile, submit });
    const saved = await getProject(value.id); expect(saved.status).toBe("paused"); expect(saved.runClipId).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].settings.prompt).toContain("Low tracking shot"); expect(submit.mock.calls[0][0].requestId).not.toBe(value.clips[0].requestId);
    expect(saved.clips[1]).toEqual(value.clips[1]); expect(saved.clips[0].versions?.[0].clip.video).toEqual(value.clips[0].video); expect(saved.clips[0].video!.path).not.toBe(value.clips[0].video!.path); expect(await readFile(assetPath(value.id, value.clips[0].video!.path))).toEqual(video);
    const previous = await mediaRoute(new Request(`http://127.0.0.1:3000/api/agent/media?projectId=${value.id}&kind=video&id=arrival&version=0`, { headers: { Host: "127.0.0.1:3000" } })); expect(Buffer.from(await previous.arrayBuffer())).toEqual(video);
  }, 15000);
  it("pauses after each saved clip for review, then continues with its replacement frame", async () => {
    const value = await project(); await updateProject(value.id, current => { current.reviewAfterEachClip = true; return current; });
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: crypto.randomUUID(), endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], submit });
    const paused = await getProject(value.id); expect(paused.status).toBe("paused"); expect(paused.clips[0].status).toBe("complete"); expect(paused.clips[1].status).toBe("pending"); expect(isProjectActive(value.id)).toBe(false);
    expect((await frameRoute(request(value.id, { clipId: "arrival", file: { name: "guide.png", bytes: png.length, base64: png.toString("base64") } }, "frame"))).status).toBe(200);
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], submit });
    expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[1][0].firstFrame?.base64).toBe(png.toString("base64")); expect((await getProject(value.id)).status).toBe("complete");
  }, 20000);
  it("resumes an interrupted retry without submitting again or running other pending clips", async () => {
    const value = await completedClip();
    await updateProject(value.id, current => { current.clips[0].revision = { prompt: "A slower approach.", comments: "Slower", model: "test-model", createdAt: Date.now() }; return current; });
    const controller = await reserveRun(value.id, "test-model", { clipId: "arrival", revision: true });
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "retry-job", endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "IN_QUEUE", createdAt: Date.now() }));
    const check = vi.fn(async () => { controller.abort(); return { localId: "test", id: "retry-job", endpoint: "xnnd4qobofshqz", prompt: "Test", status: "IN_PROGRESS", createdAt: Date.now() }; });
    await executeProject(value.id, controller, { compile: async () => [], submit, check, pollMs: 1 });
    const paused = await getProject(value.id); expect(paused.runClipId).toBe("arrival"); expect(paused.clips[0].status).toBe("recoverable");
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], submit, check: async () => ({ localId: "test", id: "retry-job", endpoint: "xnnd4qobofshqz", prompt: "Test", status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }) });
    const saved = await getProject(value.id); expect(submit).toHaveBeenCalledTimes(1); expect(saved.clips[0].status).toBe("complete"); expect(saved.clips[1]).toEqual(value.clips[1]); expect(saved.runClipId).toBeUndefined(); expect(saved.status).toBe("paused");
  }, 15000);
});

describe("sequential generation with real FFmpeg and durable media", () => {
  it("saves both videos and final frames, then uses the preceding frame at index zero", async () => {
    const value = await project(); const submissions: any[] = []; let savedBeforeNext = false;
    planning.call.mockResolvedValue({ clips: value.clips.map(clip => ({ id: clip.id, prompt: clip.prompt })) });
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/run")) {
        if (submissions.length) { const saved = await getProject(value.id); expect(saved.clips[0].status).toBe("complete"); expect((await readFile(assetPath(value.id, saved.clips[0].video!.path))).length).toBeGreaterThan(1000); savedBeforeNext = true; }
        submissions.push(JSON.parse(String(options?.body))); return Response.json({ id: `job-${submissions.length}`, status: "IN_QUEUE" });
      }
      return Response.json({ status: "COMPLETED", output: { video: `data:video/mp4;base64,${video.toString("base64")}` } });
    }); vi.stubGlobal("fetch", fetch);
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { pollMs: 1 });
    const saved = await getProject(value.id);
    expect(saved.error).toBeUndefined(); expect(saved.status).toBe("complete"); expect(isProjectActive(value.id)).toBe(false); expect(savedBeforeNext).toBe(true); expect(submissions).toHaveLength(2);
    expect(submissions[0].input.images).toHaveLength(1); expect(submissions[1].input.images).toHaveLength(2);
    const workflow = submissions[1].input.workflow;
    expect(workflow.agent_frame_guide).toEqual({ class_type: "MiniMaxH3AddGuide", inputs: { positive: ["136", 0], latent: ["136", 1], vae: ["119", 0], image: ["agent_first_frame", 0], frame_idx: 0 } });
    expect(workflow["126"].inputs.conditioning).toEqual(["agent_frame_guide", 0]); expect(workflow["125"].inputs.latent_image).toEqual(["136", 1]);
    expect(submissions[1].input.images[1].image).toBe((await readFile(assetPath(value.id, saved.clips[0].frame!.path))).toString("base64"));
    expect(saved.clips[1].firstFrameFrom).toBe("arrival");
    for (const clip of saved.clips) { expect(await probeMedia(assetPath(value.id, clip.video!.path))).toMatchObject({ duration: 2, fps: 24 }); expect((await readFile(assetPath(value.id, clip.frame!.path))).subarray(0, 2)).toEqual(Buffer.from([255, 216])); }
    expect((await readdir(join(projectFolder(value.id), "clips"))).sort()).toEqual(["arrival.mp4", "boarding.mp4"]);
    expect(saved.clips.every(clip => clip.source?.path === clip.video?.path)).toBe(true);
    expect((await listProjects())[0]).toMatchObject({ completed: 2, clipCount: 2 });
    const records = await readdir(join(projectFolder(value.id), "requests")); const audit = await readFile(join(projectFolder(value.id), "requests", records[0]), "utf8");
    expect(audit).not.toContain("test-runpod-key"); expect(audit).not.toContain(png.toString("base64")); expect(audit).not.toContain("Station");
    expect(memory.db.h3Jobs?.every(job => !job.agent && String((job.output as { video: string }).video).includes("/api/agent/media"))).toBe(true);
  }, 20000);
  it("trims a longer worker result to exactly ten seconds and extracts a playable final frame", async () => {
    const value = await project(false);
    const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
    const longPath = assetPath(value.id, "clips/long.mp4");
    await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-stream_loop", "5", "-i", fileURLToPath(new URL("./fixtures/agent-preview.mp4", import.meta.url)), "-c", "copy", longPath], { windowsHide: true });
    const source = { path: "clips/long.mp4", name: "long.mp4", bytes: 1, mime: "video/mp4" };
    const saved = await finalizeClip(value.id, "ten_seconds", source, 10, new AbortController().signal);
    expect(saved.media.duration).toBe(10); expect(saved.media.fps).toBe(24); expect(saved.frame.bytes).toBeGreaterThan(100);
  }, 20000);
  it("keeps the intermediate when final-file verification fails and never removes the final itself", async () => {
    const value = await project(false);
    const source = await downloadOutput(value.id, "cleanup-test", { video: `data:video/mp4;base64,${video.toString("base64")}` }, new AbortController().signal);
    const final = await writeAsset(value.id, "clips/final.mp4", video, "video/mp4", "final.mp4");
    await expect(discardProcessedSource(value.id, source, { ...final, bytes: final.bytes + 1 })).rejects.toThrow("source was kept");
    expect(await readFile(assetPath(value.id, source.path))).toEqual(video);
    await discardProcessedSource(value.id, final, final); expect(await readFile(assetPath(value.id, final.path))).toEqual(video);
    await discardProcessedSource(value.id, source, final);
    await expect(readFile(assetPath(value.id, source.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(assetPath(value.id, final.path))).toEqual(video);
  });
  it("blocks uncertain submissions and recovers an existing job without paying for a duplicate", async () => {
    const value = await project(); value.clips = value.clips.slice(0, 1); await updateProject(value.id, current => { current.clips = value.clips; return current; });
    let runs = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url.endsWith("/run")) { runs++; throw new Error("Lost response"); } return Response.json({ id: "found-job", status: "COMPLETED", output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }); }));
    const compile = async () => [{ id: "arrival", prompt: "Traveler approaches." }];
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile, pollMs: 1 });
    expect((await getProject(value.id)).clips[0].status).toBe("submission-unknown");
    await expect(reserveRun(value.id, "test-model")).rejects.toThrow("submission needs recovery");
    await expect(retryClip(value.id, "arrival")).rejects.toThrow("Review the RunPod console");
    await recoverClip(value.id, "arrival", "found-job");
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], pollMs: 1 });
    expect((await getProject(value.id)).status).toBe("complete"); expect(runs).toBe(1);
  }, 20000);
  it("allows explicit replacement of a missing job, but blocks retries of live jobs and status failures", async () => {
    const value = await project(false);
    const requestId = crypto.randomUUID();
    memory.db.h3Jobs = [{ localId: requestId, id: "expired-job", endpoint: "xnnd4qobofshqz", prompt: "Original", status: "IN_QUEUE", createdAt: Date.now(), agent: true }];
    await updateProject(value.id, current => { Object.assign(current.clips[0], { status: "recoverable", requestId, jobId: "expired-job", compiledPrompt: "Original compiled prompt" }); return current; });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValue(Response.json({ id: "expired-job", status: "IN_PROGRESS" }));
    await expect(reserveRun(value.id, "test-model", { clipId: "arrival", retryCurrent: true })).rejects.toThrow("This job still exists");
    fetch.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(reserveRun(value.id, "test-model", { clipId: "arrival", retryCurrent: true })).rejects.toThrow("rejected the API key");
    fetch.mockResolvedValue(new Response("not found", { status: 404 }));
    const submit = vi.fn();
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival" }), { compile: async () => [], submit });
    expect(submit).not.toHaveBeenCalled();
    expect((await getProject(value.id)).clips[0].status).toBe("recoverable");
    const controller = await reserveRun(value.id, "test-model", { clipId: "arrival", retryCurrent: true });
    const replacement = await getProject(value.id);
    expect(replacement.clips[0]).toMatchObject({ status: "pending", compiledPrompt: "Original compiled prompt" });
    expect(replacement.clips[0].jobId).toBeUndefined();
    expect(replacement.clips[0].requestId).toBeUndefined();
    expect(replacement.clips[0].versions![0].clip.jobId).toBe("expired-job");
    expect(replacement.clips[1].status).toBe("pending");
    fetch.mockResolvedValue(Response.json({ id: "replacement-job", status: "COMPLETED", output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, controller, { compile: async () => [], pollMs: 1 });
    const saved = await getProject(value.id);
    expect(saved.clips[0].status).toBe("complete");
    expect(saved.clips[0].jobId).toBe("replacement-job");
    expect(saved.clips[0].requestId).not.toBe(requestId);
    expect(saved.clips[1].requestId).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/run"))).toHaveLength(1);
  }, 15000);
  it("generates Wan clips in reference mode with a continuation image, saving media locally", async () => {
    const value = await project();
    memory.db.apimart = { apiKey: "test-wan-key" };
    memory.db.runpod = undefined;
    await updateProject(value.id, current => { current.settings.provider = "apimart"; current.settings.wanResolution = "480P"; return current; });
    const generationBodies: any[] = [];
    const uploads: File[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-wan-key");
      if (url.endsWith("/uploads/images")) {
        uploads.push((options.body as FormData).get("file") as File);
        return Response.json({ url: `https://upload.apimart.ai/ref-${uploads.length}.png` });
      }
      if (url.endsWith("/videos/generations")) {
        generationBodies.push(JSON.parse(options.body as string));
        return Response.json({ code: 200, data: [{ task_id: `wan-${generationBodies.length}`, status: "submitted" }] });
      }
      return Response.json({ code: 200, data: { id: `wan-${generationBodies.length}`, status: "completed", result: { videos: [{ url: [`data:video/mp4;base64,${video.toString("base64")}`] }] } } });
    }));
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], pollMs: 1 });
    const saved = await getProject(value.id);
    expect(saved.status).toBe("complete");
    expect(generationBodies).toHaveLength(2);
    expect(generationBodies.every(body => body.duration === -1)).toBe(true);
    expect(saved.clips[0].requestedDuration).toBe(-1);
    expect(saved.clips[0].media!.duration).toBeGreaterThan(saved.clips[0].duration);
    expect(generationBodies[0]).toMatchObject({ model: "wan3.0-video", resolution: "480P", generation_type: "reference", image_with_roles: [{ role: "reference_image", url: "https://upload.apimart.ai/ref-1.png" }] });
    expect(generationBodies[0].prompt).toContain("图1");
    expect(generationBodies[1].image_with_roles).toEqual([{ role: "reference_image", url: "https://upload.apimart.ai/ref-2.png" }, { role: "reference_image", url: "https://upload.apimart.ai/ref-3.png" }]);
    expect(generationBodies[1].prompt).toContain("图2 is the previous clip's last frame");
    expect(generationBodies[1].generation_type).toBe("reference");
    expect(uploads).toHaveLength(3);
    expect(Buffer.from(await uploads[0].arrayBuffer())).toEqual(png);
    expect(saved.clips[1].firstFrameFrom).toBe("arrival");
    for (const clip of saved.clips) {
      expect(clip.endpoint).toBe("apimart");
      expect((await readFile(assetPath(saved.id, clip.video!.path))).length).toBeGreaterThan(0);
      expect((await readFile(assetPath(saved.id, clip.frame!.path))).length).toBeGreaterThan(0);
      const audit = JSON.parse(await readFile(assetPath(saved.id, `requests/${clip.id}-${clip.requestId}.json`), "utf8"));
      expect(audit.provider).toBe("apimart"); expect(audit.workflow).toBeUndefined();
      expect(JSON.stringify(audit)).not.toContain("test-wan-key");
    }
  }, 20000);
  it("uses Wan reference guidance for compiling and retrying, and refreshes only unsubmitted older prompts", async () => {
    const value = await project(); value.settings.provider = "apimart";
    value.references[1].asset = value.references[0].asset;
    value.references[0].audios = [{ path: "voice.wav", name: "voice.wav", bytes: 200, mime: "audio/wav", publicUrl: "https://media.example/voice.wav" }];
    value.clips[0].compiledPrompt = "Old generic prompt";
    value.clips[1].jobId = "already-submitted";
    planning.call.mockResolvedValueOnce({ clips: [{ id: "arrival", prompt: 'One continuous shot. The traveler walks into the station and says: "Hello." Lip sync.' }] });
    const compiled = await compilePrompts(value);
    expect(compiled).toHaveLength(1);
    expect(planning.call.mock.calls[0][1]).toContain(wanReferencePromptGuidance);
    const context = JSON.parse(planning.call.mock.calls[0][2]);
    expect(context.clips[0].providedReferences.map((ref: { role: string }) => ref.role)).toEqual(["location", "character"]);
    expect(context.clips[0].providedAudioReferences).toEqual([{ id: "traveler", name: "Traveler" }]);
    value.clips[0].compiledPrompt = compiled[0].prompt; value.clips[0].promptGuideVersion = wanPromptGuideVersion;
    expect(await compilePrompts(value)).toEqual([]);
    const prompt = finalPrompt(value, value.clips[0]);
    expect(prompt).toContain("setting, spatial layout");
    expect(prompt).toContain("character's identity");
    expect(prompt).toContain("voice timbre");
    expect(prompt).toContain("not the sample's spoken words");
    planning.call.mockResolvedValueOnce({ prompt: 'One continuous shot. The traveler softly says: "Hello."' });
    await reviseClipPrompt(value, "arrival", "Speak softly", "test-model");
    expect(planning.call.mock.calls[1][1]).toContain(wanReferencePromptGuidance);
  });
  it("plans Wan scenes as longer clips while retaining H3's 10-second limit", async () => {
    const longer = { ...structuredClone(plan), clips: [
      { ...plan.clips[0], duration: 18, transition: "first", continuityReason: "Start." },
      { ...plan.clips[1], duration: 12, transition: "continue", continuityReason: "Continuous action." },
    ] };
    planning.call.mockResolvedValue(longer);
    const wan = await analyzeScript("The traveler reads and boards.", "test-model", undefined, "low", "apimart");
    expect(wan.clips).toHaveLength(1); expect(wan.clips[0].duration).toBe(30);
    expect(planning.call.mock.calls[0][1]).toContain("never exceed 30 seconds");
    expect(planning.call.mock.calls[0][1]).toContain(wanReferencePromptGuidance);
    await expect(analyzeScript("Same story", "test-model")).rejects.toThrow("scene plan failed validation");
  });
  it("keeps an automatic Wan video longer than 10 seconds and its planning estimate", async () => {
    const value = await project(false);
    const path = join(root, "long-wan-source.mp4");
    await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", new URL("./fixtures/agent-preview.mp4", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), "-t", "12", "-c", "copy", path], { windowsHide: true, timeout: 30000 });
    const bytes = await readFile(path);
    const source = await writeAsset(value.id, "clips/source.mp4", bytes, "video/mp4", "source.mp4");
    const original = await probeMedia(assetPath(value.id, source.path), new AbortController().signal);
    const output = await finalizeClip(value.id, "wan-auto", source, 5, new AbortController().signal, { maxSeconds: 30, automatic: true });
    expect(output.media.duration).toBeGreaterThan(11.9);
    expect(Math.abs(output.media.duration - original.duration)).toBeLessThan(0.06);
    expect((await readFile(assetPath(value.id, output.frame.path))).length).toBeGreaterThan(0);
    await expect(finalizeClip(value.id, "h3-overlong", source, 12, new AbortController().signal)).rejects.toThrow("2–10");
  }, 20000);
  it("waits for approval before submitting a clip and uses the approved edited text", async () => {
    const value = await project(false);
    await updateProject(value.id, current => { current.reviewBeforeEachClip = true; return current; });
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "approved-job", endpoint: "xnnd4qobofshqz", prompt: input.settings.prompt, status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [{ id: "arrival", prompt: "Prepared static shot." }], submit });
    expect(submit).not.toHaveBeenCalled();
    expect((await getProject(value.id)).clips[0].status).toBe("awaiting-approval");
    const response = await projectRoute(localMutation("agent/project", { projectId: value.id, action: "approvePrompt", clipId: "arrival", prompt: "Static shot. The traveler waves." }));
    expect(response.status).toBe(200);
    await updateProject(value.id, current => { current.settings.steps++; return current; });
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival" }), { compile: async () => [], submit });
    expect(submit).not.toHaveBeenCalled();
    expect((await getProject(value.id)).clips[0].status).toBe("awaiting-approval");
    expect((await projectRoute(localMutation("agent/project", { projectId: value.id, action: "approvePrompt", clipId: "arrival", prompt: "Static shot. The traveler waves." }))).status).toBe(200);
    await executeProject(value.id, await reserveRun(value.id, "test-model", { clipId: "arrival" }), { compile: async () => [], submit });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].settings.prompt).toContain("Static shot. The traveler waves.");
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], submit });
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await getProject(value.id)).clips[1].status).toBe("awaiting-approval");
  }, 15000);
  it("resumes local processing from a retained source without polling or resubmitting", async () => {
    const value = await project(false); const source = await downloadOutput(value.id, "arrival", { video: `data:video/mp4;base64,${video.toString("base64")}` }, new AbortController().signal);
    await updateProject(value.id, current => { current.status = "running"; current.clips = [{ ...current.clips[0], source, status: "saving", requestId: crypto.randomUUID(), jobId: "expired-job" }]; return current; });
    expect(publicProject(await getProject(value.id)).status).toBe("paused");
    const submit = vi.fn(); const check = vi.fn();
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], submit, check });
    expect((await getProject(value.id)).status).toBe("complete"); expect(submit).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  }, 15000);
  it("pauses after an accepted job and resumes that job before submitting the next clip", async () => {
    const value = await project(false); const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "accepted-job", endpoint: "xnnd4qobofshqz", prompt: "Test", status: "IN_QUEUE", createdAt: Date.now() }));
    const controller = await reserveRun(value.id, "test-model");
    const check = vi.fn(async () => { controller.abort(); return { localId: "test", id: "accepted-job", endpoint: "xnnd4qobofshqz", prompt: "Test", status: "IN_PROGRESS", createdAt: Date.now() }; });
    await executeProject(value.id, controller, { compile: async () => [], submit, check, pollMs: 1 });
    const saved = await getProject(value.id); expect(saved.status).toBe("paused"); expect(saved.clips[0].status).toBe("recoverable"); expect(saved.clips[0].jobId).toBe("accepted-job"); expect(saved.clips[1].requestId).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1);
  });
  it("retains short invalid output and stops before the following clip", async () => {
    const value = await project(false); await updateProject(value.id, current => { current.clips[0].duration = 4; return current; });
    const submit = vi.fn(async (input) => ({ localId: input.requestId, id: "short-job", endpoint: "xnnd4qobofshqz", prompt: "Test", status: "COMPLETED", createdAt: Date.now(), output: { video: `data:video/mp4;base64,${video.toString("base64")}` } }));
    await executeProject(value.id, await reserveRun(value.id, "test-model"), { compile: async () => [], submit });
    const saved = await getProject(value.id); expect(saved.status).toBe("paused"); expect(saved.clips[0].status).toBe("recoverable"); expect(saved.clips[0].source).toBeDefined(); expect(saved.clips[0].video).toBeUndefined(); expect(saved.error).toContain("3.00 seconds"); expect(submit).toHaveBeenCalledTimes(1);
  }, 15000);
  it("serves local video byte ranges and rejects traversal and private download addresses", async () => {
    const value = await project(false); const asset = await writeAsset(value.id, "clips/arrival.mp4", video, "video/mp4", "arrival.mp4"); await updateProject(value.id, current => { current.clips[0].video = asset; return current; });
    const url = `http://127.0.0.1:3000/api/agent/media?projectId=${value.id}&kind=video&id=arrival`;
    const result = await mediaRoute(new Request(url, { headers: { Host: "127.0.0.1:3000", Range: "bytes=0-99" } }));
    expect(result.status).toBe(206); expect(result.headers.get("Content-Range")).toBe(`bytes 0-99/${video.length}`); expect(Buffer.from(await result.arrayBuffer())).toEqual(video.subarray(0, 100));
    const invalid = await mediaRoute(new Request(url, { headers: { Host: "127.0.0.1:3000", Range: "bytes=999999999-" } })); expect(invalid.status).toBe(416);
    expect(() => assetPath(value.id, "../../outside")).toThrow("Invalid media path"); expect(() => projectFolder("../outside")).toThrow("Invalid project ID");
    for (const address of ["127.0.0.1", "10.0.0.2", "169.254.169.254", "192.168.1.2", "::1", "fc00::1", "::ffff:127.0.0.1"]) expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
  });
});
