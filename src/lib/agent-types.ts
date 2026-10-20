import type { ReasoningEffort } from "./reasoning";
import { z } from "zod";
import { ratios } from "./h3";

export const entityIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const slotSchema = z.object({ id: entityIdSchema, name: z.string().trim().min(1).max(120), kind: z.enum(["character", "location", "prop"]), description: z.string().trim().min(1).max(1000) });
export const transitionSchema = z.enum(["first", "continue", "cut", "scene-change", "time-jump"]);
export const shotSchema = z.object({ id: entityIdSchema, title: z.string().trim().min(1).max(150), duration: z.number().min(2).max(10), prompt: z.string().trim().min(1).max(5000).refine(value => !/<(?:Picture|Audio|Video)\s*\d+>/i.test(value), "Reference tags are assigned after uploads."), referenceIds: z.array(entityIdSchema).max(9), continuation: z.boolean(), transition: transitionSchema.optional(), continuityReason: z.string().trim().min(1).max(400).optional(), autoContinuation: z.boolean().optional(), continuityMode: z.enum(["auto", "on", "off"]).optional() });
export const planSchema = z.object({ title: z.string().trim().min(1).max(150), summary: z.string().trim().min(1).max(1500), references: z.array(slotSchema).max(40), clips: z.array(shotSchema).min(1).max(40) }).superRefine((plan, ctx) => {
  const ids = new Set(plan.references.map(slot => slot.id));
  if (ids.size !== plan.references.length || new Set(plan.clips.map(clip => clip.id)).size !== plan.clips.length) ctx.addIssue({ code: "custom", message: "The plan contains duplicate IDs." });
  plan.clips.forEach((clip, i) => {
    if (clip.referenceIds.some(id => !ids.has(id)) || new Set(clip.referenceIds).size !== clip.referenceIds.length) ctx.addIssue({ code: "custom", message: "A clip contains invalid reference IDs." });
    if (i === 0 && clip.continuation) ctx.addIssue({ code: "custom", message: "The first clip cannot continue a previous clip." });
    if (clip.transition && ((i === 0 && clip.transition !== "first") || (i > 0 && clip.transition === "first"))) ctx.addIssue({ code: "custom", message: "Only the first clip can use the first transition." });
  });
});
export const wanShotSchema = shotSchema.extend({ duration: z.number().int().min(2).max(30) });
export const wanPlanSchema = planSchema.safeExtend({ clips: z.array(wanShotSchema).min(1).max(40) });
export const videoProviderSchema = z.enum(["runpod", "apimart"]);
export type VideoProvider = z.infer<typeof videoProviderSchema>;
export const generationSchema = z.object({ provider: videoProviderSchema.optional(), wanResolution: z.enum(["480P", "720P", "1080P"]).optional(), wanDurationMode: z.enum(["auto", "fixed"]).optional(), aspectRatio: z.enum(ratios), megapixels: z.number().min(0.25).max(4), steps: z.number().int().min(1).max(100), refImageSize: z.enum(["max", "match"]) });
export type GenerationSettings = z.infer<typeof generationSchema>;
export const defaultGeneration: GenerationSettings = { aspectRatio: ratios[0], megapixels: 1, steps: 6, refImageSize: "max" };
export type Asset = { path: string; name: string; bytes: number; mime: string; publicUrl?: string };
export type ReferenceSlot = z.infer<typeof slotSchema> & { asset?: Asset; images?: Asset[]; audios?: Asset[]; characterId?: string };
export type ClipRevision = { referenceIds?: string[]; reasoningEffort?: ReasoningEffort; prompt: string; comments: string; model: string; createdAt: number };
export type ClipVersion = { archivedAt: number; clip: Omit<AgentClip, "versions" | "revision"> };
export type AgentClip = z.infer<typeof shotSchema> & { outline?: string; promptContextKey?: string; promptFromFrame?: string; promptFromJob?: string; promptPlanError?: string; status: "awaiting-approval" | "pending" | "preparing" | "submitting" | "queued" | "rendering" | "saving" | "complete" | "recoverable" | "submission-unknown" | "failed"; approvedPromptKey?: string; compiledPrompt?: string; promptGuideVersion?: number; requestedDuration?: number; seed?: number; requestId?: string; jobId?: string; endpoint?: string; video?: Asset; frame?: Asset; extractedFrame?: Asset; frameReplaced?: boolean; source?: Asset; firstFrameFrom?: string; continuityOutdated?: boolean; revision?: ClipRevision; revisionComments?: string; versions?: ClipVersion[]; error?: string; media?: { width: number; height: number; duration: number; fps: number }; };
export type AgentProject = { sequentialPrompts?: boolean; referencesIdentified?: boolean; collectionId?: string; reasoningEffort?: ReasoningEffort; id: string; title: string; script: string; summary: string; model: string; runEndpoint?: string; runClipId?: string; reviewBeforeEachClip?: boolean; reviewAfterEachClip?: boolean; createdAt: number; updatedAt: number; status: "ready" | "preparing" | "running" | "paused" | "complete"; error?: string; settings: GenerationSettings; references: ReferenceSlot[]; clips: AgentClip[] };
export type PublicProject = AgentProject & { folder: string; active: boolean };
export function previousFrameDecision(clip: Pick<AgentClip, "continuation" | "transition" | "autoContinuation" | "continuityMode">) {
  if (clip.continuityMode === "on") return true;
  if (clip.continuityMode === "off") return false;
  return clip.transition ? clip.transition === "continue" : clip.autoContinuation ?? clip.continuation;
}
export function needsPreviousPrompt(project: Pick<AgentProject, "clips" | "sequentialPrompts">, clip: AgentClip) {
  return project.sequentialPrompts !== false && project.clips.findIndex(item => item.id === clip.id) > 0;
}
export function previousPromptAvailable(project: AgentProject, clip: AgentClip) {
  if (!needsPreviousPrompt(project, clip)) return true;
  const previous = project.clips[project.clips.findIndex(item => item.id === clip.id) - 1];
  return previous?.status === "complete" && Boolean(previous.frame && clip.promptContextKey && clip.promptFromFrame === previous.frame.path && clip.promptFromJob === previous.jobId);
}
export function suppliedReferences(project: AgentProject, clip: AgentClip) {
  return clip.referenceIds.flatMap(id => { const slot = project.references.find(slot => slot.id === id); return slot?.asset ? [slot as ReferenceSlot & { asset: Asset }] : []; });
}
export function slotImages(slot: ReferenceSlot) { return slot.images?.length ? slot.images : slot.asset ? [slot.asset] : []; }
export function suppliedImages(project: AgentProject, clip: AgentClip) {
  return clip.referenceIds.flatMap(id => { const slot = project.references.find(slot => slot.id === id); return slot ? slotImages(slot).map(asset => ({ id, name: slot.name, asset })) : []; });
}
export function suppliedAudios(project: AgentProject, clip: AgentClip) {
  return clip.referenceIds.flatMap(id => { const slot = project.references.find(slot => slot.id === id); return slot?.audios?.map(asset => ({ id, name: slot.name, asset })) || []; });
}
export function markFollowingContinuityOutdated(project: AgentProject, clipId: string) {
  const next = project.clips[project.clips.findIndex(clip => clip.id === clipId) + 1];
  if (next && project.sequentialPrompts !== false) { next.promptContextKey = undefined; next.approvedPromptKey = undefined; }
  if (next?.status === "complete" && (next.firstFrameFrom === clipId || previousFrameDecision(next))) next.continuityOutdated = true;
}
export function referenceBindings(project: AgentProject, clip: AgentClip) {
  return suppliedImages(project, clip).map((slot, index) => ({ id: slot.id, name: slot.name, tag: `<Picture ${index + 1}>` }));
}
export function audioBindings(project: AgentProject, clip: AgentClip) { return suppliedAudios(project, clip).map((slot, index) => ({ id: slot.id, name: slot.name, tag: `<Audio ${index + 1}>` })); }
export function finalPrompt(project: AgentProject, clip: AgentClip) {
  const bindings = referenceBindings(project, clip);
  const text = clip.compiledPrompt || clip.prompt;
  if (/<(?:Picture|Audio|Video)\s*\d+>/i.test(text)) throw new Error("The clip prompt contains manually assigned reference tags. Remove them and compile again.");
  if (project.settings.provider === "apimart") {
    const references = bindings.map(ref => {
      const kind = project.references.find(slot => slot.id === ref.id)?.kind;
      const role = kind === "location" ? "the setting, spatial layout and environmental details" : kind === "prop" ? "the object's shape, material and appearance" : "the character's identity and appearance";
      return `${ref.tag} is the supplied reference for ${ref.name}. Use it for ${role}; do not transfer unrelated subjects or actions from this image.`;
    });
    return [...references, ...audioBindings(project, clip).map(ref => `${ref.tag} supplies ${ref.name}'s voice timbre. Use this voice for their scripted dialogue, not the sample's spoken words.`), text].join("\n\n");
  }
  return [...bindings.map(ref => `${ref.tag} is the supplied reference for ${ref.name}. Use this image as the authority for their visual appearance.`), ...audioBindings(project, clip).map(ref => `${ref.tag} is the supplied voice reference for ${ref.name}. Preserve this voice for their dialogue.`), text, ...(previousFrameDecision(clip) ? ["Begin on the supplied frame-zero guide and continue the preceding action without resetting the scene."] : [])].join("\n\n");
}
export function assetUrl(projectId: string, kind: "video" | "frame" | "reference", id: string, download = false) {
  return `/api/agent/media?projectId=${encodeURIComponent(projectId)}&kind=${kind}&id=${encodeURIComponent(id)}${download ? "&download=1" : ""}`;
}
