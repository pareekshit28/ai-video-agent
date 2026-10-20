import type { PublicProject } from "./agent-types";
import type { H3Job } from "./h3";

export type GenerationTabStatus = { label: string; state: "working" | "attention" | "complete" | "idle" };
export const defaultTabTitle = "AI Video Agent · Prompt Studio";

export function agentTabStatus(project: PublicProject | null, operation?: string): GenerationTabStatus | null {
  if (operation) return { label: operation, state: "working" };
  if (!project?.clips.length) return null;
  const clips = project.clips, total = clips.length;
  const saved = clips.filter(clip => clip.status === "complete").length;
  const selected = clips.findIndex(clip => clip.id === project.runClipId);
  const working = clips.findIndex(clip => ["preparing", "submitting", "queued", "rendering", "saving"].includes(clip.status));
  const next = clips.findIndex(clip => clip.status !== "complete");
  const number = (index: number) => `${index + 1}/${total}`;
  if (project.active) {
    if (saved === total) return { label: `Finalizing · ${saved}/${total} clips saved`, state: "working" };
    const following = clips[selected + 1];
    if (selected >= 0 && clips[selected].status === "complete" && following && project.sequentialPrompts !== false && ["pending", "awaiting-approval"].includes(following.status) && !following.jobId && !following.source) return { label: `Planning clip ${number(selected + 1)} · ${saved} saved`, state: "working" };
    const index = working >= 0 ? working : selected >= 0 && clips[selected].status !== "complete" ? selected : Math.max(0, next);
    const phase: Record<string, string> = { preparing: "Preparing", submitting: "Submitting", queued: "Queued", rendering: "Rendering", saving: "Saving" };
    return { label: `${phase[clips[index].status] || "Preparing"} clip ${number(index)} · ${saved} saved`, state: "working" };
  }
  const problem = clips.findIndex(clip => ["failed", "submission-unknown", "recoverable", "submitting"].includes(clip.status));
  if (problem >= 0) {
    const clip = clips[problem];
    const phase = clip.status === "failed" ? "Failed" : clip.status === "submission-unknown" || clip.status === "submitting" ? "Recover job for" : "Resume";
    return { label: `${phase} clip ${number(problem)} · ${saved} saved`, state: "attention" };
  }
  if (saved === total) return { label: `Done · ${saved}/${total} clips saved`, state: "complete" };
  if (next >= 0 && clips[next].promptPlanError) return { label: `Prompt needs attention · clip ${number(next)}`, state: "attention" };
  if (project.error) return { label: `Paused · clip ${number(Math.max(0, next))} · ${saved} saved`, state: "attention" };
  if (next >= 0 && (saved > 0 || clips[next].status === "awaiting-approval")) return { label: `Review clip ${number(next)} · ${saved} saved`, state: "attention" };
  return null;
}

export function studioTabStatus(job: H3Job | null, submitting: boolean, polling: boolean, error: string): GenerationTabStatus | null {
  if (submitting) return { label: "Submitting video · Studio", state: "working" };
  if (!job) return null;
  if (job.status === "COMPLETED") return { label: "Video complete · Studio", state: "complete" };
  if (["FAILED", "CANCELLED", "TIMED_OUT", "REJECTED"].includes(job.status)) return { label: `${job.status === "TIMED_OUT" ? "Timed out" : job.status === "CANCELLED" ? "Cancelled" : "Failed"} · Studio video`, state: "attention" };
  if (["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(job.status)) return { label: "Recover job · Studio", state: "attention" };
  if (!polling) return { label: error ? "Check video status · Studio" : "Polling paused · Studio", state: "attention" };
  return { label: `${job.status === "IN_QUEUE" ? "Queued" : job.status === "IN_PROGRESS" ? "Rendering" : "Processing"} video · Studio`, state: "working" };
}

export function selectTabStatus(agent: GenerationTabStatus | null, studio: GenerationTabStatus | null, preferStudio: boolean) {
  const ordered = preferStudio ? [studio, agent] : [agent, studio];
  return ordered.find(status => status?.state === "working") || ordered.find(status => status !== null) || null;
}

export function generationTabTitle(status: GenerationTabStatus | null, tick = 0) {
  if (!status) return defaultTabTitle;
  const marker = status.state === "working" ? ["◐", "◓", "◑", "◒"][tick % 4] : status.state === "attention" ? "⚠" : status.state === "complete" ? "✓" : "•";
  return `${marker} ${status.label} · AI Video Agent`;
}
