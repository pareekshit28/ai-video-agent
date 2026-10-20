import { assertLocalRequest } from "@/lib/config";
import { privateHeaders, apiError } from "@/lib/http";
import { readJson } from "@/lib/runpod";
import { storageInfo, saveStorage } from "@/lib/output-storage";
export const runtime = "nodejs";
export const maxDuration = 86400;
export async function GET(request: Request) {
  try { assertLocalRequest(request); return Response.json(storageInfo(), { headers: privateHeaders }); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { assertLocalRequest(request, true); return Response.json(await saveStorage(await readJson(request, 8192)), { headers: privateHeaders }); }
  catch (error) { return apiError(error); }
}
