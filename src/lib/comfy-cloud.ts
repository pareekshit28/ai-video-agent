import { z } from "zod";
import { comfyCloudUrlSchema, DEFAULT_COMFY_CLOUD_URL } from "./comfy-cloud-endpoint";
import { openAsBlob } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { withDatabase } from "./store";
import { assetPath, projectFolder } from "./agent-store";
import { agentSubmissionSchema, buildPayload, type H3Job, type Workflow } from "./h3";
import { type AgentProject, type Asset } from "./agent-types";
import { buildComfyCloudWorkflow, type CloudAssetReference } from "./comfy-cloud-workflow";
import template from "./comfy-cloud-workflow.json";
import { downloadBinaryFile, downloadOutput } from "./agent-media";
import { getCollection } from "./project-collections";
import { RequestError } from "./request-error";


const keySchema = z.string().trim().min(1).max(2048).regex(/^\S+$/);
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const MAX_LATENT_BYTES = 190 * 1024 * 1024; // Leave multipart overhead below Cloud's 200 MB request cap.
export type ComfyCloudInput = z.infer<typeof agentSubmissionSchema> & { previousLatent?: Asset };
const outputSchema = z.object({ id: idSchema, node_id: z.string(), name: z.string(), type: z.string(), content_type: z.string(), size_bytes: z.number().nonnegative(), url: z.string() });
type CloudOutput = z.infer<typeof outputSchema>;
const cloudJobSchema = z.object({ id: idSchema, status: z.enum(["queued", "running", "succeeded", "canceling", "canceled", "failed", "expired"]), outputs: z.array(outputSchema).max(100), urls: z.object({ self: z.string() }), metrics: z.record(z.string(), z.number().nullable()).optional(), error: z.unknown().optional() });
const statuses = { queued: "IN_QUEUE", running: "IN_PROGRESS", succeeded: "COMPLETED", canceling: "IN_PROGRESS", canceled: "CANCELLED", failed: "FAILED", expired: "TIMED_OUT" };

function configuredUrl(value?: string) {
  const parsed = comfyCloudUrlSchema.safeParse(value || DEFAULT_COMFY_CLOUD_URL);
  if (!parsed.success) throw new RequestError("Enter a valid Comfy Cloud deployment URL in the connection dialog or COMFY_CLOUD_BASE_URL.", "invalid_comfy_cloud_url");
  return parsed.data;
}
export async function comfyCloudConnectionInfo() {
  return withDatabase(db => ({ baseUrl: configuredUrl(db.comfyCloud?.baseUrl || process.env.COMFY_CLOUD_BASE_URL?.trim()), configured: Boolean(db.comfyCloud?.apiKey || process.env.COMFY_CLOUD_API_KEY?.trim()), environmentKey: Boolean(process.env.COMFY_CLOUD_API_KEY?.trim()) }));
}
export async function saveComfyCloudConnection(value: unknown) {
  const parsed = z.object({ apiKey: keySchema.optional(), clearKey: z.boolean().optional(), baseUrl: comfyCloudUrlSchema.optional() }).safeParse(value);
  if (!parsed.success) throw new RequestError(parsed.error.issues[0].message, "invalid_comfy_cloud_settings");
  await withDatabase(db => { db.comfyCloud = { apiKey: parsed.data.clearKey ? undefined : parsed.data.apiKey || db.comfyCloud?.apiKey, baseUrl: parsed.data.baseUrl ?? db.comfyCloud?.baseUrl }; });
  return comfyCloudConnectionInfo();
}
async function connection() {
  const result = await withDatabase(db => ({ key: db.comfyCloud?.apiKey || process.env.COMFY_CLOUD_API_KEY?.trim(), baseUrl: configuredUrl(db.comfyCloud?.baseUrl || process.env.COMFY_CLOUD_BASE_URL?.trim()) }));
  if (!keySchema.safeParse(result.key).success) throw new RequestError("Save a Comfy Cloud API key in its connection dialog or set COMFY_CLOUD_API_KEY in .env.local.", "comfy_cloud_not_configured");
  return { ...result, key: result.key! };
}
function cloudError(status: number) {
  return new RequestError(status === 401 || status === 403 ? "Comfy Cloud rejected the API key. Check Comfy Cloud connection." : status === 402 ? "Comfy Cloud credits are insufficient." : status === 404 ? "Comfy Cloud could not find this job or asset. Its output may have expired." : status === 422 ? "Comfy Cloud rejected the workflow or an uploaded asset. Check that the workflow's nodes and models are available in your Cloud account." : `Comfy Cloud returned HTTP ${status}. Check your subscription, queue and connection.`, status === 404 ? "comfy_cloud_job_missing" : "comfy_cloud_api_error");
}
function cloudLink(value: string, baseUrl: string, jobId?: string) {
  const url = new URL(value, baseUrl);
  if (url.origin !== baseUrl || url.username || url.password || !url.pathname.includes("/api/v2/jobs/") || jobId && !url.pathname.endsWith(`/${jobId}`)) throw new RequestError("Comfy Cloud returned an invalid job link.", "invalid_comfy_cloud_response");
  return url.href;
}
async function cloudJson(path: string, baseUrl: string, signal?: AbortSignal) {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl || url.username || url.password) throw new RequestError("Invalid Comfy Cloud API URL.", "invalid_comfy_cloud_response");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${(await connection()).key}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw cloudError(response.status);
  return response.json();
}

// v1 object_info is still the official Cloud surface for node/model discovery.
export async function assertComfyCloudWorkflowSupport(images = false, audios = false, signal?: AbortSignal, endpoint?: string) {
  const baseUrl = endpoint ? configuredUrl(endpoint) : (await connection()).baseUrl;
  // Deployments expose v2 only; their packaged node/model validation runs on submit.
  if (baseUrl !== DEFAULT_COMFY_CLOUD_URL) return;
  let data: Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }>;
  try {
    const response = await fetch(`${baseUrl}/api/object_info`, { headers: { "X-API-Key": (await connection()).key }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), cache: "no-store", redirect: "error" });
    if (!response.ok) throw cloudError(response.status);
    data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid node definitions");
  } catch (error) { if (error instanceof RequestError || signal?.aborted) throw error; throw new RequestError("Could not check Comfy Cloud workflow support. No job was submitted; retry the connection.", "comfy_cloud_capabilities_failed"); }
  const required = new Set([...Object.values(template).map(node => node.class_type), ...(images ? ["LoadImage"] : []), ...(audios ? ["LoadAudio"] : [])]);
  const missing = [...required].filter(name => !data[name]);
  if (missing.length) throw new RequestError(`Comfy Cloud does not expose these required nodes: ${missing.join(", ")}. Make this motion-context workflow available in your Cloud environment before generating.`, "comfy_cloud_nodes_missing");
  for (const id of ["158", "159"] as const) {
    const node = template[id], inputs = { ...data[node.class_type].input?.required, ...data[node.class_type].input?.optional };
    if (!["storage_root", "clip_id", ...(id === "158" ? ["latent_path", "folder", "clip_index"] : [])].every(name => name in inputs)) throw new RequestError("Comfy Cloud needs the motion-context nodes with file input/output support used by this workflow.", "comfy_cloud_nodes_incompatible");
  }
  for (const id of ["119", "120", "127", "128", "141"] as const) {
    const node = template[id];
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!name.endsWith("_name")) continue;
      const specification = data[node.class_type].input?.required?.[name] ?? data[node.class_type].input?.optional?.[name];
      if (Array.isArray(specification) && Array.isArray(specification[0]) && !specification[0].includes(value)) throw new RequestError(`Comfy Cloud does not list the required model ${value}. Make it available in your Cloud environment before generating.`, "comfy_cloud_model_missing");
    }
  }
}
function mime(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg" } as Record<string, string>)[ext || ""] || "application/octet-stream";
}
async function upload(name: string, blob: Blob, key: string, baseUrl: string, signal?: AbortSignal): Promise<CloudAssetReference> {
  const maximum = baseUrl === DEFAULT_COMFY_CLOUD_URL ? MAX_LATENT_BYTES : 100 * 1024 * 1024;
  if (!blob.size || blob.size > maximum) throw new RequestError(`The Comfy input file is empty or exceeds the ${maximum / 1024 / 1024} MiB upload limit for this endpoint.`, "comfy_cloud_upload_size");
  const form = new FormData();
  // Cloud reads metadata only before the file part.
  form.append("file_path", name); form.append("content_type", mime(name)); form.append("tags", JSON.stringify(["input"])); form.append("file", blob, name);
  try {
    const response = await fetch(`${baseUrl}/api/v2/assets`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000), redirect: "error" });
    if (!response.ok) throw cloudError(response.status);
    const asset = z.object({ id: idSchema, hash: z.string().nullable().optional(), file_path: z.string().nullable().optional() }).parse(await response.json());
    return { __type: "core/ASSET", info: { id: asset.id, ...(asset.hash ? { hash: asset.hash } : {}), file_path: asset.file_path || name } };
  } catch (error) { if (error instanceof RequestError || signal?.aborted) throw error; throw new RequestError("Comfy Cloud input upload failed. No generation was submitted; try again.", "comfy_cloud_upload_failed"); }
}
export async function prepareComfyCloudRequest(project: AgentProject, input: ComfyCloudInput, signal?: AbortSignal) {
  const { key, baseUrl } = await connection();
  await assertComfyCloudWorkflowSupport(Boolean(input.images.length), Boolean(input.audios.length), signal, baseUrl);
  const payload = buildPayload(input.settings, input.images, input.audios, { clipId: input.clipId || input.requestId, previousClipId: input.previousClipId });
  const uploads = new Map<string, CloudAssetReference>();
  for (const file of payload.input.images) uploads.set(file.name, await upload(file.name, new Blob([Buffer.from(file.image, "base64")], { type: mime(file.name) }), key, baseUrl, signal));
  let latent: CloudAssetReference | undefined;
  if (input.previousClipId) {
    if (!input.previousLatent) throw new RequestError("The preceding clip has no locally saved latent file. Generate it with Comfy Cloud first.", "continuity_latent_missing");
    const path = assetPath(project.id, input.previousLatent.path);
    await validateLatent(path);
    latent = await upload(`h3-${input.previousClipId}.safetensors`, await openAsBlob(path, { type: "application/octet-stream" }), key, baseUrl, signal);
  }
  return { baseUrl, workflow: buildComfyCloudWorkflow(input.settings, input.images, input.audios, { clipId: input.clipId || input.requestId, previousClipId: input.previousClipId }, uploads, latent) };
}
function updateFromCloud(data: z.infer<typeof cloudJobSchema>, baseUrl: string): Partial<H3Job> {
  const video = data.outputs.find(output => output.node_id === "92" && (output.type === "video" || output.content_type.startsWith("video/")));
  return { id: data.id, status: statuses[data.status], baseUrl, statusUrl: cloudLink(data.urls.self, baseUrl, data.id), output: { ...(video ? { video: video.url } : {}), comfyCloud: { baseUrl, outputs: data.outputs } }, ...(typeof data.metrics?.queue_ms === "number" ? { delayTime: data.metrics.queue_ms } : {}), ...(typeof data.metrics?.execution_ms === "number" ? { executionTime: data.metrics.execution_ms } : {}), error: data.status === "failed" ? "Comfy Cloud generation failed. Inspect the job in your Cloud account." : data.status === "expired" ? "Comfy Cloud job output expired. Recover locally saved media or explicitly retry." : undefined };
}
export async function submitComfyCloud(input: ComfyCloudInput, workflow: Workflow, expectedBaseUrl?: string): Promise<H3Job> {
  if (input.collectionId) await getCollection(input.collectionId);
  const config = await connection();
  const key = config.key, baseUrl = configuredUrl(expectedBaseUrl || config.baseUrl);
  const reservation = await withDatabase(db => {
    const jobs = db.h3Jobs ??= [], existing = jobs.find(job => job.localId === input.requestId);
    if (existing) {
      if (existing.endpoint !== "comfy-cloud" || existing.collectionId !== input.collectionId) throw new RequestError("This request belongs to a different provider or project.", "invalid_project");
      return { existing };
    }
    if (jobs.some(job => ["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(job.status))) throw new RequestError("Recover the uncertain provider submission before starting another job.", "submission_unknown");
    const job: H3Job = { localId: input.requestId, collectionId: input.collectionId, endpoint: "comfy-cloud", baseUrl, prompt: input.settings.prompt, createdAt: Date.now(), status: "SUBMITTING", agent: true };
    jobs.unshift(job); return { job };
  });
  if (reservation.existing) return reservation.existing;
  let result: Partial<H3Job>;
  try {
    // Never replay a paid request, including after an ambiguous timeout.
    const response = await fetch(`${baseUrl}/api/v2/jobs`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": input.requestId }, body: JSON.stringify({ workflow }), signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!response.ok) {
      const data = response.status === 422 ? await response.json().catch(() => undefined) : undefined;
      const reused = data?.error?.code === "idempotency_key_reuse";
      result = { status: response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status) && !reused ? "REJECTED" : "SUBMISSION_UNKNOWN", error: reused ? "Comfy Cloud has already used this submission key. Recover the existing job ID before allowing another paid request." : cloudError(response.status).message };
    }
    else result = updateFromCloud(cloudJobSchema.parse(await response.json()), baseUrl);
  } catch { result = { status: "SUBMISSION_UNKNOWN", error: "Comfy Cloud may have accepted this paid job, but its response was lost. Recover its job ID from your Cloud account before submitting again." }; }
  return withDatabase(db => { const job = db.h3Jobs!.find(job => job.localId === input.requestId)!; if (job.status === "SUBMITTING") Object.assign(job, result); return job; });
}
export async function checkComfyCloud(jobId: string, localId?: string): Promise<H3Job> {
  if (!idSchema.safeParse(jobId).success) throw new RequestError("Enter a valid Comfy Cloud job ID.", "invalid_job_id");
  const saved = await withDatabase(db => (db.h3Jobs || []).find(job => localId ? job.localId === localId : job.id === jobId && job.endpoint === "comfy-cloud"));
  if (localId && !saved) throw new RequestError("Saved Comfy Cloud job not found.", "job_not_found");
  if (saved && (saved.endpoint !== "comfy-cloud" || saved.id && saved.id !== jobId)) throw new RequestError("This job differs from the saved provider or job ID.", "invalid_job_id");
  const baseUrl = configuredUrl(saved ? saved.baseUrl || (saved.statusUrl ? new URL(saved.statusUrl).origin : DEFAULT_COMFY_CLOUD_URL) : (await connection()).baseUrl);
  let data: z.infer<typeof cloudJobSchema>;
  try {
    data = cloudJobSchema.parse(await cloudJson(saved?.statusUrl ? cloudLink(saved.statusUrl, baseUrl, jobId) : `/api/v2/jobs/${encodeURIComponent(jobId)}`, baseUrl));
    if (data.id !== jobId) throw new Error("Mismatched job ID");
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError("Could not check Comfy Cloud. Resume to recover the same job.", "comfy_cloud_status_failed"); }
  const update = updateFromCloud(data, baseUrl);
  return withDatabase(db => {
    const jobs = db.h3Jobs ??= [];
    let job = jobs.find(item => item.localId === saved?.localId);
    if (!job) { job = { localId: crypto.randomUUID(), id: jobId, endpoint: "comfy-cloud", prompt: "Recovered Comfy Cloud job", createdAt: Date.now(), status: "IN_QUEUE", agent: true }; jobs.unshift(job); }
    Object.assign(job, update); return job;
  });
}
function outputs(value: unknown) {
  return z.object({ comfyCloud: z.object({ baseUrl: comfyCloudUrlSchema.optional().default(DEFAULT_COMFY_CLOUD_URL), outputs: z.array(outputSchema) }) }).parse(value).comfyCloud;
}
async function outputUrl(output: CloudOutput, baseUrl: string, signal: AbortSignal) {
  const asset = z.object({ id: idSchema, url: z.string().url() }).parse(await cloudJson(`/api/v2/assets/${encodeURIComponent(output.id)}`, baseUrl, signal));
  const url = new URL(asset.url);
  if (asset.id !== output.id || url.protocol !== "https:" || url.username || url.password) throw new RequestError("Comfy Cloud returned an invalid output asset.", "comfy_cloud_output_invalid");
  return url.href;
}
export async function downloadGenerationOutput(projectId: string, clipId: string, output: unknown, signal: AbortSignal) {
  if (output && typeof output === "object" && "comfyCloud" in output) {
    const cloud = outputs(output);
    const video = cloud.outputs.find(item => item.node_id === "92" && (item.type === "video" || item.content_type.startsWith("video/")));
    if (!video) throw new RequestError("Comfy Cloud completed without the workflow's video output. Resume saving after inspecting the job.", "video_output_missing");
    return downloadOutput(projectId, clipId, { video: await outputUrl(video, cloud.baseUrl, signal) }, signal);
  }
  return downloadOutput(projectId, clipId, output, signal);
}
export async function validateLatent(path: string) {
  const size = (await stat(path)).size;
  if (size <= 8 || size > MAX_LATENT_BYTES) throw new RequestError("The saved H3 latent is empty or exceeds Comfy Cloud's input size limit.", "invalid_latent");
  const file = await open(path, "r");
  try {
    const length = Buffer.alloc(8); await file.read(length, 0, 8, 0);
    const bytes = Number(length.readBigUInt64LE());
    if (!Number.isSafeInteger(bytes) || bytes < 2 || bytes > 1024 * 1024 || bytes + 8 >= size) throw new Error("Invalid header");
    const header = Buffer.alloc(bytes); await file.read(header, 0, bytes, 8);
    const tensors = JSON.parse(header.toString("utf8"));
    for (const name of ["video", "audio"]) {
      const tensor = tensors[name];
      if (!tensor || !Array.isArray(tensor.shape) || !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2 || !tensor.data_offsets.every((offset: unknown) => Number.isSafeInteger(offset) && Number(offset) >= 0 && Number(offset) <= size - bytes - 8) || tensor.data_offsets[1] <= tensor.data_offsets[0]) throw new Error("Missing H3 stream");
      const dtypeBytes = ({ F64: 8, F32: 4, F16: 2, BF16: 2 } as Record<string, number>)[tensor.dtype];
      const elements = tensor.shape.reduce((total: number, length: unknown) => Number.isSafeInteger(length) && Number(length) > 0 ? total * Number(length) : NaN, 1);
      if (!dtypeBytes || !Number.isSafeInteger(elements) || elements * dtypeBytes !== tensor.data_offsets[1] - tensor.data_offsets[0]) throw new Error("Invalid tensor dimensions");
    }
    if (tensors.video.data_offsets[0] < tensors.audio.data_offsets[1] && tensors.audio.data_offsets[0] < tensors.video.data_offsets[1]) throw new Error("Overlapping streams");
    return size;
  } catch { throw new RequestError("The saved latent is not a valid H3 safetensors file with video and audio streams. Resume saving its job output.", "invalid_latent"); }
  finally { await file.close(); }
}
export async function saveComfyCloudLatent(projectId: string, clipId: string, output: unknown, signal: AbortSignal): Promise<Asset> {
  const cloud = outputs(output);
  const candidates = cloud.outputs.filter(item => item.node_id === "159" && /\.safetensors$/i.test(item.name));
  if (candidates.length !== 1) throw new RequestError("Comfy Cloud did not return the motion-context safetensors output. The video job was kept; resume saving after checking its outputs.", "latent_output_missing");
  await mkdir(join(projectFolder(projectId), "latents"), { recursive: true, mode: 0o700 });
  const path = `latents/${clipId}.safetensors`;
  await downloadBinaryFile(await outputUrl(candidates[0], cloud.baseUrl, signal), assetPath(projectId, path), signal, MAX_LATENT_BYTES);
  const bytes = await validateLatent(assetPath(projectId, path));
  return { path, name: `${clipId}.safetensors`, bytes, mime: "application/octet-stream" };
}
