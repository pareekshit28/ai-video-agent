import { NextResponse } from "next/server";
import { RequestError } from "./request-error";

export const privateHeaders = { "Cache-Control": "no-store, private" };

export function apiError(error: unknown) {
  if (error instanceof RequestError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: privateHeaders });
  }
  return NextResponse.json({ error: "The request could not be completed. Check that the app is open at http://127.0.0.1:3000 and try again." }, { status: 400, headers: privateHeaders });
}
