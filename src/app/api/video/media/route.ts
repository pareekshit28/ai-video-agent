import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { getCollection } from "@/lib/project-collections";
import { studioFolder } from "@/lib/studio-assets";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const params = new URL(request.url).searchParams, projectId = params.get("projectId") || "", localId = params.get("localId") || "";
    await getCollection(projectId);
    const path = join(studioFolder(projectId, localId), "output.mp4"), size = (await stat(path)).size;
    let start = 0, end = size - 1, status = 200;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${size}` } });
      if (!match[1]) start = Math.max(0, size - Number(match[2])); else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= size) return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${size}` } }); status = 206;
    }
    const headers: Record<string, string> = { ...privateHeaders, "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Content-Disposition": `inline; filename="${localId}.mp4"` };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>, { status, headers });
  } catch (error) { return apiError(error); }
}
