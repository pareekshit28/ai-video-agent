import { z } from "zod";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { referenceSchema } from "@/lib/h3";
import { entityIdSchema } from "@/lib/agent-types";
import { updateProject, writeAsset } from "@/lib/agent-store";
import { assertEditable, publicProject } from "@/lib/agent-runner";
import { RequestError } from "@/lib/request-error";
import { readFile } from "node:fs/promises";
import { characterPath, getCharacter } from "@/lib/characters";
import { saveReference } from "@/lib/reference-media";
import { projectFolder } from "@/lib/agent-store";
import { join } from "node:path";
import { publicReferenceUrlSchema } from "@/lib/public-reference-url";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = z.object({ projectId: z.uuid(), slotId: entityIdSchema.optional(), action: z.literal("clearLibraryAsset").optional(), characterId: z.uuid().optional(), kind: z.enum(["image", "audio"]).default("image"), file: referenceSchema.optional(), audioIndex: z.number().int().min(0).max(4).optional(), publicUrl: publicReferenceUrlSchema.or(z.literal("")).optional() }).safeParse(await readJson(request, 6_000_000));
    if (!parsed.success) throw new RequestError("Choose an image, audio sample or saved library reference. Each file must be nonempty and under 4 MiB.", "invalid_reference");
    const data = parsed.data; assertEditable(data.projectId);
    if (data.action === "clearLibraryAsset") {
      if (!data.slotId) throw new RequestError("Choose a scene reference whose library selection should be cleared.", "invalid_reference");
      const project = await updateProject(data.projectId, current => {
        assertEditable(data.projectId);
        const slot = current.references.find(slot => slot.id === data.slotId);
        if (!slot) throw new RequestError("Reference slot not found.", "invalid_reference");
        if (!slot.characterId) throw new RequestError("This reference has no selected library asset.", "invalid_reference");
        slot.characterId = undefined; slot.asset = undefined; slot.images = undefined; slot.audios = [];
        for (const clip of current.clips) {
          if (!clip.referenceIds.includes(data.slotId!)) continue;
          if ((!clip.jobId && !clip.requestId) || clip.status === "complete") { clip.compiledPrompt = undefined; clip.revision = undefined; clip.promptContextKey = undefined; }
        }
        current.status = current.clips.every(clip => clip.status === "complete") ? "complete" : current.clips.some(clip => clip.requestId || clip.jobId) ? "paused" : "ready";
        current.error = undefined;
        return current;
      });
      return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
    }
    if (!data.slotId && !data.characterId) throw new RequestError("Choose a reference slot or library item.", "invalid_reference");
    const character = data.characterId ? await getCharacter(data.characterId) : undefined;
    const project = await updateProject(data.projectId, async current => {
      assertEditable(data.projectId); let slot = current.references.find(slot => slot.id === data.slotId);
      if (character && character.collectionId !== current.collectionId) throw new RequestError("Choose a library reference from this scene's project.", "invalid_library_project");
      if (!slot && character && !data.slotId) {
        if (current.references.length >= 40) throw new RequestError("A scene can have at most 40 reference slots.", "invalid_reference");
        slot = { id: `${character.kind || "character"}_${crypto.randomUUID().replaceAll("-", "")}`, name: character.name, kind: character.kind || "character", description: character.description || character.name }; current.references.push(slot);
        for (const clip of current.clips) if (!clip.requestId && !clip.jobId && clip.status !== "complete" && clip.referenceIds.length < 9) clip.referenceIds.push(slot.id);
      }
      if (!slot) throw new RequestError("Reference slot not found.", "invalid_reference");
      if (data.publicUrl !== undefined) {
        const audio = slot.audios?.[data.audioIndex ?? 0];
        if (!audio) throw new RequestError("Choose an existing voice sample to link.", "invalid_reference");
        audio.publicUrl = data.publicUrl || undefined;
      } else if (character) {
        if (slot.kind !== (character.kind || "character")) throw new RequestError(`Choose a saved ${slot.kind} for this reference slot.`, "invalid_reference_kind");
        const copy = async (asset: import("@/lib/agent-types").Asset) => ({ ...await writeAsset(data.projectId, `references/${crypto.randomUUID()}.${asset.path.split(".").pop()}`, await readFile(characterPath(character.id, asset.path)), asset.mime, asset.name), ...(asset.publicUrl ? { publicUrl: asset.publicUrl } : {}) });
        slot.images = await Promise.all(character.images.map(copy)); slot.asset = slot.images[0];
        slot.audios = await Promise.all(character.voices.map(copy)); slot.characterId = character.id;
        slot.name = character.name; slot.kind = character.kind || "character"; slot.description = character.description || character.name;
      } else if (data.kind === "audio") {
        if (data.file) { const asset = await saveReference(join(projectFolder(data.projectId), "references"), data.file, "audio"); slot.audios = [{ ...asset, path: `references/${asset.path}` }]; }
        else slot.audios = [];
      } else if (data.file) {
        const bytes = Buffer.from(data.file.base64, "base64");
        if (bytes.length !== data.file.bytes) throw new RequestError("Reference size does not match its data.", "invalid_reference");
        const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? { extension: "png", mime: "image/png" } : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? { extension: "jpg", mime: "image/jpeg" } : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? { extension: "webp", mime: "image/webp" } : null;
        if (!type) throw new RequestError("This file is not a PNG, JPEG or WebP image.", "invalid_reference");
        slot.asset = await writeAsset(data.projectId, `references/${slot.id}-${crypto.randomUUID()}.${type.extension}`, bytes, type.mime, data.file.name);
        slot.images = undefined;
      } else { slot.asset = undefined; slot.images = undefined; }
      for (const clip of current.clips) if (clip.status !== "complete" && !clip.requestId && !clip.jobId) { clip.compiledPrompt = undefined; clip.promptContextKey = undefined; }
      current.status = "ready"; current.error = undefined; return current;
    });
    return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
