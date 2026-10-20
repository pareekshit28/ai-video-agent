import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson, submitVideo } from "@/lib/runpod";
import { saveStudioInput } from "@/lib/studio-assets";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); const input = await readJson(request); await saveStudioInput(input); return Response.json({ job: await submitVideo(input) }, { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
