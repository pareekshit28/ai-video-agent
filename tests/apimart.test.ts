import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/lib/store";
import { initialSettings } from "../src/lib/h3";
const memory = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown> }));
vi.mock("../src/lib/store", () => ({ withDatabase: <T>(fn: (db: Database) => T) => { const next = memory.queue.then(() => fn(memory.db)); memory.queue = next.catch(() => undefined); return next; } }));
import { apimartConnectionInfo, checkGeneration, checkWan, saveApimartConnection, submitWan, wanRequest } from "../src/lib/apimart";
import { clipReferenceBudget } from "../src/lib/agent-reference-validation";
import type { AgentProject } from "../src/lib/agent-types";
const input = () => ({ requestId: crypto.randomUUID(), settings: { ...initialSettings, prompt: "<Picture 1> speaks with <Audio 1>.", seed: "42" }, images: [], audios: [] });
beforeEach(() => { memory.db = { apimart: { apiKey: "test-wan-secret" } }; memory.queue = Promise.resolve(); vi.unstubAllGlobals(); });
describe("API Mart Wan 3.0 contract", () => {
  it("accepts 30-second clips and sends automatic duration with natural pacing instructions", () => {
    const value = { ...input(), settings: { ...input().settings, duration: 30, prompt: "0–15s: Walk forward.\n\n15–30s: Read the complete letter aloud." } };
    expect(wanRequest(value, "720P", ["https://media.example/ref.png"], []).duration).toBe(30);
    const automatic = wanRequest(value, "720P", ["https://media.example/ref.png"], [], undefined, true);
    expect(automatic.duration).toBe(-1);
    expect(automatic.prompt).toContain("up to 30 seconds");
    expect(automatic.prompt).not.toContain("0–15s:");
    expect(automatic.prompt).toContain("Read the complete letter aloud");
    expect(() => wanRequest({ ...value, settings: { ...value.settings, duration: 31 } }, "720P", ["https://media.example/ref.png"], [])).toThrow("2 to 30");
  });
  it("maps explicit reference roles, ordered prompt bindings, resolution, and voices", () => {
    expect(wanRequest(input(), "720P", ["https://media.example/person.png"], ["https://media.example/voice.wav"])).toEqual({ model: "wan3.0-video", prompt: "图1 speaks with 音频1.", resolution: "720P", size: "16:9", duration: 5, audio: true, seed: 42, generation_type: "reference", image_with_roles: [{ url: "https://media.example/person.png", role: "reference_image" }], audio_urls: ["https://media.example/voice.wav"] });
    const firstFrame = wanRequest(input(), "480P", [], [], "https://media.example/frame.jpg");
    expect(firstFrame.image_with_roles).toEqual([{ url: "https://media.example/frame.jpg", role: "reference_image" }]);
    expect(firstFrame.generation_type).toBe("reference");
  });
  it("combines continuity references with images and voices, rejecting empty or invalid requests", () => {
    const body = wanRequest(input(), "720P", ["https://media.example/ref.png"], ["https://media.example/voice.wav"], "https://media.example/frame.png");
    expect(body.image_with_roles).toEqual([{ url: "https://media.example/ref.png", role: "reference_image" }, { url: "https://media.example/frame.png", role: "reference_image" }]);
    expect(body.prompt).toContain("图2 is the previous clip's last frame");
    expect(body.audio_urls).toHaveLength(1);
    expect(() => wanRequest(input(), "720P", [], [])).toThrow("requires an image");
    expect(() => wanRequest({ ...input(), settings: { ...input().settings, duration: 2.5 } }, "720P", [], [])).toThrow("whole number");
    expect(() => wanRequest(input(), "720P", ["http://127.0.0.1/ref.png"], [])).toThrow("public HTTPS");
  });
  it("stores credentials without returning them, and retains other provider credentials", async () => {
    memory.db.runpod = { endpoint: "runpod-test", apiKey: "h3-secret" };
    expect(JSON.stringify(await apimartConnectionInfo())).not.toContain("test-wan-secret");
    await saveApimartConnection({ apiKey: "updated-secret" });
    expect(memory.db.runpod.apiKey).toBe("h3-secret");
    expect(memory.db.apimart?.apiKey).toBe("updated-secret");
  });
  it("reserves once for concurrent submissions and resumes through the original provider", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ code: 200, data: [{ task_id: "task_test", status: "submitted" }] })).mockResolvedValueOnce(Response.json({ code: 200, data: { id: "task_test", status: "completed", result: { videos: [{ url: ["https://media.example/video.mp4"] }] } } }));
    vi.stubGlobal("fetch", fetch);
    const value = input(), body = wanRequest(value, "720P", ["https://media.example/ref.png"], []);
    const [a, b] = await Promise.all([submitWan(value, body), submitWan(value, body)]);
    expect(a.localId).toBe(b.localId); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://api.apimart.ai/v1/videos/generations");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    const finished = await checkGeneration("task_test", a.localId);
    expect(finished.status).toBe("COMPLETED");
    expect(fetch.mock.calls[1][0]).toBe("https://api.apimart.ai/v1/tasks/task_test?language=en");
  });
  it("keeps lost paid submissions uncertain until a task ID is recovered", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Lost response")); vi.stubGlobal("fetch", fetch);
    const value = input(), body = wanRequest(value, "720P", ["https://media.example/ref.png"], []);
    expect((await submitWan(value, body)).status).toBe("SUBMISSION_UNKNOWN");
    await submitWan(value, body); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(submitWan(input(), body)).rejects.toThrow("needs recovery");
    fetch.mockResolvedValue(Response.json({ code: 200, data: { id: "recovered-task", status: "processing" } }));
    expect((await checkWan("recovered-task", value.requestId)).status).toBe("IN_PROGRESS");
    await expect(checkWan("different-task", value.requestId)).rejects.toThrow("differs");
  });
  it("validates Wan references independently of H3's inline 6 MB budget", () => {
    const clip = { id: "one", title: "One", prompt: "Scene", duration: 5, referenceIds: ["location"], continuation: false, status: "pending" as const };
    const project = { settings: { provider: "apimart" }, clips: [clip], references: [{ id: "location", asset: { path: "place.png", bytes: 8_000_000 } }] } as unknown as AgentProject;
    expect(clipReferenceBudget(project, clip).error).toBe("");
    project.references[0].audios = [{ path: "voice.wav", name: "voice.wav", bytes: 400, mime: "audio/wav" }];
    expect(clipReferenceBudget(project, clip).error).toContain("public HTTPS voice URL");
  });
});
