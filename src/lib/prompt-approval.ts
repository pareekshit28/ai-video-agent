import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assetPath } from "./agent-store";
import { finalPrompt, previousFrameDecision, suppliedImages, suppliedAudios, type AgentProject, type AgentClip } from "./agent-types";

export function promptApprovalKey(project: AgentProject, clip: AgentClip) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ prompt: finalPrompt(project, clip), duration: clip.duration, settings: project.settings, references: clip.referenceIds, continuity: previousFrameDecision(clip) }));
  for (const reference of [...suppliedImages(project, clip), ...suppliedAudios(project, clip)]) {
    hash.update(JSON.stringify(reference)); hash.update(readFileSync(assetPath(project.id, reference.asset.path)));
  }
  if (previousFrameDecision(clip)) {
    const frame = project.clips[project.clips.findIndex(item => item.id === clip.id) - 1]?.frame;
    if (frame) { hash.update(JSON.stringify(frame)); hash.update(readFileSync(assetPath(project.id, frame.path))); }
  }
  return hash.digest("hex");
}
