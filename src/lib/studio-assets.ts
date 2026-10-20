import { existsSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertStorageReady, storedRecordFolder } from "./output-storage";
import { submissionSchema, type H3Job } from "./h3";
import { getCollection } from "./project-collections";
import { saveReference } from "./reference-media";
import { downloadVideoFile, probeMedia } from "./agent-media";
import { RequestError } from "./request-error";
import { serialized } from "./agent-store";

export function studioFolder(projectId: string, localId: string) {
  if (!z.uuid().safeParse(projectId).success || !z.uuid().safeParse(localId).success) throw new RequestError("Invalid saved video.", "invalid_media_path");
  return join(storedRecordFolder(projectId, false, "workspace.json"), "studio", localId);
}
export async function saveStudioInput(value: unknown) {
  const parsed = submissionSchema.safeParse(value); if (!parsed.success) throw new RequestError(parsed.error.issues[0].message, "invalid_video_request");
  const input = parsed.data; if (!input.collectionId) return;
  assertStorageReady(); await getCollection(input.collectionId);
  return serialized(async () => {
  assertStorageReady();
  const directory = studioFolder(input.collectionId!, input.requestId); await mkdir(directory, { recursive: true });
  if (existsSync(join(directory, "request.json"))) return;
  const images = await Promise.all(input.images.map(file => saveReference(directory, file, "image")));
  const audios = await Promise.all(input.audios.map(file => saveReference(directory, file, "audio")));
  await writeFile(join(directory, "request.json"), JSON.stringify({ settings: input.settings, images, audios }, null, 2), { mode: 0o600 });
  });
}
export function localStudioJob(job: H3Job): H3Job {
  return job.collectionId && !job.agent && existsSync(join(studioFolder(job.collectionId, job.localId), "output.mp4")) ? { ...job, output: { video: `/api/video/media?projectId=${job.collectionId}&localId=${job.localId}` } } : job;
}
const globals = globalThis as typeof globalThis & { studioSaves?: Map<string, Promise<H3Job>> };
export async function saveStudioOutput(job: H3Job, signal: AbortSignal): Promise<H3Job> {
  if (!job.collectionId || job.agent || job.status !== "COMPLETED") return job;
  const saves = globals.studioSaves ??= new Map(); const key = `${job.collectionId}/${job.localId}`;
  if (saves.has(key)) return saves.get(key)!;
  const operation = (async () => {
    assertStorageReady();
    await getCollection(job.collectionId!);
    const directory = studioFolder(job.collectionId!, job.localId); await mkdir(directory, { recursive: true });
    const target = join(directory, "output.mp4");
    if (!existsSync(target)) {
      const staging = join(directory, "output.pending.mp4");
      if (!existsSync(staging)) await downloadVideoFile(job.output, staging, signal);
      await probeMedia(staging, signal); await rename(staging, target);
    }
    const saved = { ...job, output: { video: `/api/video/media?projectId=${job.collectionId}&localId=${job.localId}` } };
    const temporary = join(directory, "job.tmp"); await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 }); await rename(temporary, join(directory, "job.json")); return saved;
  })();
  saves.set(key, operation); try { return await operation; } finally { saves.delete(key); }
}
