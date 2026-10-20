import { mkdir, readFile, readdir, writeFile, rename, realpath, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { z } from "zod";
import { storedRecordFolder, assertStorageReady, recordIds, moveRecord, storageRoots, projectFolders } from "./output-storage";
import { getCollection } from "./project-collections";
import { characterInputSchema, saveReference } from "./reference-media";
import { RequestError } from "./request-error";
import type { Asset } from "./agent-types";

export type LibraryKind = "character" | "location" | "prop";
export type Character = { id: string; collectionId?: string; kind?: LibraryKind; name: string; description: string; images: Asset[]; voices: Asset[]; updatedAt: number };
const globals = globalThis as typeof globalThis & { characterQueue?: Promise<unknown> };
export function characterPath(id: string, path = "character.json") {
  if (!z.uuid().safeParse(id).success) throw new RequestError("Invalid character ID.", "invalid_character");
  const root = storedRecordFolder(id, true), target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new RequestError("Invalid character asset.", "invalid_character");
  return target;
}
export async function getCharacter(id: string): Promise<Character> {
  try { const value = JSON.parse(await readFile(characterPath(id), "utf8")); if (value.id !== id) throw new Error(); return { ...value, kind: value.kind || "character" }; }
  catch { throw new RequestError("Character could not be opened.", "character_not_found"); }
}
export async function listCharacters(collectionId?: string) {
  const entries = new Set(await recordIds(true));
  const values = await Promise.all([...entries].filter(id => z.uuid().safeParse(id).success).map(id => getCharacter(id).catch(() => null)));
  return values.filter((value): value is Character => !!value && (collectionId === undefined || (value.collectionId || "") === collectionId)).sort((a,b) => b.updatedAt - a.updatedAt);
}
export function assignCharacter(id: string, collectionId: string): Promise<Character> {
  assertStorageReady();
  const operation = (globals.characterQueue || Promise.resolve()).then(async () => {
    const item = await getCharacter(id), source = storedRecordFolder(id, true);
    const directory = join(storedRecordFolder(collectionId, false, "workspace.json"), "library", id);
    if (resolve(source) === resolve(directory) && item.collectionId === collectionId) return item;
    await moveRecord(source, directory, id);
    item.collectionId = collectionId; item.updatedAt = Date.now();
    const temp = join(directory, `character-${crypto.randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(item, null, 2), { mode: 0o600 }); await rename(temp, join(directory, "character.json")); return item;
  }); globals.characterQueue = operation.catch(() => undefined); return operation;
}
export function saveCharacter(value: unknown): Promise<Character> {
  assertStorageReady();
  const parsed = characterInputSchema.safeParse(value);
  if (!parsed.success) throw new RequestError(parsed.error.issues[0].message, "invalid_character");
  const operation = (globals.characterQueue || Promise.resolve()).then(async () => {
    const input = parsed.data, id = input.id || crypto.randomUUID(), previous = input.id ? await getCharacter(id) : undefined;
    const collectionId = previous?.collectionId || input.collectionId;
    if (previous && input.collectionId !== undefined && input.collectionId !== previous.collectionId) throw new RequestError("Move this library item into the project before editing it.", "invalid_library_project");
    if (collectionId) await getCollection(collectionId);
    const kind = input.kind || previous?.kind || "character";
    const voiceCount = input.voices?.length ?? previous?.voices.length ?? 0;
    if (input.voiceUrls && input.voiceUrls.length !== voiceCount) throw new RequestError("Provide one link field for each voice sample. Upload the matching local sample first.", "invalid_library_item");
    if (kind !== "character" && input.voiceUrls?.some(Boolean)) throw new RequestError("Voice links are supported for characters only.", "invalid_library_item");
    if (kind !== "character" && (input.voices?.length || (input.voices === undefined && previous?.voices.length))) throw new RequestError("Voice samples are supported for characters. Locations and props use image references.", "invalid_library_item");
    const directory = storedRecordFolder(id, true, "character.json", collectionId); await mkdir(directory, { recursive: true });
    const images = input.images ? await Promise.all(input.images.map(file => saveReference(directory, file, "image"))) : previous?.images || [];
    const voices = input.voices ? await Promise.all(input.voices.map(file => saveReference(directory, file, "audio"))) : previous?.voices || [];
    if (input.voiceUrls) voices.forEach((voice, index) => { voice.publicUrl = input.voiceUrls![index] || undefined; });
    const character: Character = { id, collectionId, kind, name: input.name, description: input.description, images, voices, updatedAt: Date.now() };
    const temporary = join(directory, `character-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(character, null, 2), { mode: 0o600 }); await rename(temporary, join(directory, "character.json"));
    return character;
  }); globals.characterQueue = operation.catch(() => undefined); return operation;
}
export function deleteCharacter(id: string, collectionId: string) {
  assertStorageReady();
  const operation = (globals.characterQueue || Promise.resolve()).then(async () => {
    assertStorageReady();
    const item = await getCharacter(id);
    if (item.collectionId !== collectionId) throw new RequestError("Select this reference's project before removing it.", "invalid_library_project");
    const moves: { source: string; destination: string }[] = [];
    const batch = `library-${id}-${crypto.randomUUID()}`;
    for (const root of storageRoots()) {
      const candidates = [join(root, "characters", id), ...projectFolders(root).map(project => join(project.folder, "library", id))];
      for (const source of candidates) {
        if (!existsSync(join(source, "character.json"))) continue;
        const saved = JSON.parse(await readFile(join(source, "character.json"), "utf8"));
        if (saved.id !== id || saved.collectionId !== collectionId) throw new RequestError("A saved copy of this reference belongs to another project.", "invalid_library_project");
        const base = await realpath(root), absolute = await realpath(source), rel = relative(base, absolute);
        if ((await lstat(source)).isSymbolicLink() || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new RequestError("The reference folder is outside its configured storage location.", "invalid_media_path");
        if (existsSync(join(base, ".trash")) && (await lstat(join(base, ".trash"))).isSymbolicLink()) throw new RequestError("The recovery folder must be inside the configured storage location.", "invalid_media_path");
        moves.push({ source: absolute, destination: join(base, ".trash", batch, String(moves.length)) });
      }
    }
    const moved: typeof moves = [];
    try {
      for (const move of moves) { await mkdir(dirname(move.destination), { recursive: true }); await rename(move.source, move.destination); moved.push(move); }
    } catch (error) {
      for (const move of moved.reverse()) await rename(move.destination, move.source);
      throw error;
    }
    return { id, trashFolders: [...new Set(moves.map(move => dirname(move.destination)))] };
  });
  globals.characterQueue = operation.catch(() => undefined);
  return operation;
}
export function cloneCharacter(id: string, collectionId: string): Promise<Character> {
  assertStorageReady();
  const operation = (globals.characterQueue || Promise.resolve()).then(async () => {
    assertStorageReady();
    const source = await getCharacter(id);
    if (source.collectionId !== collectionId) throw new RequestError("Choose a library asset from the selected project.", "invalid_library_project");
    await getCollection(collectionId);
    const kind = source.kind || "character";
    const names = new Set((await listCharacters(collectionId)).filter(item => (item.kind || "character") === kind).map(item => item.name.toLowerCase()));
    let count = 1, name: string;
    do { const suffix = count === 1 ? " (copy)" : ` (copy ${count})`; name = source.name.slice(0, 120 - suffix.length) + suffix; count++; } while (names.has(name.toLowerCase()));
    const cloneId = crypto.randomUUID();
    const directory = storedRecordFolder(cloneId, true, "character.json", collectionId);
    await mkdir(directory, { recursive: true });
    const copy = async (asset: Asset): Promise<Asset> => {
      const extension = asset.path.split(".").pop()!;
      if (!/^[a-z0-9]+$/i.test(extension)) throw new RequestError("Unsupported saved asset filename.", "invalid_character");
      const path = `${crypto.randomUUID()}.${extension}`;
      // These are runtime media files in the configured storage folder, not bundled files.
      await writeFile(join(/* turbopackIgnore: true */ directory, path), await readFile(characterPath(source.id, asset.path)), { mode: 0o600 });
      return { ...asset, path };
    };
    const character: Character = { ...source, id: cloneId, collectionId, kind, name, images: await Promise.all(source.images.map(copy)), voices: await Promise.all(source.voices.map(copy)), updatedAt: Date.now() };
    const temporary = join(directory, `character-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(character, null, 2), { mode: 0o600 }); await rename(temporary, join(directory, "character.json"));
    return character;
  });
  globals.characterQueue = operation.catch(() => undefined);
  return operation;
}
