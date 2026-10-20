import { reasoningEffortSchema } from "@/lib/reasoning";
import { after } from "next/server";
import { z } from "zod";
import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { getProject } from "@/lib/agent-store";
import { executeProject, pauseProject, publicProject, reserveRun } from "@/lib/agent-runner";
import { RequestError } from "@/lib/request-error";
import { codexInfo } from "@/lib/codex";
export const runtime = "nodejs";
export const maxDuration = 86400;
export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const parsed = z.object({ projectId: z.uuid(), action: z.enum(["start", "pause", "rerender", "retry"]), clipId: z.string().min(1).max(64).optional(), model: z.string().min(1).max(150).optional(), reasoningEffort: reasoningEffortSchema.optional() }).safeParse(await readJson(request, 2048));
    if (!parsed.success) throw new RequestError("Choose a project and an agent action.", "invalid_agent_action");
    const data = parsed.data;
    if (data.action === "pause") return Response.json({ project: publicProject(await pauseProject(data.projectId)) }, { headers: privateHeaders });
    if (!data.model) throw new RequestError("Choose a Codex model to prepare the video prompts.", "model_required");
    if ((data.action === "rerender" || data.action === "retry") && !data.clipId) throw new RequestError("Choose the clip to retry.", "invalid_clip_state");
    const codex = await codexInfo();
    if (!codex.connected) throw new RequestError("Sign in to Codex CLI with ChatGPT before generating.", "codex_signin_required");
    const controller = await reserveRun(data.projectId, data.model, { clipId: data.clipId, revision: data.action === "rerender", retryCurrent: data.action === "retry", reasoningEffort: data.reasoningEffort });
    // Local Node server work survives closing the browser. A server restart requires explicit Resume.
    after(() => executeProject(data.projectId, controller));
    return Response.json({ project: publicProject(await getProject(data.projectId)) }, { status: 202, headers: privateHeaders });
  } catch (error) { return apiError(error); }
}
