import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { RequestError } from "./request-error";
import { assetPath } from "./agent-store";
import { mediaFrom } from "./h3";
import type { Asset } from "./agent-types";

const runFile = promisify(execFile);
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const tools = () => ({ ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" });
export async function verifyMediaTools() {
  try { await Promise.all([runFile(tools().ffmpeg, ["-version"], { windowsHide: true, timeout: 15000 }), runFile(tools().ffprobe, ["-version"], { windowsHide: true, timeout: 15000 })]); }
  catch { throw new RequestError("FFmpeg and FFprobe are required to save clips and extract frames. Add them to PATH or set FFMPEG_PATH and FFPROBE_PATH.", "media_tools_missing"); }
}
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const ip = address.toLowerCase();
    // Only global unicast IPv6; reject local, mapped/compatible IPv4 and multicast.
    return /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith("2001:db8:");
  }
  return false;
}
async function downloadHttps(urlValue: string, target: string, signal: AbortSignal, redirects = 0): Promise<void> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || redirects > 5) throw new RequestError("The worker returned an unsupported video URL. Use a public HTTPS video output.", "invalid_video_url");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length || addresses.some(result => !publicAddress(result.address))) throw new RequestError("The video download URL points to a private or reserved address.", "invalid_video_url");
  // Pin the validated DNS result to the actual socket, including every redirect.
  const address = addresses[0];
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(url, { signal, family: address.family, lookup: (_hostname, _options, callback) => callback(null, address.address, address.family), headers: { "Accept-Encoding": "identity" }, timeout: 120000 }, resolve);
    request.on("timeout", () => request.destroy(new Error("Download timed out"))); request.on("error", reject); request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) { response.resume(); return downloadHttps(new URL(response.headers.location, url).href, target, signal, redirects + 1); }
  if (response.statusCode !== 200 || Number(response.headers["content-length"]) > MAX_VIDEO_BYTES) { response.destroy(); throw new RequestError("The video download failed or exceeded 512 MiB. Check the worker output and resume saving.", "video_download_failed"); }
  let total = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { total += chunk.length; callback(total > MAX_VIDEO_BYTES ? new Error("Video is too large") : null, chunk); } });
  await pipeline(response, limit, createWriteStream(target, { mode: 0o600, flags: "wx" }), { signal });
}
export async function downloadOutput(projectId: string, clipId: string, output: unknown, signal: AbortSignal): Promise<Asset> {
  const path = `clips/${clipId}.source.mp4`; const target = assetPath(projectId, path);
  const bytes = await downloadVideoFile(output, target, signal);
  return { path, name: `${clipId}.source.mp4`, mime: "video/mp4", bytes };
}
export async function downloadVideoFile(output: unknown, target: string, signal: AbortSignal): Promise<number> {
  const source = mediaFrom(output)[0];
  if (!source) throw new RequestError("RunPod completed without a downloadable video. Inspect the worker output; no new job will be submitted.", "video_output_missing");
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    if (source.startsWith("data:video/")) {
      const encoded = source.slice(source.indexOf(",") + 1).replace(/[\r\n]/g, "");
      if (encoded.length > Math.ceil(MAX_VIDEO_BYTES * 4 / 3)) throw new RequestError("Inline video exceeds 512 MiB.", "video_too_large");
      await writeFile(temporary, Buffer.from(encoded, "base64"), { mode: 0o600, flag: "wx" });
    } else await downloadHttps(source, temporary, signal);
    signal.throwIfAborted(); await rename(temporary, target);
    const info = await stat(target); return info.size;
  } catch (error) { if (error instanceof RequestError || signal.aborted) throw error; throw new RequestError("Could not download the completed video. Resume to retry saving without submitting another GPU job.", "video_download_failed"); }
}
export async function probeMedia(file: string, signal?: AbortSignal) {
  try {
    const { stdout } = await runFile(tools().ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-show_streams", "-show_format", "-of", "json", file], { windowsHide: true, timeout: 30000, signal, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout); const video = info.streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    const duration = Number(video?.duration || info.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error("Invalid video");
    return { width: Number(video.width), height: Number(video.height), duration, fps: Number(video.avg_frame_rate?.split("/")[0]) / Number(video.avg_frame_rate?.split("/")[1]), hasAudio: info.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio") };
  } catch (error) { if (signal?.aborted) throw error; throw new RequestError("The downloaded output is not a valid playable video. The source file was kept for inspection.", "invalid_video_output"); }
}
export async function finalizeClip(projectId: string, clipId: string, source: Asset, seconds: number, signal: AbortSignal, options: { maxSeconds: number; automatic?: boolean } = { maxSeconds: 10 }) {
  const maximum = options.maxSeconds;
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > maximum) throw new RequestError(`Clip duration must be 2–${maximum} seconds.`, "invalid_duration");
  const original = await probeMedia(assetPath(projectId, source.path), signal);
  if (options.automatic) {
    if (original.duration < 2 || original.duration > maximum + 0.06) throw new RequestError(`Automatic video duration must be 2–${maximum} seconds. The source was retained.`, "invalid_duration");
    seconds = Math.min(original.duration, maximum);
  }
  if (original.duration < seconds - 1 / 24 - 0.02) throw new RequestError(`The worker returned ${original.duration.toFixed(2)} seconds for a ${seconds}-second shot. The source was retained; the shot is incomplete.`, "short_video_output");
  const path = `clips/${clipId}.mp4`; const framePath = `frames/${clipId}.jpg`; const videoTemp = assetPath(projectId, `clips/${clipId}.${randomUUID()}.mp4`); const frameTemp = assetPath(projectId, `frames/${clipId}.${randomUUID()}.jpg`);
  try {
    await runFile(tools().ffmpeg, ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", assetPath(projectId, source.path), "-map", "0:v:0", "-map", "0:a?", "-t", String(seconds), "-vf", "fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", videoTemp], { windowsHide: true, timeout: 600000, signal, maxBuffer: 1024 * 1024 });
    const media = await probeMedia(videoTemp, signal);
    if (media.duration > maximum + 0.001 || media.duration < seconds - 0.06 || Math.abs(media.fps - 24) > 0.01) throw new RequestError("The saved clip failed duration/frame-rate verification.", "media_verification_failed");
    await rename(videoTemp, assetPath(projectId, path));
    // Decode and reverse the final two seconds: take the actual last decoded frame.
    await runFile(tools().ffmpeg, ["-hide_banner", "-loglevel", "error", "-sseof", "-2", "-i", assetPath(projectId, path), "-an", "-vf", "reverse", "-frames:v", "1", "-q:v", "2", "-update", "1", frameTemp], { windowsHide: true, timeout: 60000, signal, maxBuffer: 1024 * 1024 });
    await rename(frameTemp, assetPath(projectId, framePath));
    const [videoStat, frameStat] = await Promise.all([stat(assetPath(projectId, path)), stat(assetPath(projectId, framePath))]);
    const frameBytes = await readFile(assetPath(projectId, framePath));
    if (!frameBytes.length || frameBytes[0] !== 0xff || frameBytes[1] !== 0xd8) throw new RequestError("Could not extract the final frame.", "frame_extraction_failed");
    return { video: { path, name: `${clipId}.mp4`, bytes: videoStat.size, mime: "video/mp4" }, frame: { path: framePath, name: `${clipId}-last-frame.jpg`, bytes: frameStat.size, mime: "image/jpeg" }, media: { width: media.width, height: media.height, duration: media.duration, fps: 24 } };
  } catch (error) { if (error instanceof RequestError || signal.aborted) throw error; throw new RequestError("Could not finalize the saved video or extract its last frame. Resume to retry processing the retained source.", "media_processing_failed"); }
}

export async function discardProcessedSource(projectId: string, source: Asset, video: Asset) {
  // Only remove our generated intermediate after the verified final file is retained.
  if (source.path === video.path || !/^clips\/[a-z0-9_-]+\.source\.mp4$/.test(source.path)) return;
  const final = await stat(assetPath(projectId, video.path));
  if (final.size !== video.bytes || final.size === 0) throw new RequestError("The saved video could not be verified. The source was kept.", "media_verification_failed");
  try { await unlink(assetPath(projectId, source.path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
