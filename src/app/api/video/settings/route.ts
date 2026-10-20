import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { connectionInfo, readJson, saveConnection } from "@/lib/runpod";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json(await connectionInfo(), { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); return Response.json(await saveConnection(await readJson(request, 4096)), { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
