import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { comfyCloudConnectionInfo, saveComfyCloudConnection } from "@/lib/comfy-cloud";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json(await comfyCloudConnectionInfo(), { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); return Response.json(await saveComfyCloudConnection(await readJson(request, 4096)), { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
