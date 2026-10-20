import { z } from "zod";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { referenceSchema } from "@/lib/h3";
import { entityIdSchema, markFollowingContinuityOutdated } from "@/lib/agent-types";
import { updateProject, writeAsset } from "@/lib/agent-store";
import { assertEditable, publicProject } from "@/lib/agent-runner";
import { RequestError } from "@/lib/request-error";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = z.object({ projectId: z.uuid(), clipId: entityIdSchema, file: referenceSchema.optional(), restore: z.boolean().optional() }).safeParse(await readJson(request, 6_000_000));
    if (!parsed.success || Boolean(parsed.data.file) === Boolean(parsed.data.restore)) throw new RequestError("Choose a PNG, JPEG or WebP under 4 MiB, or restore the extracted frame.", "invalid_frame");
    const data = parsed.data;
    assertEditable(data.projectId);
    const project = await updateProject(data.projectId, async current => {
      assertEditable(data.projectId);
      const clip = current.clips.find(clip => clip.id === data.clipId);
      if (clip?.status !== "complete" || !clip.frame) throw new RequestError("Generate and save this clip before replacing its last frame.", "invalid_clip_state");
      if (data.file) {
        const bytes = Buffer.from(data.file.base64, "base64");
        if (bytes.length !== data.file.bytes) throw new RequestError("Frame size does not match its content.", "invalid_frame");
        const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? { extension: "png", mime: "image/png" } : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? { extension: "jpg", mime: "image/jpeg" } : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? { extension: "webp", mime: "image/webp" } : null;
        if (!type) throw new RequestError("This file is not a PNG, JPEG or WebP image.", "invalid_frame");
        const frame = await writeAsset(data.projectId, `frames/${clip.id}-replacement-${crypto.randomUUID()}.${type.extension}`, bytes, type.mime, data.file.name);
        clip.extractedFrame ||= clip.frame;
        clip.frame = frame; clip.frameReplaced = true;
      } else {
        if (!clip.extractedFrame) throw new RequestError("The original extracted frame is not available.", "original_frame_missing");
        clip.frame = clip.extractedFrame; clip.frameReplaced = false;
      }
      markFollowingContinuityOutdated(current, clip.id);
      for (const shot of current.clips) if (!shot.jobId && !shot.requestId) shot.approvedPromptKey = undefined;
      return current;
    });
    return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
