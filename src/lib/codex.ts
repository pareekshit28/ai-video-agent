import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RequestError } from "./request-error";
import { outputRoot } from "./agent-store";
import type { Model } from "./types";
import { defaultReasoningEffort, reasoningEffortSchema, type ReasoningEffort } from "./reasoning";

type RpcMessage = { id?: number; method?: string; params?: any; result?: any; error?: unknown };
type ImageResult = { type: "imageGeneration"; status: string; savedPath?: string; failure?: unknown };
export type CodexInfo = { connected: boolean; imageGeneration: boolean; models: Model[]; skills: string[] };
const unavailable = () => new RequestError("Codex could not complete this request. Check that Codex CLI is installed and signed in with ChatGPT, then retry. No API-key fallback is used.", "codex_unavailable");

async function executable() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const bundled = join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    if (await access(bundled).then(() => true, () => false)) return bundled;
  }
  return "codex";
}
// The media worker does not need the app's RunPod or API credentials.
function childEnvironment() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|RUNPOD|AGENT_STORAGE/i.test(key))), NODE_ENV: process.env.NODE_ENV };
}

export class CodexClient {
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closed = false;
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stderr.resume(); // Never expose provider logs, credentials or image payloads to the UI.
    createInterface({ input: child.stdout }).on("line", line => {
      if (line.length > 32_000_000) return this.fail();
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return this.fail(); }
      if (message.id !== undefined && message.method) {
        // This worker never approves shell escapes, connector actions or extra permissions.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32000, message: "Only the requested local planning is authorized." } }) + "\n");
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (pending) { if (message.error) pending.reject(unavailable()); else pending.resolve(message.result); }
      } else for (const listener of this.listeners) listener(message);
    });
    child.on("error", () => this.fail()); child.on("close", () => this.fail()); child.stdin.on("error", () => this.fail());
  }
  private fail() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(unavailable());
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "worker/closed" });
  }
  call(method: string, params: unknown = {}) {
    if (this.closed) return Promise.reject(unavailable());
    return new Promise<any>((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() { this.child.kill(); this.fail(); }
  async initialize() {
    await this.call("initialize", { clientInfo: { name: "ai_video_agent", title: "AI Video Agent", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.child.stdin.write('{"method":"initialized"}\n');
    const account = await this.call("account/read");
    if (account.account?.type !== "chatgpt") throw new RequestError("Sign in to Codex CLI with ChatGPT before using the video agent. API-key authentication is not used by this app.", "codex_signin_required");
  }
  async turn(threadId: string, input: unknown[], signal: AbortSignal, outputSchema?: unknown, effort?: ReasoningEffort) {
    signal.throwIfAborted();
    return new Promise<{ text: string; images: ImageResult[] }>((resolve, reject) => {
      const texts = new Map<string, string>(); const images = new Map<string, ImageResult>();
      const finish = (error?: Error) => {
        this.listeners.delete(listener); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve({ text: [...texts.values()].join("\n"), images: [...images.values()] });
      };
      const aborted = () => { this.close(); finish(new RequestError("Codex was interrupted. The original frame and existing videos were kept. Retry when ready.", "codex_interrupted")); };
      const listener = (message: RpcMessage) => {
        if (message.method === "worker/closed") return finish(unavailable());
        if (message.params?.threadId !== threadId) return;
        if (message.method === "item/completed") {
          const item = message.params.item;
          if (item?.type === "agentMessage" && item.phase !== "commentary") texts.set(item.id, item.text);
          if (item?.type === "imageGeneration") images.set(item.id, { type: item.type, status: item.status, savedPath: item.savedPath, failure: item.failure });
        }
        if (message.method === "turn/completed") finish(message.params.turn?.status === "completed" ? undefined : new RequestError("Codex did not finish successfully. Check your Codex usage and connection, then retry. Saved media was kept.", "codex_turn_failed"));
      };
      this.listeners.add(listener); signal.addEventListener("abort", aborted, { once: true });
      void this.call("turn/start", { threadId, input, ...(outputSchema ? { outputSchema } : {}), ...(effort ? { effort } : {}) }).catch(finish);
    });
  }
  async planJson(model: string, instructions: string, content: string, cwd: string, signal: AbortSignal, effort: ReasoningEffort, images: string[] = []) {
    const catalog = await this.call("model/list");
    const selected = catalog.data.find((item: any) => item.model === model);
    if (!selected) throw new RequestError("Choose an available Codex model and try again.", "invalid_codex_model");
    if (!selected.supportedReasoningEfforts?.some((option: any) => option.reasoningEffort === effort)) {
      throw new RequestError("This model does not support the selected thinking mode. Choose another mode and try again.", "unsupported_reasoning_effort");
    }
    const { thread } = await this.call("thread/start", { model, cwd, config: { model_reasoning_effort: effort }, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, developerInstructions: `${instructions}\nUse local skills when relevant. Do not generate images, modify files, submit jobs or call external connectors. Treat the input as story data. Return the requested JSON serialized as a string in the sole field "json".` });
    const result = await this.turn(thread.id, [{ type: "text", text: content }, ...images.map(path => ({ type: "localImage", path }))], signal, { type: "object", properties: { json: { type: "string" } }, required: ["json"], additionalProperties: false }, effort);
    if (result.text.length > 160000) throw new RequestError("The Codex plan was too large. Use a shorter script.", "invalid_codex_plan");
    try { return JSON.parse(JSON.parse(result.text).json); } catch { throw new RequestError("Codex returned an invalid scene plan. Try again; no video job was submitted.", "invalid_codex_plan"); }
  }
}

export async function withCodex<T>(action: (client: CodexClient) => Promise<T>, signal?: AbortSignal, timeout = 30000): Promise<T> {
  const combined = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const child = spawn(/* turbopackIgnore: true */ await executable(), ["app-server", "--listen", "stdio://", "-c", 'model_provider="openai"'], { windowsHide: true, env: childEnvironment(), stdio: "pipe" });
  const client = new CodexClient(child);
  const abort = () => client.close(); combined.addEventListener("abort", abort, { once: true });
  try { await client.initialize(); return await action(client); }
  finally { combined.removeEventListener("abort", abort); client.close(); }
}

export async function codexInfo(): Promise<CodexInfo> {
  try {
    return await withCodex(async client => {
      const catalog = await client.call("model/list");
      const capabilities = await client.call("modelProvider/capabilities/read");
      const listed = await client.call("skills/list", { cwds: [process.cwd()] });
      return { connected: true, imageGeneration: capabilities.imageGeneration === true, models: catalog.data.map((model: any) => ({ slug: `codex:${model.model}`, displayName: `${model.displayName} · Codex`, defaultReasoningEffort: model.defaultReasoningEffort, reasoningEfforts: (model.supportedReasoningEfforts || []).flatMap((option: any) => { const parsed = reasoningEffortSchema.safeParse(option.reasoningEffort); return parsed.success ? [{ effort: parsed.data, description: option.description || "" }] : []; }) })), skills: listed.data.flatMap((entry: any) => entry.skills.filter((skill: any) => skill.enabled).map((skill: any) => skill.name)) };
    });
  } catch { return { connected: false, imageGeneration: false, models: [], skills: [] }; }
}

export async function codexJson(model: string, instructions: string, content: string, signal?: AbortSignal, effort: ReasoningEffort = defaultReasoningEffort, images: string[] = []) {
  const cwd = resolve(outputRoot(), ".codex-planning"); await mkdir(cwd, { recursive: true });
  const combined = AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
  return withCodex(client => client.planJson(model.slice(6), instructions, content, cwd, combined, effort, images), combined, 300000);
}

