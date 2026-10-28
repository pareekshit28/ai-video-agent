import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { Database } from "../src/lib/store";
const memory = vi.hoisted(() => ({ db: {} as Database, queue: Promise.resolve() as Promise<unknown> }));
const transfers = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("../src/lib/store", () => ({ withDatabase: <T>(action: (db: Database) => T) => { const next = memory.queue.then(() => action(memory.db)); memory.queue = next.catch(() => undefined); return next; } }));
vi.mock("../src/lib/agent-media", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/agent-media")>(), downloadBinaryFile: transfers.download }));
import { comfyCloudUrlSchema, DEFAULT_COMFY_CLOUD_URL } from "../src/lib/comfy-cloud-endpoint";
import { initialSettings, buildPayload, type Workflow } from "../src/lib/h3";
import template from "../src/lib/comfy-cloud-workflow.json";
import source from "../workflows/minimax_h3_comfy_cloud.json";
import { buildComfyCloudWorkflow, type CloudAssetReference } from "../src/lib/comfy-cloud-workflow";
import { assertComfyCloudWorkflowSupport, checkComfyCloud, comfyCloudConnectionInfo, prepareComfyCloudRequest, saveComfyCloudConnection, saveComfyCloudLatent, submitComfyCloud, validateLatent } from "../src/lib/comfy-cloud";
import { checkGeneration, submitGeneration } from "../src/lib/apimart";
import { assetPath, createProject, getProject } from "../src/lib/agent-store";
import { defaultGeneration, type AgentProject } from "../src/lib/agent-types";
import { GET as cloudSettings, POST as saveCloudSettings } from "../src/app/api/comfy-cloud/settings/route";

const id = "f01aaeed-aaaa-4aaa-8aaa-111111111111", previousId = "f01aaeed-aaaa-4aaa-8aaa-222222222222";
const deploymentUrl = "https://dep-4bcaff52-e1a6-4372-b23a-3e0c126ace00.run.comfy.app";
const input = () => ({ requestId: id, clipId: id, settings: { ...initialSettings, prompt: "The traveler walks.", seed: "42" }, images: [], audios: [] });
const reference = (name: string) => ({ name, bytes: 4, base64: "YWJjZA==" });
const asset = (id: string, file_path: string): CloudAssetReference => ({ __type: "core/ASSET", info: { id, file_path } });
const output = (kind: "video" | "latent") => ({ id: `asset-${kind}`, node_id: kind === "video" ? "92" : "159", name: kind === "video" ? "clip.mp4" : `${id}.safetensors`, type: kind, content_type: kind === "video" ? "video/mp4" : "application/octet-stream", size_bytes: 200, url: `https://outputs.example/${kind}` });
const cloudJob = (status = "queued") => ({ id: "cloud-job", status, outputs: status === "succeeded" ? [output("latent"), output("video")] : [], urls: { self: "/api/v2/jobs/cloud-job" }, metrics: { queue_ms: 100, execution_ms: 2000 } });
function definitions() {
  const result: Record<string, { input: { required: Record<string, unknown[]> } }> = {};
  for (const node of [...Object.values(template), { class_type: "LoadImage", inputs: {} }, { class_type: "LoadAudio", inputs: {} }]) {
    const inputs = (result[node.class_type] ??= { input: { required: {} } }).input.required;
    for (const [name, value] of Object.entries(node.inputs)) {
      if (name.endsWith("_name")) inputs[name] = [[...(inputs[name]?.[0] as unknown[] || []), value]];
      else inputs[name] = ["STRING", {}];
    }
  }
  return result;
}
function latentBytes() {
  let header = JSON.stringify({ video: { dtype: "F32", shape: [1], data_offsets: [0, 4] }, audio: { dtype: "F32", shape: [1], data_offsets: [4, 8] } });
  header = header.padEnd(Math.ceil(header.length / 8) * 8, " ");
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([size, Buffer.from(header), Buffer.alloc(8)]);
}
let root: string;
async function project() {
  const value: AgentProject = { id: crypto.randomUUID(), title: "Cloud scene", script: "The traveler walks.", summary: "A journey.", model: "test-model", status: "ready", createdAt: Date.now(), updatedAt: Date.now(), settings: { ...defaultGeneration, provider: "comfy-cloud" }, references: [], clips: [] };
  return createProject(value);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "video-agent-cloud-tests-"));
  vi.stubEnv("VIDEO_OUTPUT_DIR", root); vi.stubEnv("AGENT_STORAGE_DIR", join(root, "settings")); vi.stubEnv("COMFY_CLOUD_API_KEY", ""); vi.stubEnv("COMFY_CLOUD_BASE_URL", "");
  memory.db = { comfyCloud: { apiKey: "cloud-test-secret" }, runpod: { endpoint: "runpod-test", apiKey: "runpod-test-secret" } }; memory.queue = Promise.resolve();
  transfers.download.mockReset();
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel.startsWith("video-agent-cloud-tests-") && !isAbsolute(rel) && !rel.includes("..")) await rm(root, { recursive: true, force: true });
});

describe("Comfy Cloud workflow and file continuity", () => {
  it("matches the attached cloud source graph and preserves the independent RunPod workflow", () => {
    const graph = buildComfyCloudWorkflow(initialSettings, [], [], { clipId: id }, new Map());
    for (const node of source.nodes) {
      const expected: Record<string, unknown> = { ...node.widgets_values_named }; delete expected.control_after_generate;
      for (const input of node.inputs) if (input.link != null) { const link = source.links.find(link => link[0] === input.link)!; expected[input.name] = [String(link[1]), link[2]]; }
      if (node.id === 115) expected.megapixels = initialSettings.megapixels;
      if (node.id === 159) expected.clip_id = id;
      expect(graph[String(node.id)].inputs).toEqual(expected);
    }
    expect(graph["158"].inputs).toMatchObject({ storage_root: "", folder: "input", clip_index: 0, clip_id: "" });
    expect(JSON.stringify(graph)).not.toContain("/runpod-volume");
    expect(buildPayload(initialSettings, [], [], { clipId: id }).input.workflow["159"].inputs.storage_root).toBe("/runpod-volume/h3_latents");
  });
  it("binds uploaded references and the exact preceding AV latent and reserves the trimmed context frames", () => {
    const uploads = new Map([["reference-image-1.png", asset("image", "reference-image-1.png")], ["reference-audio-1.wav", asset("voice", "reference-audio-1.wav")]]);
    const latent = asset("latent-upload", "prior.safetensors");
    const graph = buildComfyCloudWorkflow(initialSettings, [reference("person.png")], [reference("voice.wav")], { clipId: id, previousClipId: previousId }, uploads, latent);
    expect(graph["158"].inputs).toMatchObject({ latent_path: latent, storage_root: "", clip_id: "", clip_index: 1, folder: "input", stock_format: false });
    expect(graph["131"].inputs.expression).toContain("a * 24 + 22");
    expect(graph["162"].inputs.image).toEqual(uploads.get("reference-image-1.png"));
    expect(graph["163"].inputs.audio).toEqual(uploads.get("reference-audio-1.wav"));
    expect(() => buildComfyCloudWorkflow(initialSettings, [], [], { clipId: id, previousClipId: previousId }, new Map())).toThrow("Upload the preceding");
  });
  it("uploads locally retained latent bytes for the next worker instead of reusing a volume path", async () => {
    const value = await project(); const path = "clips/previous.safetensors";
    await writeFile(assetPath(value.id, path), latentBytes());
    const previousLatent = { path, name: "previous.safetensors", mime: "application/octet-stream", bytes: latentBytes().length };
    const fetch = vi.fn(async (url, options) => {
      if (String(url).endsWith("/api/object_info")) return Response.json(definitions());
      const form = options.body as FormData;
      expect([...form.keys()]).toEqual(["file_path", "content_type", "tags", "file"]);
      expect(options.headers.Authorization).toBe("Bearer cloud-test-secret");
      expect(form.get("file_path")).toBe(`h3-${previousId}.safetensors`);
      expect(Buffer.from(await (form.get("file") as Blob).arrayBuffer())).toEqual(latentBytes());
      return Response.json({ id: "uploaded-latent", file_path: form.get("file_path"), hash: "blake3:abc" });
    }); vi.stubGlobal("fetch", fetch);
    const { workflow } = await prepareComfyCloudRequest(value, { ...input(), previousClipId: previousId, previousLatent });
    expect(workflow["158"].inputs.latent_path).toMatchObject({ __type: "core/ASSET", info: { id: "uploaded-latent" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(workflow)).not.toContain("cloud-test-secret");
  });
  it("stops before uploads or paid submissions when Cloud lacks the required nodes or models", async () => {
    const missing = definitions(); delete missing.MiniMaxH3MotionContext;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(missing)); vi.stubGlobal("fetch", fetch);
    await expect(prepareComfyCloudRequest(await project(), input())).rejects.toMatchObject({ code: "comfy_cloud_nodes_missing" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const models = definitions(); models.UNETLoader.input.required.unet_name = [["other-model.safetensors"]];
    fetch.mockResolvedValueOnce(Response.json(models));
    await expect(assertComfyCloudWorkflowSupport()).rejects.toMatchObject({ code: "comfy_cloud_model_missing" });
  });
  it("downloads the safetensors output to the scene and verifies both streams", async () => {
    const value = await project();
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "asset-latent", url: "https://outputs.example/fresh-latent" })); vi.stubGlobal("fetch", fetch);
    transfers.download.mockImplementation(async (url, path) => { expect(url).toBe("https://outputs.example/fresh-latent"); await writeFile(path, latentBytes()); return latentBytes().length; });
    const saved = await saveComfyCloudLatent(value.id, "arrival-take1", { comfyCloud: { outputs: [output("video"), output("latent")] } }, new AbortController().signal);
    expect(saved.path).toBe("latents/arrival-take1.safetensors");
    expect(await readFile(assetPath(value.id, saved.path))).toEqual(latentBytes());
    expect(await validateLatent(assetPath(value.id, saved.path))).toBe(saved.bytes);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer cloud-test-secret");
    expect(transfers.download.mock.calls[0]).toHaveLength(4); // Signed download receives no API key.
    await writeFile(assetPath(value.id, saved.path), Buffer.from("invalid latent"));
    await expect(validateLatent(assetPath(value.id, saved.path))).rejects.toMatchObject({ code: "invalid_latent" });
  });
  it("requires the motion-context output and cannot mistake a video or another node's file for its latent", async () => {
    const value = await project();
    await expect(saveComfyCloudLatent(value.id, "arrival", { comfyCloud: { outputs: [output("video"), { ...output("latent"), node_id: "other" }] } }, new AbortController().signal)).rejects.toMatchObject({ code: "latent_output_missing" });
    expect(transfers.download).not.toHaveBeenCalled();
  });
});

describe("Comfy Cloud paid submissions, recovery and credentials", () => {
  it("validates and normalizes deployment URLs without accepting unrelated credential destinations", async () => {
    expect(comfyCloudUrlSchema.parse(` ${deploymentUrl}/ `)).toBe(deploymentUrl);
    for (const value of ["http://cloud.comfy.org", "https://127.0.0.1", "https://cloud.comfy.org.evil.example", `${deploymentUrl}/api/v2/jobs`, `${deploymentUrl}?key=secret`, `${deploymentUrl}#fragment`, "https://user:password@cloud.comfy.org", "https://cloud.comfy.org:444", "https://other.example"]) {
      expect((await saveCloudSettings(new Request("http://127.0.0.1:3000/api/comfy-cloud/settings", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: value }) }))).status).toBe(400);
    }
    expect(memory.db.comfyCloud?.baseUrl).toBeUndefined();
    await saveComfyCloudConnection({ baseUrl: `${deploymentUrl}/` });
    expect(memory.db.comfyCloud).toMatchObject({ baseUrl: deploymentUrl, apiKey: "cloud-test-secret" });
    await saveComfyCloudConnection({ apiKey: "new-key" });
    expect((await comfyCloudConnectionInfo()).baseUrl).toBe(deploymentUrl);
  });
  it("supports environment URL defaults while giving the saved UI setting precedence", async () => {
    vi.stubEnv("COMFY_CLOUD_BASE_URL", deploymentUrl);
    expect((await comfyCloudConnectionInfo()).baseUrl).toBe(deploymentUrl);
    await saveComfyCloudConnection({ baseUrl: DEFAULT_COMFY_CLOUD_URL });
    expect((await comfyCloudConnectionInfo()).baseUrl).toBe(DEFAULT_COMFY_CLOUD_URL);
  });
  it("pins uploads, submission, recovery and latent asset downloads to the original deployment", async () => {
    await saveComfyCloudConnection({ baseUrl: deploymentUrl });
    const value = await project();
    const fetch = vi.fn(async (url, options) => {
      const target = String(url);
      if (options?.method === "POST" && target.endsWith("/api/v2/assets")) return Response.json({ id: "uploaded-image", file_path: "person.png" });
      if (options?.method === "POST" && target.endsWith("/api/v2/jobs")) return Response.json(cloudJob());
      if (target.endsWith("/api/v2/jobs/cloud-job")) return Response.json(cloudJob("succeeded"));
      if (target.endsWith("/api/v2/assets/asset-latent")) return Response.json({ id: "asset-latent", url: "https://outputs.example/fresh-latent" });
      throw new Error(`Unexpected API request: ${target}`);
    }); vi.stubGlobal("fetch", fetch);
    const prepared = await prepareComfyCloudRequest(value, { ...input(), images: [reference("person.png")] });
    expect(prepared.baseUrl).toBe(deploymentUrl);
    // A settings change between preparation and submission cannot mix uploaded asset namespaces.
    await saveComfyCloudConnection({ baseUrl: "https://dep-another.run.comfy.app" });
    const job = await submitGeneration({ ...input(), cloudWorkflow: prepared.workflow, cloudBaseUrl: prepared.baseUrl }, "comfy-cloud");
    expect(job).toMatchObject({ baseUrl: deploymentUrl, statusUrl: `${deploymentUrl}/api/v2/jobs/cloud-job` });
    const finished = await checkComfyCloud("cloud-job", id);
    transfers.download.mockImplementation(async (_url, path) => { await writeFile(path, latentBytes()); return latentBytes().length; });
    await saveComfyCloudLatent(value.id, "saved-deployment-latent", finished.output, new AbortController().signal);
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual([`${deploymentUrl}/api/v2/assets`, `${deploymentUrl}/api/v2/jobs`, `${deploymentUrl}/api/v2/jobs/cloud-job`, `${deploymentUrl}/api/v2/assets/asset-latent`]);
    expect(fetch.mock.calls.every(call => call[1].headers.Authorization === "Bearer cloud-test-secret")).toBe(true);
  });
  it("recovers older hosted Cloud jobs from their original URL after configuring a deployment", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(cloudJob())).mockResolvedValueOnce(Response.json(cloudJob("succeeded"))); vi.stubGlobal("fetch", fetch);
    await submitComfyCloud(input(), template);
    delete memory.db.h3Jobs![0].baseUrl;
    await saveComfyCloudConnection({ baseUrl: deploymentUrl });
    expect((await checkComfyCloud("cloud-job", id)).status).toBe("COMPLETED");
    expect(String(fetch.mock.calls[1][0])).toBe("https://cloud.comfy.org/api/v2/jobs/cloud-job");
  });
  it("reserves once, sends the single-use idempotency key and follows the saved job link", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(cloudJob())).mockResolvedValueOnce(Response.json(cloudJob("succeeded"))); vi.stubGlobal("fetch", fetch);
    const workflow = template as Workflow;
    const [a, b] = await Promise.all([submitGeneration({ ...input(), cloudWorkflow: workflow }, "comfy-cloud"), submitComfyCloud(input(), workflow)]);
    expect(a.localId).toBe(b.localId); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://cloud.comfy.org/api/v2/jobs");
    expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(id);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ workflow });
    const saved = await checkGeneration("cloud-job", id);
    expect(saved).toMatchObject({ endpoint: "comfy-cloud", status: "COMPLETED", delayTime: 100, executionTime: 2000, output: { video: "https://outputs.example/video" } });
    expect(String(fetch.mock.calls[1][0])).toBe("https://cloud.comfy.org/api/v2/jobs/cloud-job");
  });
  it("keeps a lost paid response blocked and recovers by job ID without resubmission", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(Response.json(cloudJob("succeeded"))); vi.stubGlobal("fetch", fetch);
    expect((await submitComfyCloud(input(), template)).status).toBe("SUBMISSION_UNKNOWN");
    await expect(submitComfyCloud({ ...input(), requestId: crypto.randomUUID() }, template)).rejects.toMatchObject({ code: "submission_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await checkComfyCloud("cloud-job", id)).status).toBe("COMPLETED");
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(checkComfyCloud("different-job", id)).rejects.toMatchObject({ code: "invalid_job_id" });
  });
  it("treats a reused idempotency key as an uncertain existing job rather than a rejected new job", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "idempotency_key_reuse" } }, { status: 422 })));
    expect((await submitComfyCloud(input(), template)).status).toBe("SUBMISSION_UNKNOWN");
    await expect(submitComfyCloud({ ...input(), requestId: crypto.randomUUID() }, template)).rejects.toMatchObject({ code: "submission_unknown" });
  });
  it("refuses a provider job link that could leak its key and retains the uncertain job", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...cloudJob(), urls: { self: "https://elsewhere.example/steal-key" } })));
    expect((await submitComfyCloud(input(), template)).status).toBe("SUBMISSION_UNKNOWN");
    expect(memory.db.h3Jobs![0].statusUrl).toBeUndefined();
  });
  it("keeps credentials separate, redacts them from settings and enforces local settings requests", async () => {
    expect(await saveComfyCloudConnection({ apiKey: "updated-cloud-secret" })).toEqual({ baseUrl: DEFAULT_COMFY_CLOUD_URL, configured: true, environmentKey: false });
    expect(memory.db.runpod?.apiKey).toBe("runpod-test-secret");
    expect(JSON.stringify(await comfyCloudConnectionInfo())).not.toContain("secret");
    await saveComfyCloudConnection({ clearKey: true }); vi.stubEnv("COMFY_CLOUD_API_KEY", "environment-secret");
    expect(await comfyCloudConnectionInfo()).toEqual({ baseUrl: DEFAULT_COMFY_CLOUD_URL, configured: true, environmentKey: true });
    const headers = { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" };
    expect((await cloudSettings(new Request("http://127.0.0.1:3000/api/comfy-cloud/settings", { headers }))).status).toBe(200);
    expect((await saveCloudSettings(new Request("http://127.0.0.1:3000/api/comfy-cloud/settings", { method: "POST", headers: { ...headers, Origin: "https://external.example" }, body: "{}" }))).status).toBe(400);
    expect(memory.db.comfyCloud?.apiKey).toBeUndefined();
  });
});
