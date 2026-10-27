import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSubmissionSchema, buildPayload, initialSettings, mediaFrom, submissionSchema } from "../src/lib/h3";
import sourceWorkflow from "../workflows/minimax_h3_motion_context.json";
import { defaultGeneration } from "../src/lib/agent-types";
import type { Database } from "../src/lib/store";
const memory = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown> }));
vi.mock("../src/lib/store", () => ({ withDatabase: <T>(action: (db: Database) => T) => { const next = memory.queue.then(() => action(memory.db)); memory.queue = next.catch(() => undefined); return next; } }));
import { checkVideo, connectionInfo, jobHistory, readJson, resolveUnknown, saveConnection, submitAgentVideo, submitVideo } from "../src/lib/runpod";

const settings = { ...initialSettings, prompt: "<Picture 1> walks and speaks with <Audio 1>.", seed: "123" };
const reference = { name: "portrait.png", base64: "YWJjZA==", bytes: 4 };
function input(requestId = crypto.randomUUID()) { return { requestId, settings, images: [reference], audios: [] }; }
beforeEach(() => { memory.db = { runpod: { endpoint: "xnnd4qobofshqz", apiKey: "secret-test-key" } }; memory.queue = Promise.resolve(); vi.unstubAllGlobals(); });

const context = { clipId: "f01aaeed-aaaa-4aaa-8aaa-111111111111", previousClipId: "f01aaeed-aaaa-4aaa-8aaa-222222222222" };
describe("H3 motion-context worker contract", () => {
  it("preserves the attached model chain, widgets and graph connections", () => {
    const graph = buildPayload(initialSettings, [], [], context).input.workflow;
    expect(Object.keys(graph)).toHaveLength(sourceWorkflow.nodes.length);
    for (const node of sourceWorkflow.nodes) {
      const expected: Record<string, unknown> = { ...node.widgets_values_named };
      delete expected.control_after_generate;
      for (const input of node.inputs) {
        if (input.link == null) continue;
        const link = sourceWorkflow.links.find(link => link[0] === input.link)!;
        expected[input.name] = [String(link[1]), link[2]];
      }
      if (node.id === 115) expected.megapixels = 2;
      if (node.id === 138) expected.value = "";
      if (node.id === 131) expected.expression = String(expected.expression).replaceAll("a * 24", "(a * 24 + 22)");
      if (node.id === 158) expected.clip_id = context.previousClipId;
      if (node.id === 159) expected.clip_id = context.clipId;
      expect(graph[String(node.id)].class_type).toBe(node.type);
      expect(graph[String(node.id)].inputs).toEqual(expected);
    }
    expect(graph["141"].class_type).toBe("LoraLoaderModelOnly");
    expect(graph["124"].inputs.model).toEqual(["149", 0]);
    expect(graph["126"].inputs.conditioning).toEqual(["160", 0]);
    expect(graph["159"].inputs.latent).toEqual(["125", 0]);
    expect(graph["160"].inputs.context_latent).toEqual(["158", 0]);
    expect(graph["130"].inputs.images).toEqual(["161", 0]);
    expect(graph["130"].inputs.audio).toEqual(["161", 1]);
  });
  it("defaults new jobs and projects to 2 MP and 6 sampling steps", () => {
    expect(initialSettings).toMatchObject({ duration: 5, megapixels: 2, steps: 6, seed: "158062420567623", refImageSize: "max" });
    expect(defaultGeneration).toMatchObject({ megapixels: 2, steps: 6, refImageSize: "max" });
  });
  it("accepts ten-second clips and rejects longer requests and invalid UUIDs", () => {
    expect(agentSubmissionSchema.safeParse({ ...input(), settings: { ...settings, duration: 10 } }).success).toBe(true);
    for (const value of [{ ...input(), settings: { ...settings, duration: 10.5 } }, { ...input(), previousClipId: "not-a-uuid" }]) expect(agentSubmissionSchema.safeParse(value).success).toBe(false);
  });
  it("keeps the empty load node connected for fresh shots and never uploads a continuity frame", () => {
    const payload = buildPayload(settings, [reference], [], { clipId: context.clipId });
    expect(payload.input.workflow["158"].inputs).toMatchObject({ clip_id: "", clip_index: 0 });
    expect(payload.input.workflow["160"].inputs.context_latent).toEqual(["158", 0]);
    expect(payload.input.workflow["159"].inputs.clip_id).toBe(context.clipId);
    expect(Object.values(payload.input.workflow).some(node => node.class_type === "MiniMaxH3AddGuide")).toBe(false);
    expect(payload.input.images).toHaveLength(1);
  });
  it("binds image/audio uploads without colliding with motion-context nodes and applies overrides", () => {
    const payload = buildPayload({ ...settings, duration: 7.5, steps: 12 }, [reference], [{ ...reference, name: "voice.wav" }], context);
    expect(payload.input.images).toEqual([{ name: "reference-image-1.png", image: reference.base64 }, { name: "reference-audio-1.wav", image: reference.base64 }]);
    const graph = payload.input.workflow;
    expect(graph["136"].inputs["ref_images.ref_image_0"]).toEqual(["162", 0]);
    expect(graph["136"].inputs["ref_audios.ref_audio_0"]).toEqual(["163", 0]);
    expect(graph["132"].inputs.value).toBe(7.5);
    expect(graph["124"].inputs).toMatchObject({ scheduler: "beta", steps: 12 });
    expect(graph["129"].inputs.noise_seed).toBe(123);
    expect(graph["130"].inputs.fps).toBe(24);
    expect(graph["131"].inputs.expression).toContain("% 17");
    expect(graph["131"].inputs.expression).toContain("a * 24 + 22");
    expect(buildPayload(settings, [], [], { clipId: context.clipId }).input.workflow["131"].inputs.expression).not.toContain("+ 22");
    expect(buildPayload({ ...settings, prompt: "Next" }, [], [], context).input.workflow["138"].inputs.value).toBe("Next");
    expect(graph["138"].inputs.value).toBe(settings.prompt);
  });
  it("rejects missing refs, forged sizes, excess uploads and invalid generation ranges", () => {
    expect(submissionSchema.safeParse(input()).success).toBe(true);
    for (const invalid of [{ ...input(), images: [] }, { ...input(), images: Array(10).fill(reference) }, { ...input(), images: [{ ...reference, bytes: 1 }] }, { ...input(), settings: { ...settings, seed: "1.5" } }, { ...input(), settings: { ...settings, duration: 11 } }, { ...input(), settings: { ...settings, megapixels: 0 } }]) expect(submissionSchema.safeParse(invalid).success).toBe(false);
  });
  it("recognizes video outputs and filters unsafe URLs", () => {
    expect(mediaFrom({ videos: [{ url: "https://media.example/clip.mp4" }], evil: "javascript:alert(1)", video: "data:video/mp4;base64,YWJjZA==" })).toEqual(["https://media.example/clip.mp4", "data:video/mp4;base64,YWJjZA=="]);
    expect(mediaFrom({ video: "https://user:password@example.test/clip.mp4" })).toEqual([]);
  });
});
describe("RunPod submission and recovery", () => {
  it("posts UUID save/load inputs in Studio and agent requests", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "job_123", status: "IN_QUEUE" })); vi.stubGlobal("fetch", fetch);
    const audio = { ...reference, name: "voice.wav" };
    const studioInput = { ...input(), audios: [audio], firstFrame: undefined };
    await submitVideo(studioInput);
    const previousClipId = context.previousClipId;
    const agentInput = { ...input(), settings: { ...settings, duration: 10 }, audios: [audio], previousClipId };
    await submitAgentVideo(agentInput);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, submission] of [studioInput, agentInput].entries()) {
      const [url, request] = fetch.mock.calls[index];
      expect(url).toBe("https://api.runpod.ai/v2/xnnd4qobofshqz/run");
      expect(request.method).toBe("POST");
      const payload = JSON.parse(request.body);
      expect(payload).toEqual(buildPayload(submission.settings, submission.images, submission.audios, { clipId: submission.requestId, previousClipId: "previousClipId" in submission ? submission.previousClipId : undefined }));
      expect(payload.input.workflow["124"].inputs.scheduler).toBe("beta");
      expect(Object.values(payload.input.workflow).some(node => (node as { class_type: string }).class_type === "BlockSparseAttention")).toBe(false);
      expect(payload.input.workflow["124"].inputs.model).toEqual(["149", 0]);
      expect(payload.input.workflow["126"].inputs.model).toEqual(["149", 0]);
      for (const id of ["158", "159", "160", "161"]) {
        expect(payload.input.workflow[id]._meta).toMatchObject({ aux_id: "pareekshit28/ComfyUI-H3-Motion-Context", ver: "5d3ed39587009f70bff16284d524d1129a60393f" });
        expect(payload.input.workflow[id]._meta).not.toHaveProperty("cnr_id");
      }
    }
  });
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
