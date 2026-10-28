import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assetPath } from "./agent-store";
import { plannedDuration, finalPrompt, previousFrameDecision, suppliedImages, suppliedAudios, type AgentProject, type AgentClip } from "./agent-types";

export function promptApprovalKey(project: AgentProject, clip: AgentClip) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ prompt: finalPrompt(project, clip), duration: plannedDuration(clip), settings: project.settings, references: clip.referenceIds, continuity: previousFrameDecision(clip), ...(project.settings.provider !== "apimart" ? { workflow: "h3-motion-context-v1" } : {}) }));
  for (const reference of [...suppliedImages(project, clip), ...suppliedAudios(project, clip)]) {
    hash.update(JSON.stringify(reference)); hash.update(readFileSync(assetPath(project.id, reference.asset.path)));
  }
  if (previousFrameDecision(clip)) {
    const previous = project.clips[project.clips.findIndex(item => item.id === clip.id) - 1];
    if (project.settings.provider === "apimart") {
      const frame = previous?.frame;
      if (frame) { hash.update(JSON.stringify(frame)); hash.update(readFileSync(assetPath(project.id, frame.path))); }
    } else if (project.settings.provider === "comfy-cloud") {
      hash.update(JSON.stringify({ workflow: "h3-cloud-files-v1", previousJobId: previous?.jobId, latent: previous?.latent }));
      if (previous?.latent) hash.update(readFileSync(assetPath(project.id, previous.latent.path)));
    } else hash.update(JSON.stringify({ workflow: "h3-motion-context-v1", previousLatentId: previous?.latentId, previousJobId: previous?.jobId }));
  }
  return hash.digest("hex");
}
