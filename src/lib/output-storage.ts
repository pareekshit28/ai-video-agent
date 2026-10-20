import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile, unlink, rename, readdir, readFile, cp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RequestError } from "./request-error";

type StorageConfig = { folder: string; previousFolders: string[] };
const globals = globalThis as typeof globalThis & {
  outputStorageChanging?: boolean;
  agentStoreQueue?: Promise<unknown>;
  characterQueue?: Promise<unknown>;
  videoAgentRunner?: { active?: unknown };
  studioSaves?: Map<string, Promise<unknown>>;
};
function configPath() { return join(process.env.AGENT_STORAGE_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".config"), "prompt-studio"), "output-storage.json"); }
function absoluteFolder(value: string) {
  if (!isAbsolute(value)) throw new RequestError("Enter the full absolute path to a local folder, such as G:\\My Drive\\AI Video Agent.", "invalid_output_directory");
  return resolve(value);
}
function configuration(): StorageConfig {
  try {
    const value = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof value.folder !== "string" || !Array.isArray(value.previousFolders) || value.previousFolders.some((folder: unknown) => typeof folder !== "string")) throw new Error();
    return { folder: absoluteFolder(value.folder), previousFolders: value.previousFolders.map(absoluteFolder) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RequestError("Could not read the saved storage-folder setting. Check the local app settings folder.", "invalid_storage_settings");
    return { folder: absoluteFolder(process.env.VIDEO_OUTPUT_DIR || join(homedir(), "Videos", "AI Video Agent")), previousFolders: [] };
  }
}
export function outputRoot() { return configuration().folder; }
export function storageRoots() { const config = configuration(); return [...new Set([config.folder, ...config.previousFolders])]; }
export function projectFolderName(title: string) {
  const name = title.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || [".", "..", "characters", ".codex-planning"].includes(name.toLowerCase())) throw new RequestError("Use a valid project folder name without slashes, special characters, trailing dots, or reserved names.", "invalid_project_name");
  return name;
}
export function projectFolders(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const folder = join(root, entry.name);
    try { const project = JSON.parse(readFileSync(join(folder, "workspace.json"), "utf8")); return z.uuid().safeParse(project.id).success ? [{ folder, id: project.id as string, title: project.title as string }] : []; } catch { return []; }
  });
}
export function storedRecordFolder(id: string, library = false, manifest = library ? "character.json" : "project.json", collectionId?: string): string {
  if (!z.uuid().safeParse(id).success) throw new RequestError("Invalid saved item ID.", "invalid_project_id");
  const roots = storageRoots();
  for (const root of roots) {
    if (manifest === "workspace.json") { const project = projectFolders(root).find(item => item.id === id); if (project) return project.folder; }
    if (manifest !== "workspace.json" && existsSync(root)) for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(root, entry.name, "workspace.json"))) continue;
      const nested = join(root, entry.name, library ? "library" : "scenes", id);
      if (existsSync(join(nested, manifest))) return nested;
    }
    const directory = library ? join(root, "characters", id) : join(root, id);
    if (existsSync(join(directory, manifest))) return directory;
  }
  if (collectionId) return join(storedRecordFolder(collectionId, false, "workspace.json"), library ? "library" : "scenes", id);
  return library ? join(roots[0], "characters", id) : join(roots[0], id);
}
export async function recordIds(library = false) {
  const result = new Set<string>();
  for (const root of storageRoots()) {
    for (const id of await ids(library ? join(root, "characters") : root)) result.add(id);
    for (const project of projectFolders(root)) for (const id of await ids(join(project.folder, library ? "library" : "scenes"))) result.add(id);
  }
  return [...result];
}
export async function moveRecord(source: string, destination: string, id: string, parentProject = false) {
  assertStorageReady();
  if (resolve(source) === resolve(destination)) return;
  if (globals.videoAgentRunner?.active) throw new RequestError("Pause generation before organizing project files.", "storage_busy", 409);
  // Check both final absolute paths against the configured storage roots before moving or removing any directory.
  const validRecord = parentProject ? JSON.parse(await readFile(join(source, "workspace.json"), "utf8")).id === id : source.split(sep).pop() === id && destination.split(sep).pop() === id;
  if (!z.uuid().safeParse(id).success || !validRecord || !storageRoots().some(root => inside(root, source)) || !storageRoots().some(root => inside(root, destination))) throw new RequestError("Invalid project asset location.", "invalid_media_path");
  if (parentProject && globals.studioSaves?.size) throw new RequestError("Wait for video downloads before organizing project files.", "storage_busy", 409);
  if (existsSync(destination)) throw new RequestError("The destination already contains this saved item. Its files were kept.", "storage_copy_conflict");
  await mkdir(resolve(destination, ".."), { recursive: true });
  try { await rename(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const stage = join(resolve(destination, ".."), `.copy-${randomUUID()}`);
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    await rename(stage, destination);
    await rm(source, { recursive: true });
  }
}
export function assertStorageReady() {
  if (globals.outputStorageChanging) throw new RequestError("Storage files are being copied. Wait for the folder change to finish before editing or generating.", "storage_busy", 409);
}
export function storageInfo() { return { ...configuration(), changing: Boolean(globals.outputStorageChanging) }; }

async function ids(directory: string) {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && z.uuid().safeParse(entry.name).success).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function inside(parent: string, child: string) { const rel = relative(parent, child); return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
export async function saveStorage(value: unknown) {
  const parsed = z.object({ folder: z.string().trim().min(1).max(4096), copyExisting: z.boolean().default(true) }).safeParse(value);
  if (!parsed.success) throw new RequestError("Choose a folder for saved projects and references.", "invalid_output_directory");
  assertStorageReady();
  if (globals.videoAgentRunner?.active) throw new RequestError("Pause video generation and wait for it to stop before changing the storage folder.", "storage_busy", 409);
  const folder = absoluteFolder(parsed.data.folder.replace(/^"(.*)"$/, "$1"));
  const previous = storageRoots();
  if (previous.some(root => inside(root, folder))) throw new RequestError("Choose a folder outside the current project storage folders to avoid copying a folder into itself.", "invalid_output_directory");
  globals.outputStorageChanging = true;
  let copiedProjects = 0, copiedLibraryItems = 0;
  try {
    await Promise.all([globals.agentStoreQueue, globals.characterQueue, ...(globals.studioSaves?.values() || [])]);
    try {
      await mkdir(folder, { recursive: true });
      const probe = join(folder, `.write-check-${randomUUID()}`);
      await writeFile(probe, "", { flag: "wx" }); await unlink(probe);
    } catch { throw new RequestError("This folder is unavailable or cannot be written to. Check the path and make sure your Google Drive folder is mounted and accessible.", "output_folder_unavailable"); }
    if (parsed.data.copyExisting) {
      const records = new Map<string, { source: string; destination: string; manifest: string; library: boolean; id: string }>();
      for (const root of previous) for (const project of projectFolders(root)) {
        const key = `project/${project.id}`;
        if (!records.has(key)) records.set(key, { source: project.folder, destination: join(folder, projectFolderName(project.title)), manifest: "workspace.json", library: false, id: project.id });
      }
      for (const root of previous) for (const library of [false, true]) {
        const sourceRoot = library ? join(root, "characters") : root;
        for (const id of await ids(sourceRoot)) {
          const source = join(sourceRoot, id);
          const manifest = library ? "character.json" : existsSync(join(source, "project.json")) ? "project.json" : "workspace.json";
          if (!existsSync(join(source, manifest))) continue;
          const key = `${library ? "library" : "project"}/${id}`;
          if (!records.has(key)) records.set(key, { source, destination: library ? join(folder, "characters", id) : join(folder, id), manifest, library, id });
        }
      }
      // Parent folders already contain their scenes and library assets. Do not
      // re-copy older flat backups of those IDs as duplicate root-level items.
      for (const record of records.values()) if (record.manifest === "workspace.json") {
        for (const id of await ids(join(record.source, "scenes"))) records.delete(`project/${id}`);
        for (const id of await ids(join(record.source, "library"))) records.delete(`library/${id}`);
      }
      // Check all collisions before copying; never replace an existing saved item.
      const destinations = new Set<string>();
      for (const record of records.values()) {
        const key = resolve(record.destination).toLowerCase();
        if (destinations.has(key)) throw new RequestError("Two projects use the same folder name. Rename one before copying storage.", "storage_copy_conflict");
        destinations.add(key);
      }
      for (const record of records.values()) if (relative(record.source, record.destination) !== "" && existsSync(record.destination)) {
        throw new RequestError("The chosen folder already contains a project or library item with the same ID. Choose an empty folder, or turn off copying to use the existing files there.", "storage_copy_conflict");
      }
      for (const record of records.values()) {
        if (relative(record.source, record.destination) === "") continue;
        const parent = record.library ? join(folder, "characters") : folder;
        await mkdir(parent, { recursive: true });
        const stage = join(parent, `.copy-${randomUUID()}`);
        // Both paths are contained in the explicitly selected destination folder.
        if (!inside(folder, stage) || !inside(folder, record.destination)) throw new RequestError("Invalid copy destination.", "invalid_output_directory");
        await cp(record.source, stage, { recursive: true, force: false, errorOnExist: true, dereference: false });
        const copied = JSON.parse(await readFile(join(stage, record.manifest), "utf8"));
        if (copied.id !== record.id) throw new RequestError("A saved item could not be verified. The storage folder was not changed.", "storage_copy_failed");
        await rename(stage, record.destination);
        if (record.library) copiedLibraryItems++; else { copiedProjects++; if (record.manifest === "workspace.json") copiedLibraryItems += (await ids(join(record.destination, "library"))).length; }
      }
    }
    const next: StorageConfig = { folder, previousFolders: previous.filter(root => relative(root, folder) !== "") };
    const path = configPath(), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temporary, path);
    return { ...next, changing: false, copiedProjects, copiedLibraryItems };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("Could not finish copying or saving the storage setting. Original files are kept and the previous storage folder remains active. Check folder access and free space.", "storage_copy_failed");
  } finally { globals.outputStorageChanging = false; }
}
