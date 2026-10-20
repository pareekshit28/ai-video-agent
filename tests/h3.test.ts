import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPayload, initialSettings, mediaFrom, submissionSchema } from "../src/lib/h3";
import type { Database } from "../src/lib/store";
const memory = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown> }));
vi.mock("../src/lib/store", () => ({ withDatabase: <T>(action: (db: Database) => T) => { const next = memory.queue.then(() => action(memory.db)); memory.queue = next.catch(() => undefined); return next; } }));
import { checkVideo, connectionInfo, jobHistory, readJson, resolveUnknown, saveConnection, submitVideo } from "../src/lib/runpod";

const settings = { ...initialSettings, prompt: "<Picture 1> walks and speaks with <Audio 1>.", seed: "123" };
const reference = { name: "portrait.png", base64: "YWJjZA==", bytes: 4 };
function input(requestId = crypto.randomUUID()) { return { requestId, settings, images: [reference], audios: [] }; }
beforeEach(() => { memory.db = { runpod: { endpoint: "xnnd4qobofshqz", apiKey: "secret-test-key" } }; memory.queue = Promise.resolve(); vi.unstubAllGlobals(); });

describe("original H3 worker contract", () => {
  it("connects conditioning and video directly without unload nodes, including continuation clips", () => {
    const graph = buildPayload(settings, [reference], []).input.workflow;
    expect(Object.values(graph).some(node => node.class_type === "UnloadAllModels")).toBe(false);
    expect(graph["126"].inputs.conditioning).toEqual(["136", 0]);
    expect(graph["92"].inputs.video).toEqual(["130", 0]);
    const continuation = buildPayload(settings, [reference], [], { ...reference, name: "last-frame.png" }).input.workflow;
    expect(Object.values(continuation).some(node => node.class_type === "UnloadAllModels")).toBe(false);
    expect(continuation["126"].inputs.conditioning).toEqual(["agent_frame_guide", 0]);
    expect(continuation["92"].inputs.video).toEqual(["130", 0]);
  });
  it("preserves the model, reference sockets, audio transport, fps and frame snapping graph", () => {
    const payload = buildPayload(settings, [reference], [{ ...reference, name: "voice.wav" }]);
    expect(payload.input.images).toEqual([{ name: "reference-image-1.png", image: reference.base64 }, { name: "reference-audio-1.wav", image: reference.base64 }]);
    const graph = payload.input.workflow;
    expect(graph["136"].class_type).toBe("MiniMaxH3ReferenceToVideo");
    expect(graph["136"].inputs["ref_images.ref_image_0"]).toEqual(["150", 0]);
    expect(graph["136"].inputs["ref_audios.ref_audio_0"]).toEqual(["151", 0]);
    expect(graph["151"].class_type).toBe("LoadAudio");
    expect(graph["129"].inputs.noise_seed).toBe(123);
    expect(graph["130"].inputs.fps).toBe(24);
    expect(graph["131"].inputs.expression).toContain("% 17");
    expect(graph["127"].inputs.unet_name).toBe("Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors");
    expect(buildPayload({ ...settings, prompt: "Next" }, [], []).input.workflow["138"].inputs.value).toBe("Next");
    expect(graph["138"].inputs.value).toBe(settings.prompt);
  });
  it("rejects missing refs, excess uploads, forged sizes, invalid seeds and generation ranges", () => {
    expect(submissionSchema.safeParse(input()).success).toBe(true);
    for (const invalid of [{ ...input(), images: [] }, { ...input(), images: Array(10).fill(reference) }, { ...input(), images: [{ ...reference, bytes: 1 }] }, { ...input(), settings: { ...settings, seed: "1.5" } }, { ...input(), settings: { ...settings, duration: 16 } }, { ...input(), settings: { ...settings, megapixels: 0 } }]) expect(submissionSchema.safeParse(invalid).success).toBe(false);
  });
  it("recognizes nested video URL and inline outputs, filters unsafe schemes, and redacts large data", () => {
    expect(mediaFrom({ videos: [{ url: "https://media.example/clip.mp4" }], evil: "javascript:alert(1)", video: "data:video/mp4;base64,YWJjZA==" })).toEqual(["https://media.example/clip.mp4", "data:video/mp4;base64,YWJjZA=="]);
    expect(mediaFrom({ video: "https://user:password@example.test/clip.mp4" })).toEqual([]);
  });
});
describe("RunPod submission and recovery", () => {
  it("uses only the fixed API host and never returns the configured secret", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "job_123", status: "IN_QUEUE" })); vi.stubGlobal("fetch", fetch);
    const job = await submitVideo(input());
    expect(fetch.mock.calls[0][0]).toBe("https://api.runpod.ai/v2/xnnd4qobofshqz/run");
    expect(JSON.stringify(await connectionInfo())).not.toContain("secret-test-key");
    expect(JSON.stringify(job)).not.toContain("secret-test-key");
    await expect(saveConnection({ endpoint: "https://attacker.test", apiKey: "abc" })).rejects.toThrow();
  });
  it("reserves once even for concurrent requests or a network failure, and blocks a fresh retry", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("Network failure")); vi.stubGlobal("fetch", fetch);
    const submission = input();
    await Promise.all([submitVideo(submission), submitVideo(submission)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await jobHistory())[0].status).toBe("SUBMISSION_UNKNOWN");
    await expect(submitVideo(input())).rejects.toThrow("reconciliation");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost job ID without another submission and retains the original endpoint", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(Response.json({ id: "recovered-job", status: "COMPLETED", output: { video: "https://media.example/final.mp4" }, executionTime: 900 })); vi.stubGlobal("fetch", fetch);
    const unknown = await submitVideo(input());
    await saveConnection({ endpoint: "changed-endpoint" });
    const recovered = await checkVideo("recovered-job", unknown.localId);
    expect(fetch.mock.calls[1][0]).toBe("https://api.runpod.ai/v2/xnnd4qobofshqz/status/recovered-job");
    expect(recovered.status).toBe("COMPLETED");
    expect(recovered.executionTime).toBe(900);
    expect((await jobHistory())).toHaveLength(1);
    await expect(checkVideo("different-job", recovered.localId)).rejects.toThrow("differs");
  });
  it("keeps uncertain provider errors blocked and supports explicit manual resolution", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failure", { status: 500 })));
    const unknown = await submitVideo(input()); expect(unknown.status).toBe("SUBMISSION_UNKNOWN");
    await resolveUnknown(unknown.localId);
    expect((await jobHistory())[0].status).toBe("REJECTED");
  });
  it("rejects oversized streamed bodies before forwarding, even without Content-Length", async () => {
    const request = new Request("http://127.0.0.1", { method: "POST", headers: { "Content-Type": "application/json" }, body: "12345" });
    await expect(readJson(request, 4)).rejects.toThrow("size limit");
  });
});
