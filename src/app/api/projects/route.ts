import { z } from "zod";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { createCollection, getCollection, listCollections, renameCollection, organizeCollection, deleteCollection } from "@/lib/project-collections";
import { listProjects, assignScene } from "@/lib/agent-store";
import { assignCharacter, listCharacters } from "@/lib/characters";
import { assertEditable, isProjectActive } from "@/lib/agent-runner";
import { readJson } from "@/lib/runpod";
import { RequestError } from "@/lib/request-error";
export const runtime = "nodejs";
const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("rename"), projectId: z.uuid(), title: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("assign"), projectId: z.uuid(), sceneId: z.uuid() }),
  z.object({ action: z.literal("assignAsset"), projectId: z.uuid(), assetId: z.uuid() }),
  z.object({ action: z.literal("organize"), projectId: z.uuid() }),
  z.object({ action: z.literal("delete"), projectId: z.uuid(), title: z.string().min(1).max(120) }),
]);
export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const [collections, scenes] = await Promise.all([listCollections(), listProjects()]);
    return Response.json({ projects: collections.map(project => {
      const children = scenes.filter(scene => scene.collectionId === project.id);
      return { ...project, updatedAt: Math.max(project.updatedAt, ...children.map(scene => scene.updatedAt)), sceneCount: children.length, clipCount: children.reduce((sum, scene) => sum + scene.clipCount, 0), completed: children.reduce((sum, scene) => sum + scene.completed, 0), active: children.some(scene => isProjectActive(scene.id)) };
    }).sort((a, b) => b.updatedAt - a.updatedAt) }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = mutation.safeParse(await readJson(request, 2048));
    if (!parsed.success) throw new RequestError("Enter a project name or choose a scene.", "invalid_project");
    const data = parsed.data;
    if (data.action === "create") return Response.json({ project: await createCollection(data.title) }, { headers: privateHeaders });
    if (data.action === "rename") return Response.json({ project: await renameCollection(data.projectId, data.title) }, { headers: privateHeaders });
    if (data.action === "delete") return Response.json({ deleted: await deleteCollection(data.projectId, data.title) }, { headers: privateHeaders });
    await getCollection(data.projectId);
    if (data.action === "assignAsset") await assignCharacter(data.assetId, data.projectId);
    else if (data.action === "organize") {
      await organizeCollection(data.projectId);
      for (const scene of (await listProjects()).filter(scene => scene.collectionId === data.projectId)) await assignScene(scene.id, data.projectId);
      for (const item of await listCharacters(data.projectId)) await assignCharacter(item.id, data.projectId);
    } else { assertEditable(data.sceneId); await assignScene(data.sceneId, data.projectId); }
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
