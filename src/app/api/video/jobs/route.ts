import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { jobHistory, readJson, resolveUnknown } from "@/lib/runpod";
import { RequestError } from "@/lib/request-error";
import { localStudioJob } from "@/lib/studio-assets";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json({ jobs: (await jobHistory()).filter(job => job.endpoint !== "apimart").map(localStudioJob).filter(job => !new URL(request.url).searchParams.has("collectionId") || (job.collectionId || "") === new URL(request.url).searchParams.get("collectionId")) }, { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); const data = await readJson(request, 1024) as { localId?: string; reviewed?: boolean }; if (data?.reviewed !== true || typeof data.localId !== "string") throw new RequestError("Review the RunPod console first.", "review_required"); return Response.json({ job: await resolveUnknown(data.localId) }, { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
