import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { createProject, listProjects, outputRoot, updateProject } from "@/lib/agent-store";
import { assertEditable, isProjectActive, publicProject } from "@/lib/agent-runner";
import { z } from "zod";
import { defaultGeneration } from "@/lib/agent-types";
import { readJson } from "@/lib/runpod";
import { RequestError } from "@/lib/request-error";
import { getCollection } from "@/lib/project-collections";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json({ folder: outputRoot(), projects: (await listProjects()).map(project => ({ ...project, active: isProjectActive(project.id), status: !isProjectActive(project.id) && ["preparing", "running"].includes(project.status) ? "paused" : project.status })) }, { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
const title = z.string().trim().min(1, "Enter a project name.").max(120);
const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), collectionId: z.uuid().optional(), title, script: z.string().max(32000).default("") }),
  z.object({ action: z.literal("rename"), projectId: z.uuid(), title }),
  z.object({ action: z.literal("saveDraft"), projectId: z.uuid(), script: z.string().max(32000) }),
]);
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = mutation.safeParse(await readJson(request, 140000));
    if (!parsed.success) throw new RequestError(parsed.error.issues[0].message, "invalid_project");
    const data = parsed.data;
    let project;
    if (data.action === "create") {
      if (data.collectionId) await getCollection(data.collectionId);
      const now = Date.now();
      project = await createProject({ id: crypto.randomUUID(), collectionId: data.collectionId, title: data.title, script: data.script, summary: "", model: "", createdAt: now, updatedAt: now, status: "ready", settings: { ...defaultGeneration }, references: [], clips: [] });
    } else {
      assertEditable(data.projectId);
      project = await updateProject(data.projectId, current => {
        assertEditable(data.projectId);
        if (data.action === "rename") current.title = data.title;
        else {
          if (current.clips.length || current.references.length) throw new RequestError("Only an unanalyzed draft can be edited here. Your existing plan and references were kept.", "plan_locked");
          current.script = data.script;
        }
        return current;
      });
    }
    return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
