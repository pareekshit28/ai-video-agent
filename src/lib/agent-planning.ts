import type { z } from "zod";
import { planSchema, previousFrameDecision } from "./agent-types";

type Plan = z.infer<typeof planSchema>;
type Shot = Plan["clips"][number];
const time = (seconds: number) => String(Math.round(seconds * 100) / 100);

// Pack consecutive continuous actions without changing their duration or order.
// A scene cut, time jump, manual override, or reference limit is a hard boundary.
export function compactPlan(plan: Plan, maxSeconds = 10): Plan {
  const groups: Shot[][] = [];
  for (const shot of plan.clips) {
    const group = groups.at(-1);
    const next = group ? [...group, shot] : [shot];
    const duration = next.reduce((sum, clip) => sum + clip.duration, 0);
    const refs = new Set(next.flatMap(clip => clip.referenceIds));
    let start = 0;
    const prompt = next.length === 1 ? shot.prompt : next.map(clip => { const end = start + clip.duration; const text = `${time(start)}–${time(end)}s: ${clip.prompt}`; start = end; return text; }).join("\n\n");
    const automatic = next.every(clip => !clip.continuityMode || clip.continuityMode === "auto");
    if (group && automatic && previousFrameDecision(shot) && duration <= maxSeconds && refs.size <= 9 && prompt.length <= 5000) group.push(shot);
    else groups.push([shot]);
  }
  return { ...plan, clips: groups.map((group, index) => {
    const first = group[0];
    let start = 0;
    const prompt = group.length === 1 ? first.prompt : group.map(shot => { const end = start + shot.duration; const text = `${time(start)}–${time(end)}s: ${shot.prompt}`; start = end; return text; }).join("\n\n");
    const continuation = index > 0 && previousFrameDecision(first);
    return { ...first, title: group.length > 1 ? `${first.title} · ${group.at(-1)!.title}`.slice(0, 150) : first.title, duration: Math.round(group.reduce((sum, shot) => sum + shot.duration, 0) * 100) / 100, prompt, referenceIds: [...new Set(group.flatMap(shot => shot.referenceIds))], continuation, autoContinuation: index > 0 && (first.transition ? first.transition === "continue" : first.autoContinuation ?? first.continuation), continuityMode: first.continuityMode || "auto", ...(index === 0 ? { transition: "first" as const, continuityReason: "The first clip starts a new sequence." } : {}) };
  }) };
}

export function automaticPlan(plan: Plan, preserveOverrides = false, maxSeconds = 10): Plan {
  return compactPlan({ ...plan, clips: plan.clips.map((shot, index) => {
    const automatic = index > 0 && shot.transition === "continue";
    const continuityMode = preserveOverrides ? shot.continuityMode || "auto" : "auto";
    return { ...shot, autoContinuation: automatic, continuityMode, continuation: index > 0 && previousFrameDecision({ ...shot, autoContinuation: automatic, continuityMode }) };
  }) }, maxSeconds);
}
