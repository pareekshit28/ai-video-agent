import sourceWorkflow from "./h3-workflow.json";
import { z } from "zod";
import { MAX_IMAGE_REFERENCES, MAX_INLINE_REFERENCE_BYTES, MAX_REFERENCE_FILE_BYTES } from "./reference-limits";

export const DEFAULT_ENDPOINT = "6b68a4fh76ub8s";
export const ratios = ["16:9 (Widescreen)", "9:16 (Portrait)", "1:1 (Square)"] as const;
export const settingsSchema = z.object({
  prompt: z.string().trim().min(1, "Enter a video prompt.").max(32000),
  duration: z.number().min(2).max(10), aspectRatio: z.enum(ratios),
  megapixels: z.number().min(0.25).max(4), steps: z.number().int().min(1).max(100),
  seed: z.string().refine(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= -1, "Use -1 or a nonnegative safe integer for the seed."),
  refImageSize: z.enum(["max", "match"]),
});
export type H3Settings = z.infer<typeof settingsSchema>;
export type ReferenceFile = { name: string; base64: string; bytes: number; preview?: string };
export const initialSettings: H3Settings = {
  prompt: "",
  duration: sourceWorkflow["132"].inputs.value,
  aspectRatio: sourceWorkflow["115"].inputs.aspect_ratio as H3Settings["aspectRatio"],
  megapixels: sourceWorkflow["115"].inputs.megapixels,
  steps: sourceWorkflow["124"].inputs.steps,
  seed: String(sourceWorkflow["129"].inputs.noise_seed),
  refImageSize: sourceWorkflow["136"].inputs.ref_image_size as H3Settings["refImageSize"],
};
export const referenceSchema = z.object({ name: z.string().min(1).max(255), base64: z.string().min(4).max(5_592_408).regex(/^[A-Za-z0-9+/]+={0,2}$/), bytes: z.number().int().positive().max(MAX_REFERENCE_FILE_BYTES) });
const baseSubmissionSchema = z.object({ requestId: z.uuid(), collectionId: z.uuid().optional(), clipId: z.uuid().optional(), previousClipId: z.uuid().optional(), settings: settingsSchema, images: z.array(referenceSchema).max(MAX_IMAGE_REFERENCES), audios: z.array(referenceSchema).max(3) }).superRefine((data, ctx) => {
  if ([...data.images, ...data.audios].reduce((sum, file) => sum + file.bytes, 0) > MAX_INLINE_REFERENCE_BYTES) ctx.addIssue({ code: "custom", message: "References must be at most 6 MB combined.", path: ["images"] });
  for (const [kind, files] of [["images", data.images], ["audios", data.audios]] as const) {
    files.forEach((file, index) => {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!(kind === "images" ? ["png", "jpg", "jpeg", "webp"] : ["wav", "mp3", "m4a", "flac", "ogg"]).includes(extension || "")) ctx.addIssue({ code: "custom", message: "Unsupported reference format.", path: [kind, index] });
      // Calculate decoded length without copying large media into another buffer.
      const length = file.base64.length * 3 / 4 - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0);
      if (file.base64.length % 4 !== 0 || length !== file.bytes) ctx.addIssue({ code: "custom", message: "Reference size does not match its content.", path: [kind, index] });
    });
  }
});
export const agentSubmissionSchema = baseSubmissionSchema;
export const submissionSchema = baseSubmissionSchema.superRefine((data, ctx) => { if (!data.images.length && !data.audios.length) ctx.addIssue({ code: "custom", message: "Add at least one image or audio reference.", path: ["images"] }); });

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string; aux_id?: string; ver?: string } }>;
export function dimensions(aspectRatio: H3Settings["aspectRatio"], megapixels: number) {
  const ratio = aspectRatio.startsWith("9:16") ? 9 / 16 : aspectRatio.startsWith("1:1") ? 1 : 16 / 9;
  const height = Math.round(Math.sqrt(megapixels * 1_000_000 / ratio) / 32) * 32;
  return { width: Math.round(height * ratio / 32) * 32, height };
}
// API graph converted from workflows/minimax_h3_motion_context.json.
// Fork provenance stays in _meta; the worker image supplies the node implementation.
export function buildPayload(settings: H3Settings, images: ReferenceFile[], audios: ReferenceFile[], context: { clipId: string; previousClipId?: string }) {
  z.object({ clipId: z.uuid(), previousClipId: z.uuid().optional() }).parse(context);
  const workflow = structuredClone(sourceWorkflow) as Workflow;
  workflow["138"].inputs.value = settings.prompt.trim();
  workflow["132"].inputs.value = settings.duration;
  workflow["115"].inputs.aspect_ratio = settings.aspectRatio;
  workflow["115"].inputs.megapixels = settings.megapixels;
  workflow["124"].inputs.steps = settings.steps;
  workflow["129"].inputs.noise_seed = settings.seed === "-1" ? crypto.getRandomValues(new Uint32Array(1))[0] : Number(settings.seed);
  workflow["136"].inputs.ref_image_size = settings.refImageSize;
  workflow["159"].inputs.clip_id = context.clipId;
  workflow["158"].inputs.clip_id = context.previousClipId || "";
  workflow["158"].inputs.clip_index = 0;
  if (context.previousClipId) {
    // MotionContextTrim removes this pinned head from both decoded streams.
    // Reserve it before H3's frame snapping so the requested action still fits.
    const contextFrames = Number(workflow["160"].inputs.context_length);
    workflow["131"].inputs.expression = sourceWorkflow["131"].inputs.expression.replaceAll("a * 24", `(a * 24 + ${contextFrames})`);
  }
  let nextId = 162;
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
