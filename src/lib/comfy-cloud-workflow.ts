import template from "./comfy-cloud-workflow.json";
import { buildPayload, type H3Settings, type ReferenceFile, type Workflow } from "./h3";
import { RequestError } from "./request-error";

export type CloudAssetReference = { __type: "core/ASSET"; info: { id: string; hash?: string; file_path?: string } };
export function buildComfyCloudWorkflow(settings: H3Settings, images: ReferenceFile[], audios: ReferenceFile[], context: { clipId: string; previousClipId?: string }, uploads: Map<string, CloudAssetReference>, previousLatent?: CloudAssetReference): Workflow {
  if (Boolean(context.previousClipId) !== Boolean(previousLatent)) throw new RequestError("Upload the preceding clip's saved latent before continuing on Comfy Cloud.", "continuity_latent_missing");
  const { input } = buildPayload(settings, images, audios, context, template);
  const workflow = input.workflow;
  for (const node of Object.values(workflow)) {
    if (!["LoadImage", "LoadAudio"].includes(node.class_type)) continue;
    const field = node.class_type === "LoadImage" ? "image" : "audio";
    const name = node.inputs[field] as string;
    const asset = uploads.get(name);
    if (!asset) throw new RequestError("A Comfy Cloud reference upload is missing. No job was submitted.", "comfy_cloud_upload_missing");
    node.inputs[field] = asset;
  }
  Object.assign(workflow["158"].inputs, { latent_path: previousLatent || "", folder: "input", storage_root: "", clip_id: "", clip_index: previousLatent ? 1 : 0 });
  Object.assign(workflow["159"].inputs, { storage_root: "", clip_id: context.clipId });
  return workflow;
}
