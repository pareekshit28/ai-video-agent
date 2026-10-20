import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { encrypt, decrypt, withDatabase } from "../src/lib/store";
import { assertLocalRequest } from "../src/lib/config";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "video-agent-store-test-"));
  vi.stubEnv("AGENT_STORAGE_DIR", directory);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (rel.startsWith("video-agent-store-test-") && !isAbsolute(rel) && !rel.includes("..")) await rm(directory, { recursive: true, force: true });
});

describe("local storage and request protection", () => {
  it("rejects external hosts, cross-origin mutations and cross-site requests", () => {
    const url = "http://127.0.0.1:3000/api/agent/analyze";
    expect(() => assertLocalRequest(new Request(url, { headers: { host: "127.0.0.1:3000", origin: "https://attacker.example" } }), true)).toThrow();
    expect(() => assertLocalRequest(new Request("http://attacker.example/api/agent/projects", { headers: { host: "attacker.example" } }))).toThrow();
    expect(() => assertLocalRequest(new Request(url, { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }), true)).not.toThrow();
    expect(() => assertLocalRequest(new Request(url, { headers: { host: "127.0.0.1:3000", origin: "null" } }), true)).toThrow();
    expect(() => assertLocalRequest(new Request(url, { headers: { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" } }))).toThrow();
  });
  it("encrypts secrets and rejects modified ciphertext or an incorrect key", () => {
    const key = randomBytes(32), encrypted = encrypt('{"apiKey":"secret-test-key"}', key);
    expect(encrypted.includes(Buffer.from("secret-test-key"))).toBe(false);
    expect(decrypt(encrypted, key)).toContain("secret-test-key");
    expect(() => decrypt(encrypted, randomBytes(32))).toThrow();
    encrypted[encrypted.length - 1] ^= 1;
    expect(() => decrypt(encrypted, key)).toThrow();
  });
  it("removes obsolete credentials on upgrade while preserving the RunPod key and all job history", async () => {
    await withDatabase(() => undefined);
    const key = await readFile(join(directory, "storage.key"));
    const retained = { runpod: { endpoint: "original-endpoint", apiKey: "saved-test-key" }, h3Jobs: [{ id: "existing-job", status: "complete" }] };
    const old = { ...retained, hostId: "old-installation", profiles: { old: { credentials: { accessToken: "obsolete-access", refreshToken: "obsolete-refresh" } } }, sessions: { old: {} }, transactions: { old: {} } };
    await writeFile(join(directory, "credentials.enc"), encrypt(JSON.stringify(old), key));
    await expect(withDatabase(async db => { expect(db).toEqual(retained); throw new Error("Requested operation failed"); })).rejects.toThrow("Requested operation failed");
    expect(JSON.parse(decrypt(await readFile(join(directory, "credentials.enc")), key))).toEqual(retained);
    const results = await Promise.all([withDatabase(db => { db.runpod!.endpoint = "updated-endpoint"; }), withDatabase(db => db.runpod!.endpoint)]);
    expect(results[1]).toBe("updated-endpoint");
    expect(await readFile(join(directory, "storage.key"))).toEqual(key);
  });
});
