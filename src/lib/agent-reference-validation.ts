import { previousFrameDecision, suppliedImages, suppliedAudios, type AgentClip, type AgentProject } from "./agent-types";
import { MAX_IMAGE_REFERENCES, MAX_INLINE_REFERENCE_BYTES, referenceSize } from "./reference-limits";
import { publicReferenceUrlSchema } from "./public-reference-url";

export function clipReferenceBudget(project: AgentProject, clip: AgentClip) {
  const refs = suppliedImages(project, clip), audios = suppliedAudios(project, clip);
  const previous = project.clips[project.clips.findIndex(item => item.id === clip.id) - 1];
  const usesFrame = previousFrameDecision(clip) && Boolean(previous);
  const frameBytes = usesFrame ? previous?.frame?.bytes || 0 : 0;
  const bytes = [...refs, ...audios].reduce((sum, slot) => sum + slot.asset.bytes, 0) + frameBytes;
  const issues: string[] = [];
  if (project.settings.provider === "apimart") {
    if (!Number.isInteger(clip.duration)) issues.push("Wan requires a whole number of seconds for the clip duration.");
    if (refs.length + Number(usesFrame) > 10) issues.push("Wan supports at most 10 image references including the previous clip's last frame.");
    if (audios.length > 5) issues.push("Wan supports at most 5 voice references.");
    if (!refs.length && !audios.length && !usesFrame) issues.push("Wan reference mode requires a supplied image or voice reference.");
    if (audios.some(ref => !publicReferenceUrlSchema.safeParse(ref.asset.publicUrl).success)) issues.push("Add a public HTTPS voice URL for each supplied voice sample before using Wan.");
    if (audios.some(ref => !/\.(wav|mp3)$/i.test(ref.asset.path))) issues.push("Wan voice references must be WAV or MP3, each 1–15 seconds and at most 15 seconds combined.");
    return { count: refs.length + Number(usesFrame), audioCount: audios.length, bytes, frameBytes, pendingFrame: usesFrame && !previous?.frame, error: issues.join(" ") };
  }
  if (refs.length > MAX_IMAGE_REFERENCES) issues.push(`${refs.length} selected images exceeds the ${MAX_IMAGE_REFERENCES}-image limit. Uncheck ${refs.length - MAX_IMAGE_REFERENCES} or more references under “Choose references for this clip”.`);
  if (audios.length > 3) issues.push(`${audios.length} selected audio references exceeds the 3-audio limit. Uncheck references under “Choose references for this clip”.`);
  if (bytes > MAX_INLINE_REFERENCE_BYTES) issues.push(`${referenceSize(bytes)} of selected references${frameBytes ? " including the previous clip’s last frame" : ""} exceeds the 6 MB limit. Reduce by at least ${referenceSize(bytes - MAX_INLINE_REFERENCE_BYTES)}: compress or replace images, or uncheck references under “Choose references for this clip”.`);
  return { count: refs.length, audioCount: audios.length, bytes, frameBytes, pendingFrame: usesFrame && !previous?.frame, error: issues.join(" ") };
}

export function projectReferenceIssues(project: AgentProject) {
  return project.clips.flatMap((clip, index) => {
    // Resuming an existing render or retained source does not upload references again.
    if (clip.status === "complete" || clip.jobId || clip.source) return [];
    const budget = clipReferenceBudget(project, clip);
    return budget.error ? [{ clipId: clip.id, message: `Clip ${index + 1} (${clip.title}): ${budget.error}` }] : [];
  });
}
