import { assertStorageReady } from "./output-storage";
import type { ReasoningEffort } from "./reasoning";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { agentSubmissionSchema, buildPayload, type H3Job, type ReferenceFile } from "./h3";
import { plannedDuration, assetUrl, finalPrompt, markFollowingContinuityOutdated, needsPreviousPrompt, previousPromptAvailable, previousFrameDecision, suppliedReferences, suppliedImages, suppliedAudios, type AgentClip, type AgentProject, type PublicProject } from "./agent-types";
import { prepareSequentialPrompt, assertPreviousPromptReady } from "./sequential-prompts";
import { assetPath, getProject, updateProject, writeAsset, projectFolder } from "./agent-store";
import { archiveAgentOutput, checkVideo, connectionInfo, jobHistory, submitAgentVideo, resolveUnknown } from "./runpod";
import { appOrigin } from "./config";
import { compilePrompts } from "./agent-llm";
import { discardProcessedSource, downloadOutput, finalizeClip, verifyMediaTools } from "./agent-media";
import { RequestError } from "./request-error";
import { projectReferenceIssues } from "./agent-reference-validation";
import { apimartConnectionInfo, checkGeneration, prepareWanRequest, submitGeneration } from "./apimart";
import { promptApprovalKey } from "./prompt-approval";
import { wanPromptGuideVersion } from "./wan-prompt-guide";

function jobTiming(job: H3Job) {
  return { ...(typeof job.delayTime === "number" && Number.isFinite(job.delayTime) && job.delayTime >= 0 ? { delayTime: job.delayTime } : {}), ...(typeof job.executionTime === "number" && Number.isFinite(job.executionTime) && job.executionTime >= 0 ? { executionTime: job.executionTime } : {}) };
}

type RunnerState = { active?: { projectId: string; controller: AbortController; clipId?: string } };
const globals = globalThis as typeof globalThis & { videoAgentRunner?: RunnerState };
const state = globals.videoAgentRunner ??= {};
export function isProjectActive(id: string) { return state.active?.projectId === id; }
export function assertEditable(id: string) { if (isProjectActive(id)) throw new RequestError("Pause the agent before editing the project.", "project_busy"); }
export function publicProject(project: AgentProject, history: H3Job[] = []): PublicProject {
  const active = isProjectActive(project.id);
  const timing = <T extends Pick<AgentClip, "requestId">>(clip: T) => {
    const job = clip.requestId ? history.find(job => job.localId === clip.requestId) : undefined;
    return job ? { ...clip, ...jobTiming(job) } : clip;
  };
  const clips = project.clips.map(clip => ({ ...timing(clip), ...(clip.versions ? { versions: clip.versions.map(take => ({ ...take, clip: timing(take.clip) })) } : {}) }));
  return { ...project, clips, folder: projectFolder(project.id), active, ...(!active && ["running", "preparing"].includes(project.status) ? { status: "paused" as const, error: "The server stopped while processing this project. Resume to recover existing jobs and continue." } : {}) };
}
async function referenceFile(projectId: string, name: string, path: string): Promise<ReferenceFile> {
  const bytes = await readFile(assetPath(projectId, path)); return { name, bytes: bytes.length, base64: bytes.toString("base64") };
}
export async function inputFor(project: AgentProject, clip: AgentClip) {
  const images = await Promise.all(suppliedImages(project, clip).map((slot, index) => referenceFile(project.id, `reference-${index + 1}.${slot.asset.path.split(".").pop()}`, slot.asset.path)));
  const audios = await Promise.all(suppliedAudios(project, clip).map((slot, index) => referenceFile(project.id, `voice-${index + 1}.${slot.asset.path.split(".").pop()}`, slot.asset.path)));
  let firstFrame: ReferenceFile | undefined; let firstFrameFrom: string | undefined; let previousClipId: string | undefined;
  if (previousFrameDecision(clip)) {
    const previous = project.clips[project.clips.findIndex(item => item.id === clip.id) - 1];
    if (project.settings.provider === "apimart") {
      if (previous?.status !== "complete" || !previous.frame) throw new RequestError("This clip needs the previous clip's saved last frame. Generate the preceding clip first.", "continuity_frame_missing");
      firstFrame = await referenceFile(project.id, `continuity-${previous.id}.${previous.frame.path.split(".").pop()}`, previous.frame.path);
      firstFrameFrom = previous.id;
    } else {
      if (previous?.status !== "complete" || !previous.latentId) throw new RequestError("This clip needs the previous clip's saved H3 latent. Generate or regenerate the preceding clip with the motion-context workflow first.", "continuity_latent_missing");
      previousClipId = previous.latentId;
    }
  }
  const requestId = clip.requestId || randomUUID();
  const input = { collectionId: project.collectionId, requestId, clipId: clip.latentId || requestId, previousClipId, settings: { ...project.settings, prompt: finalPrompt(project, clip), duration: clip.duration, seed: String(clip.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]) }, images, audios, ...(firstFrame ? { firstFrame } : {}) };
  if (project.settings.provider === "apimart") return { input, firstFrameFrom };
  const parsed = agentSubmissionSchema.safeParse(input);
  if (!parsed.success) throw new RequestError(`${clip.title}: ${parsed.error.issues[0].message}`, "invalid_agent_request");
  return { input: parsed.data as typeof parsed.data & { firstFrame?: ReferenceFile }, firstFrameFrom };
}
async function assertReplaceableJob(jobId: string, requestId?: string) {
  try {
    const checked = await checkGeneration(jobId, requestId);
    if (!["FAILED", "CANCELLED", "TIMED_OUT"].includes(checked.status)) throw new RequestError("This job still exists. Resume it to recover and save its output before requesting a replacement.", "job_still_exists");
  } catch (error) {
    // A missing result can only be replaced through an explicit retry, never on resume.
    if (!(error instanceof RequestError) || !["runpod_job_missing", "apimart_job_missing"].includes(error.code)) throw error;
  }
}
export async function reserveRun(id: string, model: string, options: { clipId?: string; revision?: boolean; retryCurrent?: boolean; reasoningEffort?: ReasoningEffort } = {}) {
  assertStorageReady();
  if (state.active) throw new RequestError("Another video agent is running. Pause it or wait for it to finish.", "agent_busy");
  const controller = new AbortController(); state.active = { projectId: id, controller };
  try {
    const project = await getProject(id);
    const connection = project.settings.provider === "apimart" ? { ...await apimartConnectionInfo(), endpoint: "apimart" } : await connectionInfo();
    if (!connection.configured) throw new RequestError("Configure the selected video provider key in .env.local or its connection dialog before generating.", "runpod_not_configured");
    await verifyMediaTools();
    controller.signal.throwIfAborted();
    const scopeId = options.clipId || (project.clips.find(clip => clip.id === project.runClipId)?.status !== "complete" ? project.runClipId : undefined);
    const selected = scopeId ? project.clips.find(clip => clip.id === scopeId) : undefined;
    if (scopeId && !selected) throw new RequestError("Choose an existing clip.", "invalid_clip_state");
    const history = await jobHistory();
    if (history.some(job => job.status === "SUBMISSION_UNKNOWN" || job.status === "SUBMITTING")) throw new RequestError("A submission needs recovery. Check the provider account and attach its job ID, or resolve it before generating.", "submission_unknown");
    let revised: AgentClip | undefined;
    if (options.revision || options.retryCurrent) {
      if (!selected || !["complete", "failed", ...(options.retryCurrent ? ["recoverable"] : [])].includes(selected.status) || (options.revision && !selected.revision)) throw new RequestError("Choose a completed, failed, or interrupted clip to retry, or prepare a revised prompt first.", "revision_required");
      if (selected.status !== "complete" && !selected.source) {
        const job = history.find(job => job.localId === selected.requestId);
        if (job?.id || selected.jobId) await assertReplaceableJob(job?.id || selected.jobId!, job ? selected.requestId : undefined);
      }
      const { versions, revision, nextDuration, ...take } = selected;
      if (options.revision && revision?.referenceIds && (new Set(revision.referenceIds).size !== revision.referenceIds.length || revision.referenceIds.some(id => !project.references.some(slot => slot.id === id)))) throw new RequestError("Choose valid scene references for this revision.", "invalid_reference");
      revised = { ...selected, duration: plannedDuration(selected), nextDuration: undefined, referenceIds: options.revision ? revision!.referenceIds ?? selected.referenceIds : selected.referenceIds, promptGuideVersion: options.revision && project.settings.provider === "apimart" ? wanPromptGuideVersion : selected.promptGuideVersion, versions: [...(versions || []), { archivedAt: Date.now(), clip: take }], prompt: options.revision ? revision!.prompt : selected.prompt, compiledPrompt: options.revision ? revision!.prompt : selected.compiledPrompt || selected.prompt, revisionComments: options.revision ? revision!.comments : selected.revisionComments, revision: undefined, status: "pending", approvedPromptKey: undefined, requestId: undefined, latentId: undefined, previousLatentId: undefined, delayTime: undefined, executionTime: undefined, jobId: undefined, requestedDuration: undefined, seed: undefined, endpoint: undefined, source: undefined, video: undefined, frame: undefined, extractedFrame: undefined, frameReplaced: false, media: undefined, firstFrameFrom: undefined, error: undefined, continuityOutdated: false };
    }
    const candidate = { ...project, clips: project.clips.map(clip => {
      if (clip.id === revised?.id) return revised;
      if ((!scopeId || clip.id === scopeId) && ["pending", "awaiting-approval"].includes(clip.status) && !clip.requestId && !clip.jobId && !clip.source && clip.nextDuration !== undefined) return { ...clip, duration: clip.nextDuration, nextDuration: undefined };
      return clip;
    }) };
    if (options.revision && revised) revised.approvedPromptKey = promptApprovalKey(candidate, revised);
    const targets = candidate.clips.filter(clip => !scopeId || clip.id === scopeId);
    for (const clip of targets.filter(clip => clip.status !== "complete" && !clip.jobId && !clip.source && (scopeId || !needsPreviousPrompt(candidate, clip)))) assertPreviousPromptReady(candidate, clip);
    if (targets.every(clip => clip.status === "complete")) throw new RequestError("Every selected clip is already saved.", "project_complete");
    if (targets.some(clip => clip.status === "failed" || clip.status === "submission-unknown")) throw new RequestError("Recover or explicitly retry the failed clip before resuming.", "clip_needs_review");
    if (scopeId && previousFrameDecision(targets[0])) {
      const previous = candidate.clips[candidate.clips.findIndex(clip => clip.id === scopeId) - 1];
      if (previous?.status !== "complete" || !(candidate.settings.provider === "apimart" ? previous.frame : previous.latentId)) throw new RequestError("Generate the preceding clip with the current workflow before retrying this continuation.", "continuity_missing");
    }
    const referenceIssues = projectReferenceIssues(candidate).filter(issue => !scopeId || issue.clipId === scopeId);
    if (referenceIssues.length) throw new RequestError(referenceIssues.map(issue => issue.message).join("\n"), "invalid_agent_request");
    for (const clip of targets.filter(clip => clip.status !== "complete" && !clip.jobId)) {
      const maxSeconds = candidate.settings.provider === "apimart" ? 30 : 10;
      if (clip.duration > maxSeconds || clip.duration < 2 || (maxSeconds === 30 && !Number.isInteger(clip.duration))) throw new RequestError(`Every clip must be 2–${maxSeconds} seconds${maxSeconds === 30 ? " in whole seconds" : ""}.`, "invalid_duration");
    }
    await updateProject(id, current => { controller.signal.throwIfAborted(); if (JSON.stringify(current) !== JSON.stringify(project)) throw new RequestError("The project changed while starting generation. Review the latest settings and try again.", "project_changed"); current.clips = candidate.clips; current.runClipId = scopeId; current.status = "preparing"; current.model = model; current.reasoningEffort = options.reasoningEffort || current.reasoningEffort || "low"; current.runEndpoint = connection.endpoint; current.error = undefined; return current; });
    if (state.active?.controller === controller) state.active.clipId = scopeId;
    if (revised && selected?.requestId && selected.video) await archiveAgentOutput(selected.requestId, new URL(`${assetUrl(id, "video", selected.id)}&version=${revised.versions!.length - 1}`, appOrigin()).href);
    return controller;
  } catch (error) { if (state.active?.controller === controller) state.active = undefined; throw error; }
}
type Dependencies = { compile: typeof compilePrompts; submit: typeof submitGeneration; check: typeof checkGeneration; history: typeof jobHistory; download: typeof downloadOutput; finalize: typeof finalizeClip; pollMs: number };
const defaultDependencies: Dependencies = { compile: compilePrompts, submit: submitGeneration, check: checkGeneration, history: jobHistory, download: downloadOutput, finalize: finalizeClip, pollMs: 5000 };
export async function executeProject(id: string, controller: AbortController, overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides }; const signal = controller.signal;
  const scopeId = state.active?.controller === controller ? state.active.clipId : undefined;
  let activeClipId: string | undefined;
  try {
    const context = await getProject(id);
    const prompts = await dependencies.compile({ ...context, clips: context.clips.filter(clip => (!scopeId || clip.id === scopeId) && (!needsPreviousPrompt(context, clip) || previousPromptAvailable(context, clip))) }, signal);
    signal.throwIfAborted();
    await updateProject(id, project => { for (const prepared of prompts) { const clip = project.clips.find(clip => clip.id === prepared.id)!; clip.compiledPrompt = prepared.prompt; if (project.settings.provider === "apimart") clip.promptGuideVersion = wanPromptGuideVersion; clip.seed ??= crypto.getRandomValues(new Uint32Array(1))[0]; } project.status = "running"; return project; });
    for (const clipId of (await getProject(id)).clips.filter(clip => !scopeId || clip.id === scopeId).map(clip => clip.id)) {
      signal.throwIfAborted(); let project = await getProject(id); let clip = project.clips.find(clip => clip.id === clipId)!;
      if (clip.status === "complete") continue;
      if (!clip.jobId && !clip.source) assertPreviousPromptReady(project, clip);
      activeClipId = clipId;
      if (clip.status === "failed" || clip.status === "submission-unknown") throw new RequestError("Recover or retry this clip explicitly before continuing.", "clip_needs_review");
      let job: H3Job | undefined;
      if (clip.requestId) job = (await dependencies.history()).find(job => job.localId === clip.requestId);
      if (!job && !clip.jobId && !clip.source && project.reviewBeforeEachClip !== false && clip.approvedPromptKey !== promptApprovalKey(project, clip)) {
        await updateProject(id, current => { const shot = current.clips.find(item => item.id === clipId)!; shot.status = "awaiting-approval"; shot.error = undefined; current.status = "paused"; current.error = undefined; return current; });
        return;
      }
      if (!job && !clip.jobId) {
        const built = await inputFor(project, clip);
        const wan = project.settings.provider === "apimart" ? await prepareWanRequest(project, clip, built.input, signal) : undefined;
        signal.throwIfAborted();
        await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; shot.requestId = built.input.requestId; shot.seed = Number(built.input.settings.seed); shot.requestedDuration = wan?.duration ?? clip.duration; shot.firstFrameFrom = built.firstFrameFrom; shot.latentId = wan ? undefined : built.input.clipId; shot.previousLatentId = wan ? undefined : built.input.previousClipId; shot.status = "submitting"; shot.error = undefined; return current; });
        // Save a readable audit with filenames/bindings and graph, excluding inline media and credentials.
        const payload = buildPayload(built.input.settings, built.input.images, built.input.audios, { clipId: built.input.clipId || built.input.requestId, previousClipId: built.input.previousClipId });
        await writeAsset(id, `requests/${clipId}-${built.input.requestId}.json`, Buffer.from(JSON.stringify({ clipId, requestId: built.input.requestId, endpoint: project.runEndpoint, firstFrameFrom: built.firstFrameFrom, suppliedReferences: suppliedReferences(project, clip).map(slot => ({ id: slot.id, name: slot.name, asset: slot.asset.path })), media: payload.input.images.map(file => ({ name: file.name })), ...(wan ? { provider: "apimart", request: wan } : { provider: "runpod", workflow: payload.input.workflow }) }, null, 2)), "application/json", "request.json");
        job = await dependencies.submit({ ...built.input, ...(wan ? { wanRequest: wan } : {}) }, project.runEndpoint);
      }
      if (job && ["SUBMISSION_UNKNOWN", "SUBMITTING"].includes(job.status)) {
        await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; shot.status = "submission-unknown"; shot.error = job!.error || "Recover the job ID from the provider account before resuming."; return current; });
        throw new RequestError(job.error || "Submission response lost. Recover its job ID before generating again.", "submission_unknown");
      }
      if (job?.status === "REJECTED") {
        await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; shot.status = "failed"; shot.error = job!.error; return current; });
        throw new RequestError(job.error || "The video provider rejected the request.", "runpod_rejected");
      }
      if (job?.id) await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; Object.assign(shot, jobTiming(job!)); shot.jobId = job!.id; shot.endpoint = job!.endpoint; shot.status = "queued"; return current; });
      project = await getProject(id); clip = project.clips.find(clip => clip.id === clipId)!;
      if (!clip.jobId) throw new RequestError("This shot has no recoverable video job ID.", "job_id_missing");
      signal.throwIfAborted();
      // Retained sources can be reprocessed even after RunPod's result has expired.
      if (!clip.source) {
        while (!job || !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)) {
          signal.throwIfAborted();
          job = await dependencies.check(clip.jobId, clip.requestId);
          await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; Object.assign(shot, jobTiming(job!)); shot.status = job!.status === "IN_PROGRESS" ? "rendering" : "queued"; return current; });
          if (!["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)) await delay(dependencies.pollMs, undefined, { signal });
        }
        if (job.status !== "COMPLETED") {
          await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; shot.status = "failed"; shot.error = job!.error || `RunPod job ${job!.status.toLowerCase()}.`; return current; });
          throw new RequestError(job.error || `RunPod job ${job.status.toLowerCase()}.`, "runpod_job_failed");
        }
        signal.throwIfAborted();
        await updateProject(id, current => { current.clips.find(shot => shot.id === clipId)!.status = "saving"; return current; });
        const source = await dependencies.download(id, `${clipId}-${clip.requestId!.slice(0, 8)}`, job.output, signal);
        await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; shot.source = source; return current; });
      }
      signal.throwIfAborted(); project = await getProject(id); clip = project.clips.find(clip => clip.id === clipId)!;
      const outputId = clip.versions?.length ? `${clipId}-${clip.requestId!.slice(0, 8)}` : clipId;
      const saved = await dependencies.finalize(id, outputId, clip.source!, clip.duration, signal, { maxSeconds: clip.endpoint === "apimart" ? 30 : 10, automatic: clip.requestedDuration === -1 });
      signal.throwIfAborted();
      await updateProject(id, current => { const shot = current.clips.find(shot => shot.id === clipId)!; Object.assign(shot, saved, { source: saved.video, extractedFrame: saved.frame, frameReplaced: false, continuityOutdated: false, status: "complete", error: undefined }); if (shot.versions?.length) markFollowingContinuityOutdated(current, clipId); return current; });
      // Commit the final video/frame first so an interrupted cleanup cannot lose a take.
      await discardProcessedSource(id, clip.source!, saved.video);
      if (clip.requestId) await archiveAgentOutput(clip.requestId, new URL(assetUrl(id, "video", clipId), appOrigin()).href);
      const sequence = await getProject(id);
      const next = sequence.clips[sequence.clips.findIndex(item => item.id === clipId) + 1];
      if (next && needsPreviousPrompt(sequence, next) && !next.jobId && !next.requestId && !next.source && ["pending", "awaiting-approval"].includes(next.status)) {
        try {
          await prepareSequentialPrompt(id, next.id, sequence.model, signal, sequence.reasoningEffort);
        } catch (error) {
          await updateProject(id, current => { const target = current.clips.find(item => item.id === next.id)!; target.promptContextKey = undefined; target.promptPlanError = signal.aborted ? "Prompt planning paused. Retry planning from the saved last frame." : error instanceof RequestError ? error.message : "Could not plan the next prompt. The completed clip is saved; retry prompt planning."; return current; });
        }
        await updateProject(id, current => { current.status = "paused"; current.runClipId = undefined; current.error = undefined; return current; });
        return;
      }
      const reviewed = await getProject(id);
      if (!scopeId && reviewed.reviewAfterEachClip !== false && reviewed.clips.some(clip => clip.status !== "complete")) {
        await updateProject(id, current => { current.status = "paused"; current.error = undefined; return current; });
        return;
      }
    }
    await updateProject(id, project => { project.status = project.clips.every(clip => clip.status === "complete") ? "complete" : "paused"; project.runClipId = undefined; project.error = undefined; return project; });
  } catch (error) {
    const message = signal.aborted ? "Agent paused. Existing video jobs can continue; resume to recover and save their output." : error instanceof RequestError ? error.message : "The agent stopped unexpectedly. Resume to recover saved jobs; no submission will be retried automatically.";
    await updateProject(id, project => { project.status = "paused"; project.error = message; const clip = project.clips.find(clip => clip.id === activeClipId); if (clip && !["complete", "failed", "submission-unknown"].includes(clip.status)) { clip.status = clip.jobId ? "recoverable" : clip.requestId ? "submission-unknown" : "pending"; clip.error = message; } return project; }).catch(() => undefined);
  } finally { if (state.active?.controller === controller) state.active = undefined; }
}
export async function pauseProject(id: string) {
  if (state.active && state.active.projectId !== id) throw new RequestError("A different project is active.", "project_busy");
  state.active?.controller.abort();
  return updateProject(id, project => { project.status = "paused"; project.error = "Agent paused. Any submitted video job continues and will be recovered on resume."; return project; });
}
export async function recoverClip(id: string, clipId: string, jobId: string) {
  assertEditable(id); const project = await getProject(id); const clip = project.clips.find(clip => clip.id === clipId);
  if (!clip?.requestId || clip.status === "complete") throw new RequestError("This shot does not need job recovery.", "invalid_clip_state");
  const job = await checkGeneration(jobId, clip.requestId);
  return updateProject(id, current => { assertEditable(id); const shot = current.clips.find(shot => shot.id === clipId)!; Object.assign(shot, jobTiming(job)); shot.jobId = job.id; shot.endpoint = job.endpoint; shot.status = "recoverable"; shot.error = undefined; current.error = undefined; current.status = "paused"; return current; });
}
export async function retryClip(id: string, clipId: string, reviewed = false) {
  assertEditable(id); const project = await getProject(id); const clip = project.clips.find(clip => clip.id === clipId);
  if (!clip || clip.status === "complete" || !["failed", "submission-unknown", "submitting"].includes(clip.status)) throw new RequestError("This shot cannot be retried in its current state.", "invalid_clip_state");
  const job = clip.requestId ? (await jobHistory()).find(job => job.localId === clip.requestId) : undefined;
  if (job?.id) {
    await assertReplaceableJob(job.id, clip.requestId);
  } else if (job && ["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(job.status)) {
    if (!reviewed) throw new RequestError(job.endpoint === "apimart" ? "Review your API Mart tasks before resolving an uncertain submission." : "Review the RunPod console before resolving an uncertain submission.", "review_required");
    await resolveUnknown(job.localId);
  } else if (clip.status === "submission-unknown" && !reviewed) throw new RequestError("Review the RunPod console before retrying.", "review_required");
  return updateProject(id, current => { assertEditable(id); const shot = current.clips.find(shot => shot.id === clipId)!; shot.status = "pending"; shot.requestId = undefined; shot.latentId = undefined; shot.previousLatentId = undefined; shot.delayTime = undefined; shot.executionTime = undefined; shot.jobId = undefined; shot.compiledPrompt = undefined; shot.endpoint = undefined; shot.error = undefined; shot.source = undefined; current.status = "ready"; current.error = undefined; return current; });
}
