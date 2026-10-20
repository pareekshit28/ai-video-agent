import { mkdir, readFile, writeFile, rename, readdir, realpath } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertStorageReady, storageRoots, storedRecordFolder, outputRoot, projectFolders, projectFolderName, moveRecord } from "./output-storage";
import { serialized } from "./agent-store";
import { RequestError } from "./request-error";
import { withDatabase } from "./store";

const schema = z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120), createdAt: z.number(), updatedAt: z.number() });
export type ProjectCollection = z.infer<typeof schema>;
async function read(id: string) {
  const folder = storedRecordFolder(id, false, "workspace.json");
  try {
    const project = schema.parse(JSON.parse(await readFile(join(folder, "workspace.json"), "utf8")));
    if (project.id !== id) throw new Error(); return project;
  } catch { throw new RequestError("This project could not be opened.", "project_not_found"); }
}
async function save(project: ProjectCollection, folder = storedRecordFolder(project.id, false, "workspace.json")) {
  await mkdir(folder, { recursive: true });
  const temp = join(folder, `workspace.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(project, null, 2), { mode: 0o600 });
  await rename(temp, join(folder, "workspace.json")); return project;
}
export function getCollection(id: string) { return serialized(() => read(id)); }
export function createCollection(title: string) {
  assertStorageReady();
  return serialized(() => { title = availableName(title); const folder = join(outputRoot(), title); if (existsSync(folder)) throw new RequestError("This folder already exists. Choose another project name.", "project_name_conflict"); const now = Date.now(); return save(schema.parse({ id: randomUUID(), title, createdAt: now, updatedAt: now }), folder); });
}
function availableName(title: string, id?: string) {
  const name = projectFolderName(title);
  if (storageRoots().some(root => projectFolders(root).some(project => project.id !== id && project.title.toLowerCase() === name.toLowerCase()))) throw new RequestError("A project with this name already exists. Choose a different name.", "project_name_conflict");
  return name;
}
async function organize(id: string, title?: string) {
  const project = await read(id), name = availableName(title ?? project.title, id);
  const source = storedRecordFolder(id, false, "workspace.json"), destination = join(dirname(source), name);
  await moveRecord(source, destination, id, true);
  return save({ ...project, title: name, updatedAt: title ? Date.now() : project.updatedAt }, destination);
}
export function organizeCollection(id: string) { assertStorageReady(); return serialized(() => organize(id)); }
export function renameCollection(id: string, title: string) {
  assertStorageReady();
  return serialized(() => organize(id, title));
}
export function listCollections() {
  return serialized(async () => {
    const ids = new Set<string>();
    for (const root of storageRoots()) {
      for (const project of projectFolders(root)) ids.add(project.id);
    }
    const projects = await Promise.all([...ids].map(id => read(id).catch(() => null)));
    return projects.filter((project): project is ProjectCollection => !!project).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function deleteCollection(id: string, title: string) {
  assertStorageReady();
  const globals = globalThis as typeof globalThis & { outputStorageChanging?: boolean; agentStoreQueue?: Promise<unknown>; characterQueue?: Promise<unknown>; studioSaves?: Map<string, Promise<unknown>>; videoAgentRunner?: { active?: unknown } };
  if (globals.videoAgentRunner?.active) throw new RequestError("Pause generation before deleting a project.", "storage_busy", 409);
  globals.outputStorageChanging = true;
  try {
    await Promise.all([globals.agentStoreQueue, globals.characterQueue, ...(globals.studioSaves?.values() || [])]);
    const project = await read(id);
    if (project.title !== title) throw new RequestError("The project name changed. Reopen the delete dialog and try again.", "project_changed", 409);
    const folders = storageRoots().flatMap(root => projectFolders(root).filter(item => item.id === id).map(item => ({ root, source: item.folder })));
    const sceneIds = new Set<string>(), libraryIds = new Set<string>();
    for (const { source } of folders) for (const [section, ids] of [["scenes", sceneIds], ["library", libraryIds]] as const) {
      try { for (const entry of await readdir(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ source, section), { withFileTypes: true })) if (entry.isDirectory() && z.uuid().safeParse(entry.name).success) ids.add(entry.name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Include earlier flat copies of this project's scene and library records.
    for (const root of storageRoots()) for (const [directory, manifest, ids] of [[root, "project.json", sceneIds], [join(root, "characters"), "character.json", libraryIds]] as const) {
      let entries; try { entries = await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
        const source = join(directory, entry.name);
        // These are user-selected runtime media folders, not deployment assets.
        let record; try { record = JSON.parse(await readFile(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ source, manifest), "utf8")); } catch { continue; }
        if (record.id === entry.name && (record.collectionId === id || ids.has(entry.name))) folders.push({ root, source });
      }
    }
    const jobIds = new Set<string>(), requestIds = new Set<string>();
    for (const { source } of folders) {
      const sceneFolders = existsSync(join(source, "workspace.json")) ? [...sceneIds].map(sceneId => join(source, "scenes", sceneId)) : [source];
      for (const sceneFolder of sceneFolders) {
        let scene; try { scene = JSON.parse(await readFile(join(sceneFolder, "project.json"), "utf8")); } catch { continue; }
        for (const clip of scene.clips || []) { if (clip.jobId) jobIds.add(clip.jobId); if (clip.requestId) requestIds.add(clip.requestId); }
      }
    }
    const belongs = (job: import("./h3").H3Job) => job.collectionId === id || (!!job.id && jobIds.has(job.id)) || requestIds.has(job.localId);
    await withDatabase(db => {
      const finished = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "REJECTED"]);
      if (db.h3Jobs?.some(job => belongs(job) && !finished.has(job.status))) throw new RequestError("This project has unfinished Runpod jobs. Resolve them before deleting it.", "project_busy", 409);
    });
    const batch = `${id}-${randomUUID()}`;
    const moves = await Promise.all(folders.map(async ({ root, source }, index) => {
      const base = await realpath(root), absolute = await realpath(source), rel = relative(base, absolute);
      const destination = resolve(base, ".trash", batch, String(index));
      const target = relative(base, destination);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !target.startsWith(`.trash${sep}`) || isAbsolute(target)) throw new RequestError("The project folder is outside its configured storage location.", "invalid_media_path");
      return { source: absolute, destination };
    }));
    const moved: typeof moves = [];
    try {
      for (const move of moves) { await mkdir(dirname(move.destination), { recursive: true }); await rename(move.source, move.destination); moved.push(move); }
      await withDatabase(db => { db.h3Jobs = db.h3Jobs?.filter(job => !belongs(job)); });
    } catch (error) {
      for (const move of moved.reverse()) await rename(move.destination, move.source);
      throw error;
    }
    return { id, trashFolders: [...new Set(moves.map(move => dirname(move.destination)))] };
  } finally { globals.outputStorageChanging = false; }
}
