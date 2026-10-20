import { readFile } from "node:fs/promises";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { characterPath, getCharacter, listCharacters, saveCharacter, deleteCharacter, cloneCharacter } from "@/lib/characters";
import { z } from "zod";
import { readJson } from "@/lib/runpod";
import { RequestError } from "@/lib/request-error";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    assertLocalRequest(request); const params = new URL(request.url).searchParams;
    if (!params.has("id")) return Response.json({ characters: await listCharacters(params.has("collectionId") ? params.get("collectionId")! : undefined) }, { headers: privateHeaders });
    const character = await getCharacter(params.get("id")!), kind = params.get("kind"), index = Number(params.get("index"));
    const asset = Number.isInteger(index) && index >= 0 ? (kind === "image" ? character.images : kind === "voice" ? character.voices : [])[index] : undefined;
    if (!asset) throw new RequestError("Character media not found.", "media_not_found");
    const bytes = await readFile(characterPath(character.id, asset.path));
    return new Response(bytes, { headers: { ...privateHeaders, "Content-Type": asset.mime, "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const body = await readJson(request, 8_500_000);
    if (body && typeof body === "object" && "action" in body) {
      const parsed = z.object({ action: z.literal("clone"), id: z.uuid(), collectionId: z.uuid() }).safeParse(body);
      if (!parsed.success) throw new RequestError("Choose a saved asset to clone in the selected project.", "invalid_character");
      return Response.json({ character: await cloneCharacter(parsed.data.id, parsed.data.collectionId) }, { headers: privateHeaders });
    }
    return Response.json({ character: await saveCharacter(body) }, { headers: privateHeaders });
  }
  catch (error) { return apiError(error); }
}
export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = z.object({ id: z.uuid(), collectionId: z.uuid() }).safeParse(await readJson(request, 1024));
    if (!parsed.success) throw new RequestError("Choose a saved reference and its project.", "invalid_character");
    return Response.json(await deleteCharacter(parsed.data.id, parsed.data.collectionId), { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
