import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type Database = {
  runpod?: { endpoint: string; apiKey?: string };
  apimart?: { apiKey?: string };
  comfyCloud?: { apiKey?: string; baseUrl?: string };
  h3Jobs?: import("./h3").H3Job[];
};

type StoreRuntime = { queue: Promise<unknown>; key?: Buffer; directory?: string };
const globals = globalThis as typeof globalThis & { studioStore?: StoreRuntime };
const runtime = globals.studioStore ??= { queue: Promise.resolve() };

async function prepare() {
  if (runtime.key && runtime.directory) return { key: runtime.key, directory: runtime.directory };
  // Retain the existing location so saved RunPod credentials and jobs survive upgrades.
  const directory = process.env.AGENT_STORAGE_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".config"), "prompt-studio");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
  } else {
    await chmod(directory, 0o700);
  }
  const keyPath = join(directory, "storage.key");
  let key: Buffer;
  try { key = await readFile(keyPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(32);
    await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
  }
  if (key.length !== 32) throw new Error("Local credential encryption key is invalid.");
  runtime.key = key;
  runtime.directory = directory;
  return { key, directory };
}

export function encrypt(data: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

// One local Next.js process; serialized updates prevent credential and job-write races.
export function withDatabase<T>(action: (database: Database) => T | Promise<T>): Promise<T> {
  const operation = runtime.queue.then(async () => {
    const { key, directory } = await prepare();
    const path = join(directory, "credentials.enc");
    let stored: Record<string, unknown>;
    try { stored = JSON.parse(decrypt(await readFile(path), key)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      stored = {};
    }
    // Only retain data this app still owns. This also removes obsolete sign-in
    // credentials and sessions without touching Codex CLI's own credential store.
    const database: Database = {};
    if (stored.runpod !== undefined) database.runpod = stored.runpod as Database["runpod"];
    if (stored.apimart !== undefined) database.apimart = stored.apimart as Database["apimart"];
    if (stored.comfyCloud !== undefined) database.comfyCloud = stored.comfyCloud as Database["comfyCloud"];
    if (stored.h3Jobs !== undefined) database.h3Jobs = stored.h3Jobs as Database["h3Jobs"];
    const save = async () => {
      const temporary = join(directory, `credentials.${randomUUID()}.tmp`);
      await writeFile(temporary, encrypt(JSON.stringify(database), key), { mode: 0o600 });
      await rename(temporary, path);
    };
    // Complete the cleanup even if the requested operation subsequently fails.
    if (Object.keys(stored).some(key => !["runpod", "apimart", "comfyCloud", "h3Jobs"].includes(key))) await save();
    const result = await action(database);
    await save();
    return result;
  });
  runtime.queue = operation.catch(() => undefined);
  return operation;
}
