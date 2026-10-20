import { z } from "zod";
export const publicReferenceUrlSchema = z.string().trim().max(4096).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}, "Use a public HTTPS URL accessible without signing in.");
