import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assetPath, getProject, updateProject } from "./agent-store";
import { needsPreviousPrompt, previousFrameDecision, suppliedImages, suppliedAudios, type AgentProject, type AgentClip, type GenerationSettings } from "./agent-types";
import { planFollowingClipPrompt } from "./agent-llm";
import { RequestError } from "./request-error";
import { wanPromptGuideVersion } from "./wan-prompt-guide";
import type { ReasoningEffort } from "./reasoning";

// Sampling effort affects rendering, not what the LLM observed when planning.
export function promptPlanningSettings(settings: GenerationSettings) {
  return { provider: settings.provider || "runpod", aspectRatio: settings.aspectRatio, megapixels: settings.megapixels, refImageSize: settings.refImageSize, wanResolution: settings.wanResolution || "720P", wanDurationMode: settings.wanDurationMode || "auto" };
}

// Read media once when checking an older fingerprint against its original step count.
function promptFingerprint(project: AgentProject, clip: AgentClip) {
  const previous = project.clips[project.clips.findIndex(item => item.id === clip.id) - 1];
  if (!previous?.frame || previous.status !== "complete") throw new RequestError("Finish the previous clip and save its last frame before planning this prompt.", "previous_clip_unfinished");
  const observed = { id: previous.id, prompt: previous.compiledPrompt || previous.prompt, frame: previous.frame, video: previous.video, jobId: previous.jobId, media: previous.media };
  const content: (string | Buffer)[] = [readFileSync(assetPath(project.id, previous.frame.path))];
  for (const reference of [...suppliedImages(project, clip), ...suppliedAudios(project, clip)]) {
    content.push(JSON.stringify(reference), readFileSync(assetPath(project.id, reference.asset.path)));
  }
  return (settings: unknown) => {
    const hash = createHash("sha256");
    hash.update(JSON.stringify({ previous: observed, target: { duration: clip.duration, references: clip.referenceIds, continuation: previousFrameDecision(clip), settings } }));
    for (const part of content) hash.update(part);
    return hash.digest("hex");
  };
}

// Bind planning to the actual saved take and frame, even if a file is replaced in place.
export function previousPromptKey(project: AgentProject, clip: AgentClip) {
  return `v2:${promptFingerprint(project, clip)(promptPlanningSettings(project.settings))}`;
}

export function matchingPreviousPromptKey(project: AgentProject, clip: AgentClip) {
  if (!clip.promptContextKey) return undefined;
  const fingerprint = promptFingerprint(project, clip);
  const key = `v2:${fingerprint(promptPlanningSettings(project.settings))}`;
  if (clip.promptContextKey === key) return key;
  if (!/^[a-f0-9]{64}$/.test(clip.promptContextKey)) return undefined;
  // Before v2, steps were part of this key. Recover those saved prompts only if
  // the current frame, take, references and all other settings still match.
  for (const steps of new Set([project.settings.steps, ...Array.from({ length: 100 }, (_, index) => index + 1)])) {
    const settings = { ...project.settings, steps };
    // Initial scene creation appended provider after the H3 defaults; edits use schema order.
    const initialOrder = { aspectRatio: settings.aspectRatio, megapixels: settings.megapixels, steps, refImageSize: settings.refImageSize, ...(settings.provider ? { provider: settings.provider } : {}), ...(settings.wanResolution ? { wanResolution: settings.wanResolution } : {}), ...(settings.wanDurationMode ? { wanDurationMode: settings.wanDurationMode } : {}) };
    if ([settings, initialOrder].some(value => fingerprint(value) === clip.promptContextKey)) return key;
  }
  return undefined;
}

export function assertPreviousPromptReady(project: AgentProject, clip: AgentClip) {
  if (!needsPreviousPrompt(project, clip)) return undefined;
  const key = matchingPreviousPromptKey(project, clip);
  if (!key) throw new RequestError("Plan this prompt from the previous clip's current last frame, review it, then generate.", "sequential_prompt_required");
  return key;
}

export async function prepareSequentialPrompt(id: string, clipId: string, model: string, signal?: AbortSignal, effort?: ReasoningEffort, edits?: { prompt?: string; referenceIds?: string[] }) {
  const snapshot = await getProject(id);
  const index = snapshot.clips.findIndex(item => item.id === clipId);
  const original = snapshot.clips[index];
  if (!original || index < 1 || !needsPreviousPrompt(snapshot, original) || !["pending", "awaiting-approval", "complete", "failed"].includes(original.status) || (!["complete", "failed"].includes(original.status) && (original.jobId || original.requestId || original.source))) throw new RequestError("Choose an unsubmitted or finished sequential clip to plan.", "invalid_clip_state");
  const clip = { ...original, referenceIds: edits?.referenceIds ?? original.revision?.referenceIds ?? original.referenceIds, ...(edits?.prompt ? { compiledPrompt: edits.prompt, revision: original.revision ? { ...original.revision, prompt: edits.prompt } : undefined } : {}) };
  if (new Set(clip.referenceIds).size !== clip.referenceIds.length || clip.referenceIds.some(ref => !snapshot.references.some(slot => slot.id === ref))) throw new RequestError("Choose valid scene references.", "invalid_reference");
  const context = { ...snapshot, clips: snapshot.clips.map(item => item.id === clipId ? clip : item) };
  const key = previousPromptKey(context, clip);
  const prompt = await planFollowingClipPrompt(context, clipId, model, signal, effort || snapshot.reasoningEffort || "low");
  signal?.throwIfAborted();
  return updateProject(id, current => {
    if (JSON.stringify(current) !== JSON.stringify(snapshot) || previousPromptKey(context, clip) !== key) throw new RequestError("The scene or previous frame changed while planning. Saved edits were kept; refresh this prompt again.", "project_changed");
    const target = current.clips[index];
    if (["complete", "failed"].includes(target.status)) target.revision = { ...target.revision, prompt, referenceIds: clip.referenceIds, comments: target.revision?.comments || "", model, createdAt: Date.now() };
    else Object.assign(target, { outline: target.outline || target.prompt, prompt, compiledPrompt: prompt, referenceIds: clip.referenceIds, revision: undefined, status: "pending", promptGuideVersion: wanPromptGuideVersion });
    target.promptContextKey = key; target.promptFromFrame = current.clips[index - 1].frame!.path;
    target.promptFromJob = current.clips[index - 1].jobId; target.promptPlanError = undefined; target.approvedPromptKey = undefined;
    return current;
  });
}
