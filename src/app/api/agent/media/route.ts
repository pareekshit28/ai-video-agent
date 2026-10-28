import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { assetPath, getProject } from "@/lib/agent-store";
import { RequestError } from "@/lib/request-error";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    assertLocalRequest(request); const params = new URL(request.url).searchParams;
    const project = await getProject(params.get("projectId") || ""); const id = params.get("id"); const kind = params.get("kind");
    const version = params.get("version");
    if (version !== null && !/^\d{1,4}$/.test(version)) throw new RequestError("Invalid saved version.", "invalid_media_version");
    const current = project.clips.find(clip => clip.id === id);
    const clip = version !== null ? current?.versions?.[Number(version)]?.clip : current;
    const reference = project.references.find(slot => slot.id === id);
    const asset = kind === "audio" ? reference?.audios?.[Number(params.get("index") || 0)] : kind === "referenceImage" ? reference?.images?.[Number(params.get("index") || 0)] : kind === "reference" ? project.references.find(slot => slot.id === id)?.asset : kind === "video" ? clip?.video : kind === "frame" ? clip?.frame : kind === "latent" ? clip?.latent : undefined;
    if (!asset) throw new RequestError("Local media not found.", "media_not_found");
    const path = assetPath(project.id, asset.path); const size = (await stat(path)).size; let start = 0; let end = size - 1; let status = 200;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${size}` } });
      if (!match[1]) start = Math.max(0, size - Number(match[2])); else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= size) return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${size}` } });
      status = 206;
    }
    const headers: Record<string, string> = { ...privateHeaders, "Content-Type": asset.mime, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${params.get("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(asset.name)}` };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(stream, { status, headers });
  } catch (error) { return apiError(error); }
}
