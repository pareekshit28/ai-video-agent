import { defaultReasoningEffort, reasoningEffortSchema } from "@/lib/reasoning";
import { z } from "zod";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { identifyReferences } from "@/lib/agent-llm";
import { createProject, getProject, updateProject } from "@/lib/agent-store";
import { DEFAULT_VIDEO_PROVIDER, defaultGeneration, videoProviderSchema } from "@/lib/agent-types";
import { assertEditable, publicProject } from "@/lib/agent-runner";
import { RequestError } from "@/lib/request-error";
import { getCollection } from "@/lib/project-collections";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = z.object({ projectId: z.uuid().optional(), collectionId: z.uuid().optional(), script: z.string().trim().min(1).max(32000), model: z.string().min(1).max(150), videoProvider: videoProviderSchema.optional(), reasoningEffort: reasoningEffortSchema.default(defaultReasoningEffort) }).safeParse(await readJson(request, 140000));
    if (!parsed.success) throw new RequestError("Enter a scene or script and choose a Codex model.", "invalid_scene");
    const data = parsed.data;
    const snapshot = data.projectId ? await getProject(data.projectId) : undefined;
    const provider = data.videoProvider ?? (snapshot ? snapshot.settings.provider || "runpod" : DEFAULT_VIDEO_PROVIDER);
    if (data.collectionId) await getCollection(data.collectionId);
    if (snapshot) {
      assertEditable(snapshot.id);
      if (snapshot.clips.length || snapshot.references.length) throw new RequestError("Create a new project to analyze another scene. Your existing plan was kept.", "plan_locked");
    }
    const plan = await identifyReferences(data.script, data.model, request.signal, data.reasoningEffort, provider);
    const planned = { referencesIdentified: true, summary: plan.summary, script: data.script, model: data.model, reasoningEffort: data.reasoningEffort, references: plan.references, clips: [] };
    const now = Date.now();
    const project = snapshot ? await updateProject(snapshot.id, current => {
      assertEditable(snapshot.id);
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new RequestError("The draft changed while analyzing. Your saved changes were kept; try again.", "project_changed");
      Object.assign(current, planned); current.settings = { ...current.settings, provider }; return current;
    }) : await createProject({ id: crypto.randomUUID(), collectionId: data.collectionId, title: plan.title, ...planned, createdAt: now, updatedAt: now, status: "ready", settings: { ...defaultGeneration, provider } });
    return Response.json({ project: publicProject(project) }, { headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
