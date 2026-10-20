import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { referenceSchema, type ReferenceFile } from "./h3";
import { RequestError } from "./request-error";
import type { Asset } from "./agent-types";
import { publicReferenceUrlSchema } from "./public-reference-url";

const runFile = promisify(execFile);
const audioTypes: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg" };
export async function saveReference(directory: string, value: ReferenceFile, kind: "image" | "audio"): Promise<Asset> {
  const file = referenceSchema.parse(value), bytes = Buffer.from(file.base64, "base64");
  if (bytes.length !== file.bytes) throw new RequestError("Reference size does not match its content.", "invalid_reference");
  let extension = file.name.split(".").pop()!.toLowerCase(), mime = audioTypes[extension];
  if (kind === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { extension = "png"; mime = "image/png"; }
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { extension = "jpg"; mime = "image/jpeg"; }
    else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") { extension = "webp"; mime = "image/webp"; }
    else throw new RequestError("Use a PNG, JPEG or WebP image under 4 MiB.", "invalid_reference");
  } else if (!mime) throw new RequestError("Use WAV, MP3, M4A, FLAC or OGG audio under 4 MiB.", "invalid_audio_reference");
  await mkdir(directory, { recursive: true });
  const filename = `${kind}-${crypto.randomUUID()}.${extension}`, path = join(directory, filename);
  await writeFile(path, bytes, { mode: 0o600 });
  if (kind === "audio") {
    try {
      const result = await runFile(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path], { windowsHide: true, timeout: 15000, maxBuffer: 100000 });
      const data = JSON.parse(result.stdout), duration = Number(data.format?.duration);
      if (!data.streams?.some((stream: { codec_type: string }) => stream.codec_type === "audio") || !Number.isFinite(duration) || duration < .25 || duration > 15) throw new Error("Invalid audio duration");
    } catch { await unlink(path); throw new RequestError("Audio must be a playable 0.25–15 second sample. FFprobe must be available to validate it.", "invalid_audio_reference"); }
  }
  return { path: filename, bytes: bytes.length, mime, name: file.name };
}
export const characterInputSchema = z.object({ id: z.uuid().optional(), collectionId: z.uuid().optional(), kind: z.enum(["character", "location", "prop"]).optional(), name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).default(""), images: z.array(referenceSchema).max(9).optional(), voices: z.array(referenceSchema).max(3).optional(), voiceUrls: z.array(publicReferenceUrlSchema.or(z.literal(""))).max(3).optional() }).superRefine((data, ctx) => {
  if ([...(data.images || []), ...(data.voices || [])].reduce((sum, file) => sum + file.bytes, 0) > 6_000_000) ctx.addIssue({ code: "custom", message: "Reference uploads must be at most 6 MB combined." });
});
