import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RequestError } from "./request-error";
import type { AgentProject, Asset } from "./agent-types";

const globals = globalThis as typeof globalThis & { agentStoreQueue?: Promise<unknown> };
export { outputRoot } from "./output-storage";
import { outputRoot, storedRecordFolder, assertStorageReady, recordIds, moveRecord } from "./output-storage";
export function projectFolder(id: string, collectionId?: string) {
  if (!z.uuid().safeParse(id).success) throw new RequestError("Invalid project ID.", "invalid_project_id");
  return storedRecordFolder(id, false, "project.json", collectionId);
}
export function assetPath(projectId: string, path: string) {
  const root = projectFolder(projectId); const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new RequestError("Invalid media path.", "invalid_media_path");
  return target;
}
async function atomicJson(project: AgentProject) {
  const directory = projectFolder(project.id, project.collectionId); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `project.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(project, null, 2), { mode: 0o600 });
  await rename(temp, join(directory, "project.json"));
}
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = (globals.agentStoreQueue || Promise.resolve()).then(fn);
  globals.agentStoreQueue = next.catch(() => undefined); return next;
}
async function readProject(id: string): Promise<AgentProject> {
  try { const project = JSON.parse(await readFile(join(projectFolder(id), "project.json"), "utf8")); if (project.id !== id || !Array.isArray(project.clips) || !Array.isArray(project.references)) throw new Error("Invalid project"); return project; }
  catch (error) { if (error instanceof RequestError) throw error; throw new RequestError("This local project could not be opened.", "project_not_found"); }
}
export function getProject(id: string) { return serialized(() => readProject(id)); }
export function createProject(project: AgentProject) { assertStorageReady(); return serialized(async () => { const folder = projectFolder(project.id, project.collectionId); await mkdir(join(folder, "references"), { recursive: true, mode: 0o700 }); await mkdir(join(folder, "clips"), { mode: 0o700 }); await mkdir(join(folder, "frames"), { mode: 0o700 }); await mkdir(join(folder, "requests"), { mode: 0o700 }); await atomicJson(project); return project; }); }
export function assignScene(id: string, collectionId: string) {
  assertStorageReady();
  return serialized(async () => {
    const scene = await readProject(id), source = projectFolder(id);
    const destination = join(storedRecordFolder(collectionId, false, "workspace.json"), "scenes", id);
    if (resolve(source) === resolve(destination) && scene.collectionId === collectionId) return scene;
    await moveRecord(source, destination, id);
    scene.collectionId = collectionId; scene.updatedAt = Date.now(); await atomicJson(scene); return scene;
  });
}
export function updateProject<T = AgentProject>(id: string, action: (project: AgentProject) => T | Promise<T>): Promise<T> {
  assertStorageReady();
  return serialized(async () => { const project = await readProject(id); const result = await action(project); project.updatedAt = Date.now(); await atomicJson(project); return result; });
}
export function listProjects() {
  return serialized(async () => {
    await mkdir(outputRoot(), { recursive: true, mode: 0o700 });
    const identifiers = await recordIds();
    const projects = await Promise.all([...identifiers].map(id => readProject(id).catch(() => null)));
    return projects.filter((project): project is AgentProject => Boolean(project)).sort((a, b) => b.updatedAt - a.updatedAt).map(project => ({ id: project.id, collectionId: project.collectionId, title: project.title, status: project.status, updatedAt: project.updatedAt, clipCount: project.clips.length, completed: project.clips.filter(clip => clip.status === "complete").length }));
  });
}
export async function writeAsset(projectId: string, path: string, bytes: Buffer, mime: string, name: string): Promise<Asset> {
  const target = assetPath(projectId, path); const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, target);
  return { path, bytes: bytes.length, mime, name };
}
