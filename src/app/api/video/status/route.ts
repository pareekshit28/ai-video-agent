import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { checkVideo, readJson } from "@/lib/runpod";
import { RequestError } from "@/lib/request-error";
import { saveStudioOutput } from "@/lib/studio-assets";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); const data = await readJson(request, 1024) as { jobId?: string; localId?: string; collectionId?: string }; if (typeof data?.jobId !== "string" || (data.localId !== undefined && typeof data.localId !== "string")) throw new RequestError("Enter a job ID.", "invalid_job_id"); return Response.json({ job: await saveStudioOutput(await checkVideo(data.jobId, data.localId, data.collectionId), request.signal) }, { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
