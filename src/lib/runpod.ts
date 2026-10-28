import { z } from "zod";
import { withDatabase } from "./store";
import { DEFAULT_ENDPOINT, buildPayload, submissionSchema, agentSubmissionSchema, type H3Job } from "./h3";
import { RequestError } from "./request-error";
import { getCollection } from "./project-collections";

export const endpointSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const jobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const connectionSchema = z.object({ endpoint: endpointSchema, apiKey: z.string().trim().min(1).max(2048).regex(/^\S+$/).optional(), clearKey: z.boolean().optional() });
export async function connectionInfo() {
  return withDatabase(db => ({ endpoint: db.runpod?.endpoint || process.env.RUNPOD_ENDPOINT_ID || DEFAULT_ENDPOINT, configured: Boolean(db.runpod?.apiKey || process.env.RUNPOD_API_KEY?.trim()), environmentKey: Boolean(process.env.RUNPOD_API_KEY?.trim()) }));
}
export async function saveConnection(value: unknown) {
  const parsed = connectionSchema.safeParse(value);
  if (!parsed.success) throw new RequestError("Enter a valid endpoint ID and a key without spaces or newlines.", "invalid_runpod_settings");
  const input = parsed.data;
  await withDatabase(db => { db.runpod = { endpoint: input.endpoint, apiKey: input.clearKey ? undefined : input.apiKey || db.runpod?.apiKey }; });
  return connectionInfo();
}
async function connection() {
  const result = await withDatabase(db => ({ endpoint: db.runpod?.endpoint || process.env.RUNPOD_ENDPOINT_ID || DEFAULT_ENDPOINT, apiKey: db.runpod?.apiKey || process.env.RUNPOD_API_KEY?.trim() }));
  if (!endpointSchema.safeParse(result.endpoint).success || !result.apiKey || !/^\S{1,2048}$/.test(result.apiKey)) throw new RequestError("Add your RunPod API key in RunPod connection before generating or checking jobs.", "runpod_not_configured");
  return result as { endpoint: string; apiKey: string };
}
export async function readJson(request: Request, maximum = 8_500_000): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new RequestError("Expected a JSON request.", "invalid_body");
  if (Number(request.headers.get("content-length")) > maximum) throw new RequestError("References exceed the request size limit.", "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("Expected a request body.", "invalid_body");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new RequestError("References exceed the request size limit.", "request_too_large"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError("Could not read request JSON.", "invalid_body"); }
  finally { reader.releaseLock(); }
}
function providerError(status: number) {
  return status === 401 || status === 403 ? "RunPod rejected the API key or endpoint access. Check RunPod connection." : status === 429 ? "RunPod is rate limiting requests. Wait before trying again." : status === 404 ? "RunPod could not find this endpoint or job. Completed results may have expired." : `RunPod returned HTTP ${status}. Check the endpoint and job in the RunPod console.`;
}
export async function jobHistory() {
  return withDatabase(db => (db.h3Jobs || []).map(job => job.status === "SUBMITTING" ? { ...job, status: "SUBMISSION_UNKNOWN", error: "Submission may still be in progress or its response was interrupted. Recover its job ID from the provider account before submitting again." } : job));
}
export async function submitVideo(value: unknown): Promise<H3Job> {
  return submit(value, false);
}
// Internal agent entry point permits omitted slots and enforces a ten-second limit.
export async function submitAgentVideo(value: unknown, expectedEndpoint?: string): Promise<H3Job> {
  return submit(value, true, expectedEndpoint);
}
async function submit(value: unknown, agent: boolean, expectedEndpoint?: string): Promise<H3Job> {
  const parsed = (agent ? agentSubmissionSchema : submissionSchema).safeParse(value);
  if (!parsed.success) throw new RequestError(parsed.error.issues[0].message, "invalid_video_request");
  const input = parsed.data;
  if (input.collectionId) await getCollection(input.collectionId);
  const config = await connection();
  const endpoint = expectedEndpoint ? endpointSchema.parse(expectedEndpoint) : config.endpoint;
  const apiKey = config.apiKey;
  const reservation = await withDatabase(db => {
    const jobs = db.h3Jobs ??= [];
    const existing = jobs.find(job => job.localId === input.requestId);
    if (existing) { if (existing.collectionId !== input.collectionId) throw new RequestError("This request belongs to a different project.", "invalid_project"); return { existing }; }
    if (jobs.some(job => ["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(job.status))) throw new RequestError("A previous submission needs reconciliation. Check the RunPod console and recover its job ID first.", "submission_unknown");
    const job: H3Job = { localId: input.requestId, collectionId: input.collectionId, endpoint, prompt: input.settings.prompt, createdAt: Date.now(), status: "SUBMITTING", ...(agent ? { agent: true } : {}) };
    jobs.unshift(job);
    // Keep all unfinished jobs; bound the completed history.
    db.h3Jobs = jobs.filter((job, index) => index < 20 || job.agent || !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "REJECTED"].includes(job.status));
    return { job };
  });
  if (reservation.existing) return reservation.existing;
  let result: Partial<H3Job>;
  try {
    // Never retry /run automatically: a lost response may have started a paid job.
    const response = await fetch(`https://api.runpod.ai/v2/${endpoint}/run`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(buildPayload(input.settings, input.images, input.audios, { clipId: input.clipId || input.requestId, previousClipId: input.previousClipId })), signal: AbortSignal.timeout(60000), redirect: "error", cache: "no-store" });
    if (!response.ok) {
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
      result = { status: rejected ? "REJECTED" : "SUBMISSION_UNKNOWN", error: providerError(response.status) };
    } else {
      const data = await response.json();
      if (!jobIdSchema.safeParse(data.id).success) throw new Error("Missing job ID");
      result = { id: data.id, status: typeof data.status === "string" ? data.status.toUpperCase() : "IN_QUEUE", ...(data.output !== undefined ? { output: data.output } : {}), ...(typeof data.delayTime === "number" ? { delayTime: data.delayTime } : {}), ...(typeof data.executionTime === "number" ? { executionTime: data.executionTime } : {}) };
    }
  } catch {
    result = { status: "SUBMISSION_UNKNOWN", error: "RunPod may have accepted this job, but its response was lost. Check the RunPod console and recover the job ID before generating again." };
  }
  return withDatabase(db => {
    const job = db.h3Jobs!.find(job => job.localId === input.requestId)!;
    // A manual recovery can race a delayed response; do not overwrite a recovered job.
    if (job.status === "SUBMITTING") Object.assign(job, result);
    return job;
  });
}
export async function checkVideo(jobId: string, localId?: string, collectionId?: string): Promise<H3Job> {
  if (!jobIdSchema.safeParse(jobId).success || (localId && !z.uuid().safeParse(localId).success)) throw new RequestError("Enter a valid job ID.", "invalid_job_id");
  const { endpoint: currentEndpoint, apiKey } = await connection();
  const saved = await withDatabase(db => (db.h3Jobs || []).find(job => localId ? job.localId === localId : job.id === jobId && job.endpoint === currentEndpoint));
  if (collectionId) { await getCollection(collectionId); if (saved?.collectionId && saved.collectionId !== collectionId) throw new RequestError("This job belongs to a different project.", "invalid_project"); }
  if (localId && !saved) throw new RequestError("Saved job not found.", "job_not_found");
  if (saved && ["apimart", "comfy-cloud"].includes(saved.endpoint)) throw new RequestError("This job belongs to another video provider. Resume it from its scene in the agent.", "invalid_job_id");
  if (saved?.id && saved.id !== jobId) throw new RequestError("This job ID differs from the saved job.", "invalid_job_id");
  const endpoint = saved?.endpoint || currentEndpoint;
  let data;
  try {
    const response = await fetch(`https://api.runpod.ai/v2/${endpoint}/status/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000), cache: "no-store", redirect: "error" });
    if (!response.ok) throw new RequestError(providerError(response.status), response.status === 404 ? "runpod_job_missing" : "runpod_status_error");
    data = await response.json();
    if (typeof data.status !== "string" || (data.id !== undefined && data.id !== jobId)) throw new Error("Invalid job response");
  } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError("Could not check RunPod. The job may still be running; retry checking its status.", "runpod_status_error"); }
  return withDatabase(db => {
    const jobs = db.h3Jobs ??= [];
    let job = saved && jobs.find(job => job.localId === saved.localId);
    if (job && collectionId && !job.collectionId) job.collectionId = collectionId;
    if (!job) { job = { localId: crypto.randomUUID(), collectionId, id: jobId, endpoint, prompt: "Recovered job", createdAt: Date.now(), status: "IN_QUEUE" }; jobs.unshift(job); }
    Object.assign(job, { id: jobId, status: data.status.toUpperCase(), ...(data.output !== undefined ? { output: data.output } : {}), ...(data.error !== undefined ? { error: typeof data.error === "string" ? data.error.slice(0, 2000) : "The worker reported an error. See response data." } : { error: undefined }), ...(typeof data.delayTime === "number" ? { delayTime: data.delayTime } : {}), ...(typeof data.executionTime === "number" ? { executionTime: data.executionTime } : {}) });
    return job;
  });
}
export async function resolveUnknown(localId: string) {
  if (!z.uuid().safeParse(localId).success) throw new RequestError("Invalid local job ID.", "invalid_job_id");
  return withDatabase(db => {
    const job = db.h3Jobs?.find(job => job.localId === localId);
    if (!job || !["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(job.status)) throw new RequestError("This submission does not need reconciliation.", "invalid_job_state");
    job.status = "REJECTED"; job.error = "Marked resolved after manual review of the provider account.";
    return job;
  });
}
export async function archiveAgentOutput(localId: string, localVideoUrl: string) {
  await withDatabase(db => { const job = db.h3Jobs?.find(job => job.localId === localId); if (job) { job.agent = false; job.output = { video: localVideoUrl }; } });
}
