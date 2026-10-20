import { RequestError } from "./request-error";

export function appOrigin() {
  const url = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:3000");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("This local app requires an HTTP origin on 127.0.0.1.");
  }
  return url.origin;
}

export function assertLocalRequest(request: Request, mutation = false) {
  const origin = appOrigin();
  // Next.js normalizes its internal request URL to localhost. Validate the actual
  // incoming Host header, never a forwarded host, against the loopback origin.
  if (new URL(request.url).protocol !== "http:" || request.headers.get("host") !== new URL(origin).host) {
    throw new RequestError("Open this app at " + origin + " and try again.", "invalid_local_host");
  }
  if (mutation && request.headers.get("origin") !== origin) {
    throw new RequestError("The request came from an unexpected origin. Reopen " + origin + " and try again.", "invalid_request_origin");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestError("Cross-site request was rejected. Open " + origin + " directly and try again.", "cross_site_request");
  }
}
