import { defaultReasoningEffort, reasoningEffortSchema } from "@/lib/reasoning";
import { z } from "zod";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { jobHistory, readJson } from "@/lib/runpod";
import { getProject, updateProject } from "@/lib/agent-store";
import { generationSchema, needsPreviousPrompt, planningMaxDuration, previousFrameDecision, shotSchema, wanShotSchema, entityIdSchema, type AgentProject } from "@/lib/agent-types";
import { optimizeScriptPlan, reviseClipPrompt, planFromReferences } from "@/lib/agent-llm";
import { assertEditable, isProjectActive, publicProject, recoverClip, retryClip } from "@/lib/agent-runner";
import { RequestError } from "@/lib/request-error";
import { promptApprovalKey } from "@/lib/prompt-approval";
import { wanPromptGuideVersion } from "@/lib/wan-prompt-guide";
import { prepareSequentialPrompt, assertPreviousPromptReady, previousPromptKey, matchingPreviousPromptKey, promptPlanningSettings } from "@/lib/sequential-prompts";
export const runtime = "nodejs";
export const maxDuration = 300;
const mutation = z.discriminatedUnion("action", [
  z.object({ projectId: z.uuid(), action: z.literal("setDuration"), clipId: entityIdSchema, duration: z.number() }),
  z.object({ projectId: z.uuid(), action: z.literal("planNextPrompt"), clipId: entityIdSchema, model: z.string().min(1).max(150), reasoningEffort: reasoningEffortSchema.optional(), prompt: shotSchema.shape.prompt.optional(), referenceIds: z.array(entityIdSchema).max(9).optional() }),
  z.object({ projectId: z.uuid(), action: z.literal("plan"), model: z.string().min(1).max(150), reasoningEffort: reasoningEffortSchema.optional(), maxClipDuration: z.number().optional() }),
  z.object({ projectId: z.uuid(), action: z.literal("prepareClip"), clipId: entityIdSchema, prompt: shotSchema.shape.prompt, referenceIds: z.array(entityIdSchema).max(9) }),
  z.object({ projectId: z.uuid(), action: z.literal("approvePrompt"), clipId: entityIdSchema, prompt: shotSchema.shape.prompt }),
  z.object({ projectId: z.uuid(), action: z.literal("edit"), clip: shotSchema.or(wanShotSchema).optional(), settings: generationSchema.optional(), reviewBeforeEachClip: z.boolean().optional(), reviewAfterEachClip: z.boolean().optional() }),
  z.object({ projectId: z.uuid(), action: z.literal("recover"), clipId: z.string(), jobId: z.string() }),
  z.object({ projectId: z.uuid(), action: z.literal("retry"), clipId: z.string(), reviewed: z.boolean().optional() }),
  z.object({ projectId: z.uuid(), action: z.literal("optimize"), model: z.string().min(1).max(150), reasoningEffort: reasoningEffortSchema.optional() }),
  z.object({ projectId: z.uuid(), action: z.literal("revise"), clipId: z.string(), comments: z.string().trim().min(1).max(4000), prompt: shotSchema.shape.prompt.optional(), referenceIds: z.array(entityIdSchema).max(9).optional(), model: z.string().min(1).max(150), reasoningEffort: reasoningEffortSchema.optional() }),
  z.object({ projectId: z.uuid(), action: z.literal("editRevision"), clipId: z.string(), prompt: shotSchema.shape.prompt, referenceIds: z.array(entityIdSchema).max(9) }),
]);
function validateReferences(project: AgentProject, ids: string[]) {
  if (new Set(ids).size !== ids.length || ids.some(id => !project.references.some(slot => slot.id === id))) throw new RequestError("Choose valid scene references without duplicates.", "invalid_reference");
  return ids;
}
export async function GET(request: Request) {
  try { assertLocalRequest(request); const id = new URL(request.url).searchParams.get("projectId") || ""; const [project, history] = await Promise.all([getProject(id), jobHistory()]); return Response.json({ project: publicProject(project, history) }, { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true); const parsed = mutation.safeParse(await readJson(request, 50000));
    if (!parsed.success) throw new RequestError(parsed.error.issues[0].message, "invalid_project_edit");
    const data = parsed.data;
    if (data.action === "setDuration") {
      const project = await updateProject(data.projectId, current => {
        const clip = current.clips.find(item => item.id === data.clipId);
        if (!clip) throw new RequestError("Choose an existing clip.", "invalid_clip_state");
        const schema = current.settings.provider === "apimart" ? wanShotSchema.shape.duration : shotSchema.shape.duration;
        if (!schema.safeParse(data.duration).success) throw new RequestError("Use 2-30 whole seconds for Wan or 2-10 seconds for H3.", "invalid_duration");
        if ((clip.nextDuration ?? clip.duration) === data.duration) return current;
        if (isProjectActive(current.id) || clip.requestId || clip.jobId || clip.source || !["pending", "awaiting-approval"].includes(clip.status)) {
          clip.nextDuration = data.duration === clip.duration ? undefined : data.duration;
        } else { clip.duration = data.duration; clip.nextDuration = undefined; }
        clip.approvedPromptKey = undefined;
        clip.promptContextKey = undefined;
        return current;
      });
      return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
    }
    assertEditable(data.projectId);
    let project;
    if (data.action === "planNextPrompt") project = await prepareSequentialPrompt(data.projectId, data.clipId, data.model, request.signal, data.reasoningEffort, { prompt: data.prompt, referenceIds: data.referenceIds });
    else if (data.action === "plan") {
      const snapshot = await getProject(data.projectId);
      if (!snapshot.script.trim() || (!snapshot.referencesIdentified && !snapshot.references.length)) throw new RequestError("Identify scene references before planning clips.", "references_not_identified");
      if (snapshot.clips.length) throw new RequestError("This scene already has a clip plan. Edit its prompts individually.", "plan_locked");
      if (snapshot.settings.provider === "apimart" && !snapshot.references.some(slot => slot.asset || slot.images?.length || slot.audios?.length)) throw new RequestError("Supply at least one image or voice reference before planning Wan clips.", "missing_reference");
      const effort = data.reasoningEffort || snapshot.reasoningEffort || defaultReasoningEffort;
      const maxClipDuration = data.maxClipDuration ?? planningMaxDuration(snapshot);
      const durationSchema = (snapshot.settings.provider === "apimart" ? wanShotSchema : shotSchema).shape.duration;
      if (!durationSchema.safeParse(maxClipDuration).success) throw new RequestError("Use a maximum from 2–10 seconds for H3 or 2–30 whole seconds for Wan.", "invalid_duration");
      const clips = await planFromReferences({ ...snapshot, maxClipDuration }, data.model, request.signal, effort);
      project = await updateProject(data.projectId, current => {
        assertEditable(data.projectId);
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new RequestError("References changed while planning. Try again to use the latest references.", "project_changed");
        current.sequentialPrompts = true;
        current.maxClipDuration = maxClipDuration;
        current.clips = clips.map((clip, index) => ({ ...clip, outline: clip.prompt, compiledPrompt: index ? undefined : clip.prompt, promptGuideVersion: wanPromptGuideVersion, status: "pending" }));
        current.model = data.model; current.reasoningEffort = effort; current.status = "ready"; current.error = undefined;
        return current;
      });
    }
    else if (data.action === "prepareClip") project = await updateProject(data.projectId, current => {
      assertEditable(data.projectId);
      const clip = current.clips.find(item => item.id === data.clipId);
      if (!clip || !["pending", "awaiting-approval", "complete", "failed"].includes(clip.status)) throw new RequestError("Resume or recover this clip's existing job before generating again.", "invalid_clip_state");
      const referenceIds = validateReferences(current, data.referenceIds);
      const contextKey = assertPreviousPromptReady(current, { ...clip, referenceIds });
      if (contextKey) clip.promptContextKey = contextKey;
      if (["complete", "failed"].includes(clip.status)) {
        clip.revision = { prompt: data.prompt, referenceIds, comments: clip.revision?.comments || "", model: current.model, createdAt: Date.now() };
      } else {
        if (clip.jobId || clip.requestId || clip.source) throw new RequestError("Recover the submitted clip before editing its prompt.", "clip_locked");
        Object.assign(clip, { prompt: data.prompt, compiledPrompt: data.prompt, referenceIds, revision: undefined, promptGuideVersion: wanPromptGuideVersion, status: "pending" });
        clip.approvedPromptKey = promptApprovalKey(current, clip);
      }
      current.error = undefined;
      return current;
    });
    else if (data.action === "approvePrompt") project = await updateProject(data.projectId, current => {
      assertEditable(data.projectId);
      const clip = current.clips.find(item => item.id === data.clipId);
      if (!clip || clip.status !== "awaiting-approval" || clip.jobId || clip.requestId) throw new RequestError("Prepare this clip for prompt review before approving it.", "invalid_clip_state");
      const contextKey = assertPreviousPromptReady(current, clip);
      if (contextKey) clip.promptContextKey = contextKey;
      clip.compiledPrompt = data.prompt;
      if (current.settings.provider === "apimart") clip.promptGuideVersion = wanPromptGuideVersion;
      clip.approvedPromptKey = promptApprovalKey(current, clip);
      clip.status = "pending"; current.error = undefined;
      return current;
    });
    else if (data.action === "recover") project = await recoverClip(data.projectId, data.clipId, data.jobId);
    else if (data.action === "retry") project = await retryClip(data.projectId, data.clipId, data.reviewed);
    else if (data.action === "editRevision") project = await updateProject(data.projectId, current => {
      assertEditable(data.projectId);
      const clip = current.clips.find(clip => clip.id === data.clipId);
      if (!clip?.revision || !["complete", "failed"].includes(clip.status)) throw new RequestError("Prepare a revised prompt before editing it.", "invalid_clip_state");
      clip.revision = { ...clip.revision, prompt: data.prompt, referenceIds: validateReferences(current, data.referenceIds) };
      return current;
    });
    else if (data.action === "revise") {
      const snapshot = await getProject(data.projectId);
      const clip = snapshot.clips.find(clip => clip.id === data.clipId);
      if (!clip || !["pending", "awaiting-approval", "complete", "failed"].includes(clip.status) || (!["complete", "failed"].includes(clip.status) && (clip.requestId || clip.jobId || clip.source))) throw new RequestError("Finish or recover this clip before requesting a revision.", "invalid_clip_state");
      const referenceIds = validateReferences(snapshot, data.referenceIds ?? clip.referenceIds);
      const contextKey = needsPreviousPrompt(snapshot, clip) ? previousPromptKey(snapshot, { ...clip, referenceIds }) : undefined;
      const context = { ...snapshot, clips: snapshot.clips.map(item => item.id === clip.id ? { ...item, referenceIds, compiledPrompt: data.prompt || item.revision?.prompt || item.compiledPrompt || item.prompt } : item) };
      const prompt = await reviseClipPrompt(context, data.clipId, data.comments, data.model, request.signal, data.reasoningEffort || snapshot.reasoningEffort || defaultReasoningEffort);
      project = await updateProject(data.projectId, current => {
        assertEditable(data.projectId);
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new RequestError("The project changed while revising. Your saved clip was kept; try again.", "project_changed");
        if (contextKey && previousPromptKey(current, { ...clip, referenceIds }) !== contextKey) throw new RequestError("The previous frame changed while revising. Refresh this prompt again.", "project_changed");
        current.clips.find(clip => clip.id === data.clipId)!.revision = { prompt, referenceIds, comments: data.comments, model: data.model, reasoningEffort: data.reasoningEffort || snapshot.reasoningEffort || defaultReasoningEffort, createdAt: Date.now() };
        if (contextKey) Object.assign(current.clips.find(item => item.id === data.clipId)!, { promptContextKey: contextKey, promptFromFrame: current.clips[current.clips.findIndex(item => item.id === data.clipId) - 1].frame?.path, promptFromLatent: current.clips[current.clips.findIndex(item => item.id === data.clipId) - 1].latentId, promptFromJob: current.clips[current.clips.findIndex(item => item.id === data.clipId) - 1].jobId, promptPlanError: undefined });
        current.reasoningEffort = data.reasoningEffort || snapshot.reasoningEffort || defaultReasoningEffort;
        return current;
      });
    }
    else if (data.action === "optimize") {
      const snapshot = await getProject(data.projectId);
      if (snapshot.clips.some(clip => clip.requestId || clip.jobId || clip.source || clip.status === "complete")) throw new RequestError("Only an unsubmitted plan can be optimized. Existing jobs and saved videos must keep their clip IDs.", "plan_locked");
      const clips = await optimizeScriptPlan(snapshot, data.model, request.signal);
      project = await updateProject(data.projectId, current => {
        assertEditable(data.projectId);
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new RequestError("The project changed while optimizing. Your current plan was kept; try again.", "project_changed");
        current.clips = clips.map(clip => ({ ...clip, status: "pending" })); current.model = data.model; current.reasoningEffort = data.reasoningEffort || snapshot.reasoningEffort || defaultReasoningEffort; current.status = "ready"; current.error = undefined; return current;
      });
    }
    else project = await updateProject(data.projectId, current => {
      assertEditable(data.projectId);
      if (data.clip) {
        const schema = (data.settings || current.settings).provider === "apimart" ? wanShotSchema : shotSchema;
        if (!schema.safeParse(data.clip).success) throw new RequestError("Use 2–30 whole seconds for Wan or 2–10 seconds for H3.", "invalid_duration");
        const index = current.clips.findIndex(clip => clip.id === data.clip!.id); const clip = current.clips[index];
        if (!clip || clip.requestId || clip.jobId || clip.status === "complete") throw new RequestError("Submitted clips cannot be edited. Recover the existing job or retry a confirmed failed job.", "clip_locked");
        const changed = { ...clip, ...data.clip, autoContinuation: clip.autoContinuation ?? (clip.transition ? clip.transition === "continue" : clip.continuation), transition: clip.transition, continuityReason: clip.continuityReason };
        const continuation = previousFrameDecision(changed);
        if ((index === 0 && continuation) || data.clip.referenceIds.some(id => !current.references.some(slot => slot.id === id)) || new Set(data.clip.referenceIds).size !== data.clip.referenceIds.length) throw new RequestError("Invalid reference selection or continuity setting.", "invalid_clip_edit");
        Object.assign(clip, changed, { continuation, compiledPrompt: undefined, error: undefined, status: "pending" });
        if (needsPreviousPrompt(current, clip)) clip.promptContextKey = undefined;
      }
      if (data.settings) {
        if ((data.settings.provider || "runpod") !== (current.settings.provider || "runpod") && current.clips.some(clip => clip.status !== "complete" && (clip.requestId || clip.jobId || clip.source))) throw new RequestError("Resolve unfinished jobs before switching video providers. Existing jobs must be resumed with their original provider.", "provider_locked");
        const planningUnchanged = JSON.stringify(promptPlanningSettings(current.settings)) === JSON.stringify(promptPlanningSettings(data.settings));
        current.settings = data.settings;
        if (current.clips.some(clip => !clip.requestId && !clip.jobId && clip.status !== "complete" && !(data.settings!.provider === "apimart" ? wanShotSchema : shotSchema).safeParse({ ...clip, duration: clip.nextDuration ?? clip.duration }).success)) throw new RequestError("Adjust unfinished clip durations before switching providers: H3 supports 2–10 seconds and Wan supports 2–30 whole seconds.", "invalid_duration");
        if (planningUnchanged) {
          for (const clip of current.clips) {
            clip.approvedPromptKey = undefined;
            if (needsPreviousPrompt(current, clip) && clip.promptContextKey) {
              try { const key = matchingPreviousPromptKey(current, clip); if (key) clip.promptContextKey = key; }
              catch { /* An unfinished or unavailable preceding frame must still be recovered. */ }
            }
          }
        } else for (const clip of current.clips) if (!clip.requestId && !clip.jobId && clip.status !== "complete") { clip.compiledPrompt = undefined; clip.promptContextKey = undefined; }
      }
      if (data.reviewBeforeEachClip !== undefined) current.reviewBeforeEachClip = data.reviewBeforeEachClip;
      if (data.reviewAfterEachClip !== undefined) current.reviewAfterEachClip = data.reviewAfterEachClip;
      if (data.clip || data.settings) { current.status = "ready"; current.error = undefined; }
      return current;
    });
    return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
