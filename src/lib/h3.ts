import sourceWorkflow from "./h3-workflow.json";
import { z } from "zod";
import { MAX_IMAGE_REFERENCES, MAX_INLINE_REFERENCE_BYTES, MAX_REFERENCE_FILE_BYTES } from "./reference-limits";

export const DEFAULT_ENDPOINT = "6b68a4fh76ub8s";
export const ratios = ["16:9 (Widescreen)", "9:16 (Portrait)", "1:1 (Square)"] as const;
export const settingsSchema = z.object({
  prompt: z.string().trim().min(1, "Enter a video prompt.").max(32000),
  duration: z.number().min(2).max(15), aspectRatio: z.enum(ratios),
  megapixels: z.number().min(0.25).max(4), steps: z.number().int().min(1).max(100),
  seed: z.string().refine(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= -1, "Use -1 or a nonnegative safe integer for the seed."),
  refImageSize: z.enum(["max", "match"]),
});
export type H3Settings = z.infer<typeof settingsSchema>;
export type ReferenceFile = { name: string; base64: string; bytes: number; preview?: string };
export const initialSettings: H3Settings = { prompt: "", duration: 5, aspectRatio: ratios[0], megapixels: 1, steps: 6, seed: "-1", refImageSize: "max" };
export const referenceSchema = z.object({ name: z.string().min(1).max(255), base64: z.string().min(4).max(5_592_408).regex(/^[A-Za-z0-9+/]+={0,2}$/), bytes: z.number().int().positive().max(MAX_REFERENCE_FILE_BYTES) });
const baseSubmissionSchema = z.object({ requestId: z.uuid(), collectionId: z.uuid().optional(), settings: settingsSchema, images: z.array(referenceSchema).max(MAX_IMAGE_REFERENCES), audios: z.array(referenceSchema).max(3), firstFrame: referenceSchema.optional() }).superRefine((data, ctx) => {
  if ([...data.images, ...data.audios, ...(data.firstFrame ? [data.firstFrame] : [])].reduce((sum, file) => sum + file.bytes, 0) > MAX_INLINE_REFERENCE_BYTES) ctx.addIssue({ code: "custom", message: "References and continuity frame must be at most 6 MB combined.", path: ["images"] });
  for (const [kind, files] of [["images", [...data.images, ...(data.firstFrame ? [data.firstFrame] : [])]], ["audios", data.audios]] as const) {
    files.forEach((file, index) => {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!(kind === "images" ? ["png", "jpg", "jpeg", "webp"] : ["wav", "mp3", "m4a", "flac", "ogg"]).includes(extension || "")) ctx.addIssue({ code: "custom", message: "Unsupported reference format.", path: [kind, index] });
      // Calculate decoded length without copying large media into another buffer.
      const length = file.base64.length * 3 / 4 - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0);
      if (file.base64.length % 4 !== 0 || length !== file.bytes) ctx.addIssue({ code: "custom", message: "Reference size does not match its content.", path: [kind, index] });
    });
  }
});
export const agentSubmissionSchema = baseSubmissionSchema.superRefine((data, ctx) => { if (data.settings.duration > 10) ctx.addIssue({ code: "custom", message: "Agent clips must be at most 10 seconds.", path: ["settings", "duration"] }); });
export const submissionSchema = baseSubmissionSchema.superRefine((data, ctx) => { if (!data.images.length && !data.audios.length) ctx.addIssue({ code: "custom", message: "Add at least one image or audio reference.", path: ["images"] }); });

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>;
export function dimensions(aspectRatio: H3Settings["aspectRatio"], megapixels: number) {
  const ratio = aspectRatio.startsWith("9:16") ? 9 / 16 : aspectRatio.startsWith("1:1") ? 1 : 16 / 9;
  const height = Math.round(Math.sqrt(megapixels * 1_000_000 / ratio) / 32) * 32;
  return { width: Math.round(height * ratio / 32) * 32, height };
}
// Ported from the linked H3 Studio source. Keep its worker contract and model graph.
export function buildPayload(settings: H3Settings, images: ReferenceFile[], audios: ReferenceFile[], firstFrame?: ReferenceFile) {
  const workflow = structuredClone(sourceWorkflow) as Workflow;
  workflow["138"].inputs.value = settings.prompt.trim();
  workflow["132"].inputs.value = settings.duration;
  workflow["115"].inputs.aspect_ratio = settings.aspectRatio;
  workflow["115"].inputs.megapixels = settings.megapixels;
  workflow["124"].inputs.steps = settings.steps;
  workflow["129"].inputs.noise_seed = settings.seed === "-1" ? crypto.getRandomValues(new Uint32Array(1))[0] : Number(settings.seed);
  workflow["136"].inputs.ref_image_size = settings.refImageSize;
  let nextId = 150;
  const uploads: { name: string; image: string }[] = [];
  for (const [kind, files] of [["image", images], ["audio", audios]] as const) files.forEach((file, index) => {
    while (workflow[String(nextId)]) nextId++;
    const id = String(nextId++);
    const name = `reference-${kind}-${index + 1}.${file.name.split(".").pop()!.toLowerCase()}`;
    workflow[id] = { class_type: kind === "image" ? "LoadImage" : "LoadAudio", inputs: { [kind]: name } };
    workflow["136"].inputs[`ref_${kind}s.ref_${kind}_${index}`] = [id, 0];
    // The worker accepts audio bytes in the same 'images' transport array.
    uploads.push({ name, image: file.base64 });
  });
  if (firstFrame) {
    workflow.agent_first_frame = { class_type: "LoadImage", inputs: { image: firstFrame.name } };
    workflow.agent_frame_guide = { class_type: "MiniMaxH3AddGuide", inputs: { positive: ["136", 0], latent: ["136", 1], vae: ["119", 0], image: ["agent_first_frame", 0], frame_idx: 0 } };
    workflow["126"].inputs.conditioning = ["agent_frame_guide", 0];
    uploads.push({ name: firstFrame.name, image: firstFrame.base64 });
  }
  return { input: { workflow, images: uploads } };
}

export type H3Job = { collectionId?: string; localId: string; id?: string; endpoint: string; prompt: string; createdAt: number; status: string; agent?: boolean; output?: unknown; error?: string; delayTime?: number; executionTime?: number };
export const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "REJECTED", "SUBMISSION_UNKNOWN", "SUBMITTING"]);
export function mediaFrom(output: unknown): string[] {
  const results: string[] = [];
  function visit(value: unknown, key = "output", depth = 0) {
    if (depth > 7 || value == null) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && (/video|url|file|download|output/i.test(key) || /\.(mp4|webm|mov)(\?|$)/i.test(value))) {
        try { const url = new URL(value); if (!url.username && !url.password) results.push(url.href); } catch { /* Ignore malformed output URLs. */ }
      } else if (/^data:video\/(mp4|webm|quicktime);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value)) results.push(value);
      else if (/base64|video|data|output/i.test(key) && value.length > 1000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) results.push(`data:video/mp4;base64,${value}`);
    } else if (Array.isArray(value)) value.forEach(item => visit(item, "video", depth + 1));
    else if (typeof value === "object") Object.entries(value).forEach(([name, item]) => visit(item, name, depth + 1));
  }
  visit(output);
  return [...new Set(results)];
}
export function readableOutput(output: unknown) {
  return JSON.stringify(output, (_key, value) => typeof value === "string" && value.length > 500 ? `[${value.length.toLocaleString()} characters]` : value, 2);
}
