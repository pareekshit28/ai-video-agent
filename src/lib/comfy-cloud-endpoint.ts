import { z } from "zod";

export const DEFAULT_COMFY_CLOUD_URL = "https://cloud.comfy.org";
export const comfyCloudUrlSchema = z.string().trim().url().refine(value => {
  const url = new URL(value);
  const allowedHost = url.hostname === "cloud.comfy.org" || /^dep-[a-z0-9]+(?:-[a-z0-9]+)*\.run\.comfy\.app$/i.test(url.hostname);
  return allowedHost && url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
}, "Use https://cloud.comfy.org or an HTTPS dep-…run.comfy.app deployment URL, without an API path, query or credentials.").transform(value => new URL(value).origin);
