import { assertLocalRequest } from "@/lib/config";
import { apiError, privateHeaders } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { apimartConnectionInfo, saveApimartConnection } from "@/lib/apimart";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json(await apimartConnectionInfo(), { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); return Response.json(await saveApimartConnection(await readJson(request, 4096)), { headers: privateHeaders }); } catch (error) { return apiError(error); }
}
