import { z } from "zod";
import { withDatabase } from "./store";
import { jobIdSchema, jobHistory, submitAgentVideo, checkVideo } from "./runpod";
import { type H3Job, type ReferenceFile, type agentSubmissionSchema } from "./h3";
import type { AgentProject, AgentClip } from "./agent-types";
import { suppliedAudios } from "./agent-types";
import { publicReferenceUrlSchema } from "./public-reference-url";
import { RequestError } from "./request-error";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assetPath } from "./agent-store";
import { getCollection } from "./project-collections";

type AgentInput = z.infer<typeof agentSubmissionSchema>;
const keySchema = z.string().trim().min(1).max(2048).regex(/^\S+$/);
export async function apimartConnectionInfo() {
  return withDatabase(db => ({ configured: Boolean(db.apimart?.apiKey || process.env.APIMART_API_KEY?.trim()), environmentKey: Boolean(process.env.APIMART_API_KEY?.trim()) }));
}
export async function saveApimartConnection(value: unknown) {
  const input = z.object({ apiKey: keySchema.optional(), clearKey: z.boolean().optional() }).safeParse(value);
  if (!input.success) throw new RequestError("Enter an API Mart key without spaces or newlines.", "invalid_apimart_settings");
  await withDatabase(db => { db.apimart = { apiKey: input.data.clearKey ? undefined : input.data.apiKey || db.apimart?.apiKey }; });
  return apimartConnectionInfo();
}
async function apiKey() {
  const key = await withDatabase(db => db.apimart?.apiKey || process.env.APIMART_API_KEY?.trim());
  if (!keySchema.safeParse(key).success) throw new RequestError("Configure your API Mart key in the connection dialog or APIMART_API_KEY in .env.local.", "apimart_not_configured");
  return key!;
}
function statusError(status: number) {
  return new RequestError(status === 401 || status === 403 ? "API Mart rejected the API key. Check API Mart connection." : status === 402 ? "API Mart balance is insufficient. Top up your API Mart account." : status === 404 ? "API Mart could not find this task. Its result may have expired." : `API Mart returned HTTP ${status}. Check the task and connection.`, status === 404 ? "apimart_job_missing" : "apimart_status_error");
}
export type WanRequest = { model: "wan3.0-video"; prompt: string; resolution: "480P" | "720P" | "1080P"; size: string; duration: number; audio: boolean; seed: number; generation_type: "reference"; image_with_roles?: { url: string; role: "reference_image" }[]; audio_urls?: string[] };
export function wanRequest(input: AgentInput, resolution: WanRequest["resolution"], imageUrls: string[], audioUrls: string[], firstFrameUrl?: string, autoDuration = false): WanRequest {
  if (!Number.isInteger(input.settings.duration) || (input.settings.duration !== -1 && (input.settings.duration < 2 || input.settings.duration > 30))) throw new RequestError("Wan clips must use a whole number of seconds from 2 to 30, or -1 for automatic duration.", "invalid_wan_duration");
  const referenceImages = [...imageUrls, ...(firstFrameUrl ? [firstFrameUrl] : [])];
  if (!referenceImages.length && !audioUrls.length) throw new RequestError("Wan reference mode requires an image, voice sample, or previous clip's last frame.", "invalid_wan_references");
  if (referenceImages.length > 10 || audioUrls.length > 5) throw new RequestError("Wan supports up to 10 image references including the previous last frame, and 5 voice references.", "invalid_wan_references");
  const urls = [...imageUrls, ...audioUrls, ...(firstFrameUrl ? [firstFrameUrl] : [])];
  if (urls.some(url => !publicReferenceUrlSchema.safeParse(url).success)) throw new RequestError("Wan references must use public HTTPS URLs.", "invalid_wan_references");
  let prompt = input.settings.prompt.replace(/<Picture (\d+)>/g, "图$1").replace(/<Audio (\d+)>/g, "音频$1");
  if (firstFrameUrl) prompt = [prompt.replace("Begin on the supplied frame-zero guide and continue the preceding action without resetting the scene.", "Continue the preceding action without resetting the scene."), `图${referenceImages.length} is the previous clip's last frame. Use it as a visual reference to preserve scene continuity, composition and the ongoing action.`].join("\n\n");
  if (autoDuration || input.settings.duration === -1) prompt = prompt.replace(/^\d+(?:\.\d+)?[–-]\d+(?:\.\d+)?s:\s*/gm, "") + "\n\nChoose the final video duration naturally, up to 30 seconds, to complete every action and line of dialogue at a realistic pace. Do not rush or add filler.";
  if (prompt.length > 20000) throw new RequestError("Wan prompts must be at most 20,000 characters.", "invalid_wan_prompt");
  return { model: "wan3.0-video", prompt, resolution, size: input.settings.aspectRatio.split(" ")[0], duration: autoDuration ? -1 : input.settings.duration, audio: true, seed: Number(input.settings.seed) % 2147483648,
    generation_type: "reference", ...(referenceImages.length ? { image_with_roles: referenceImages.map(url => ({ url, role: "reference_image" as const })) } : {}), ...(audioUrls.length ? { audio_urls: audioUrls } : {}) };
}
async function uploadImage(file: ReferenceFile, key: string, signal?: AbortSignal) {
  const form = new FormData();
  const mime = /\.webp$/i.test(file.name) ? "image/webp" : /\.jpe?g$/i.test(file.name) ? "image/jpeg" : "image/png";
  form.append("file", new Blob([new Uint8Array(Buffer.from(file.base64, "base64"))], { type: mime }), file.name);
  try {
    const response = await fetch("https://api.apimart.ai/v1/uploads/images", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000), redirect: "error" });
    if (!response.ok) throw statusError(response.status);
    const data = await response.json();
    if (!publicReferenceUrlSchema.safeParse(data.url).success) throw new Error("Invalid upload response");
    return data.url as string;
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError("API Mart image upload failed. No video task was submitted; try again.", "apimart_upload_failed"); }
}
export async function prepareWanRequest(project: AgentProject, clip: AgentClip, input: AgentInput, signal?: AbortSignal) {
  const audioUrls = suppliedAudios(project, clip).map(ref => ref.asset.publicUrl || "");
  // Validate before uploading or reserving a paid generation.
  wanRequest(input, project.settings.wanResolution || "720P", input.images.map(() => "https://example.com/reference.png"), audioUrls, input.firstFrame ? "https://example.com/frame.png" : undefined);
  let totalAudioSeconds = 0;
  for (const ref of suppliedAudios(project, clip)) {
    const result = await promisify(execFile)(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration", "-of", "json", assetPath(project.id, ref.asset.path)], { windowsHide: true, timeout: 15000, maxBuffer: 100000 });
    const duration = Number(JSON.parse(result.stdout).format?.duration);
    if (!Number.isFinite(duration) || duration < 1 || duration > 15) throw new RequestError("Wan voice samples must each be 1–15 seconds.", "invalid_wan_references");
    totalAudioSeconds += duration;
  }
  if (totalAudioSeconds > 15) throw new RequestError("Wan voice samples must total at most 15 seconds per clip.", "invalid_wan_references");
  const key = await apiKey();
  const images: string[] = [];
  for (const file of input.images) images.push(await uploadImage(file, key, signal));
  const firstFrame = input.firstFrame ? await uploadImage(input.firstFrame, key, signal) : undefined;
  return wanRequest(input, project.settings.wanResolution || "720P", images, audioUrls, firstFrame, project.settings.wanDurationMode !== "fixed");
}
export async function submitWan(input: AgentInput, body: WanRequest): Promise<H3Job> {
  if (input.collectionId) await getCollection(input.collectionId);
  const key = await apiKey();
  const reservation = await withDatabase(db => {
    const jobs = db.h3Jobs ??= [];
    const existing = jobs.find(job => job.localId === input.requestId);
    if (existing) {
      if (existing.endpoint !== "apimart" || existing.collectionId !== input.collectionId) throw new RequestError("This request belongs to another provider or project.", "invalid_project");
      return { existing };
    }
    if (jobs.some(job => ["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(job.status))) throw new RequestError("A submission needs recovery before starting a new task.", "submission_unknown");
    const job: H3Job = { localId: input.requestId, collectionId: input.collectionId, id: undefined, endpoint: "apimart", prompt: body.prompt, createdAt: Date.now(), status: "SUBMITTING", agent: true };
    jobs.unshift(job); return { job };
  });
  if (reservation.existing) return reservation.existing;
  let result: Partial<H3Job>;
  try {
    const response = await fetch("https://api.apimart.ai/v1/videos/generations", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!response.ok) result = { status: response.status >= 400 && response.status < 500 && response.status !== 408 ? "REJECTED" : "SUBMISSION_UNKNOWN", error: statusError(response.status).message };
    else {
      const data = await response.json(); const id = data.data?.[0]?.task_id;
      if (!jobIdSchema.safeParse(id).success) throw new Error("No task ID");
      result = { id, status: "IN_QUEUE" };
    }
  } catch { result = { status: "SUBMISSION_UNKNOWN", error: "API Mart submission response was lost. Recover its task ID before retrying; a paid task may exist." }; }
  return withDatabase(db => { const job = db.h3Jobs!.find(job => job.localId === input.requestId)!; if (job.status === "SUBMITTING") Object.assign(job, result); return job; });
}
export async function checkWan(taskId: string, localId?: string): Promise<H3Job> {
  if (!jobIdSchema.safeParse(taskId).success) throw new RequestError("Enter a valid API Mart task ID.", "invalid_job_id");
  const saved = await withDatabase(db => (db.h3Jobs || []).find(job => localId ? job.localId === localId : job.id === taskId && job.endpoint === "apimart"));
  if (localId && !saved) throw new RequestError("Saved task not found.", "job_not_found");
  if (saved && (saved.endpoint !== "apimart" || saved.id && saved.id !== taskId)) throw new RequestError("This task differs from the saved provider or task ID.", "invalid_job_id");
  let data;
  try {
    const response = await fetch(`https://api.apimart.ai/v1/tasks/${encodeURIComponent(taskId)}?language=en`, { headers: { Authorization: `Bearer ${await apiKey()}` }, signal: AbortSignal.timeout(30000), cache: "no-store", redirect: "error" });
    if (!response.ok) throw statusError(response.status);
    data = (await response.json()).data;
    if (!data || data.id !== taskId || !["pending", "processing", "completed", "failed", "cancelled"].includes(data.status)) throw new Error("Invalid task response");
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError("Could not check API Mart. Resume to check the existing task again.", "apimart_status_error"); }
  return withDatabase(db => {
    const jobs = db.h3Jobs ??= [];
    let job = jobs.find(job => job.localId === saved?.localId);
    if (!job) { job = { localId: crypto.randomUUID(), id: taskId, endpoint: "apimart", prompt: "Recovered Wan task", status: "IN_QUEUE", createdAt: Date.now(), agent: true }; jobs.unshift(job); }
    Object.assign(job, { id: taskId, status: ({ pending: "IN_QUEUE", processing: "IN_PROGRESS", completed: "COMPLETED", failed: "FAILED", cancelled: "CANCELLED" } as Record<string, string>)[data.status], ...(data.result ? { output: data.result } : {}), error: data.error ? "API Mart task failed. Check the task in your API Mart account." : undefined });
    return job;
  });
}
export async function checkGeneration(jobId: string, localId?: string) {
  const job = (await jobHistory()).find(job => localId ? job.localId === localId : job.id === jobId);
  return job?.endpoint === "apimart" ? checkWan(jobId, localId) : checkVideo(jobId, localId);
}
export async function submitGeneration(input: AgentInput & { wanRequest?: WanRequest }, endpoint?: string) {
  if (endpoint === "apimart") {
    if (!input.wanRequest) throw new RequestError("Prepare the Wan request before submitting.", "invalid_wan_request");
    return submitWan(input, input.wanRequest);
  }
  return submitAgentVideo(input, endpoint);
}
