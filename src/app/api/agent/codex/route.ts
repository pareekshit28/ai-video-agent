import { assertLocalRequest } from "@/lib/config";
import { codexInfo } from "@/lib/codex";
import { apiError, privateHeaders } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json(await codexInfo(), { headers: privateHeaders }); }
  catch (error) { return apiError(error); }
}
