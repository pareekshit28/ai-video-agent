import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexClient, withCodex } from "../src/lib/codex";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

function workerProcess() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit("close"); return true; } });
  const requests: any[] = [];
  createInterface({ input: child.stdin }).on("line", line => requests.push(JSON.parse(line)));
  const message = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, requests, message };
}

function worker() {
  const transport = workerProcess();
  return { ...transport, client: new CodexClient(transport.child as unknown as ChildProcessWithoutNullStreams) };
}
describe("native Codex transport", () => {
  it.each(["low", "high"] as const)("explicitly overrides inherited thinking with %s for the planning thread and turn", async effort => {
    const { client, requests, message } = worker();
    const plan = client.planJson("test-model", "Use the MiniMax H3 skill.", "A scene.", "planning-folder", new AbortController().signal, effort, ["references/traveler.png"]);
    message({ id: requests[0].id, result: { data: [{ model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }] } });
    await vi.waitFor(() => expect(requests[1]?.method).toBe("thread/start"));
    expect(requests[1].params).toMatchObject({ config: { model_reasoning_effort: effort }, ephemeral: true, sandbox: "read-only" });
    message({ id: requests[1].id, result: { thread: { id: "planning-thread" } } });
    await vi.waitFor(() => expect(requests[2]?.method).toBe("turn/start"));
    expect(requests[2].params.effort).toBe(effort);
    expect(requests[2].params.input).toEqual([{ type: "text", text: "A scene." }, { type: "localImage", path: "references/traveler.png" }]);
    message({ id: requests[2].id, result: { turn: { id: "turn" } } });
    message({ method: "item/completed", params: { threadId: "planning-thread", item: { type: "agentMessage", id: "answer", phase: "final_answer", text: JSON.stringify({ json: JSON.stringify({ clips: [] }) }) } } });
    message({ method: "turn/completed", params: { threadId: "planning-thread", turn: { status: "completed" } } });
    expect(await plan).toEqual({ clips: [] }); client.close();
  });
  it("rejects unsupported thinking before starting inference", async () => {
    const { client, requests, message } = worker();
    const plan = client.planJson("test-model", "Plan.", "Scene.", "planning-folder", new AbortController().signal, "ultra");
    const rejected = expect(plan).rejects.toMatchObject({ code: "unsupported_reasoning_effort" });
    message({ id: requests[0].id, result: { data: [{ model: "test-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } });
    await rejected; expect(requests).toHaveLength(1); client.close();
  });
  it("collects completed image artifacts and final messages only for the requested thread", async () => {
    const { client, requests, message } = worker();
    const turn = client.turn("our-thread", [{ type: "localImage", path: "frame.jpg" }], new AbortController().signal);
    message({ id: requests[0].id, result: { turn: { id: "turn" } } });
    message({ method: "item/completed", params: { threadId: "other", item: { type: "imageGeneration", id: "wrong", status: "completed", savedPath: "wrong.png" } } });
    message({ method: "item/completed", params: { threadId: "our-thread", item: { type: "agentMessage", id: "thinking", phase: "commentary", text: "Working" } } });
    message({ method: "item/completed", params: { threadId: "our-thread", item: { type: "imageGeneration", id: "image", status: "completed", result: "large image payload", savedPath: "edited.png", failure: null } } });
    message({ method: "item/completed", params: { threadId: "our-thread", item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Done" } } });
    message({ method: "turn/completed", params: { threadId: "our-thread", turn: { status: "completed" } } });
    expect(await turn).toEqual({ text: "Done", images: [{ type: "imageGeneration", status: "completed", savedPath: "edited.png", failure: null }] }); client.close();
  });
  it("rejects failed turns and worker termination without exposing provider logs", async () => {
    const first = worker(); const turn = first.client.turn("thread", [], new AbortController().signal);
    const failure = expect(turn).rejects.toThrow("did not finish");
    first.message({ method: "turn/completed", params: { threadId: "thread", turn: { status: "failed", error: { message: "secret provider detail" } } } }); await failure; first.client.close();
    const second = worker(); const call = second.client.call("initialize"); const closed = expect(call).rejects.toMatchObject({ code: "codex_process_exited", message: expect.stringContaining("Request: initialize") }); second.child.emit("close", 1); await closed;
  });
  it.each([
    [-32602, "Invalid parameters: private-provider-detail", "selected model"],
    [-32603, "Required MCP server private-provider-detail failed to start", "enabled MCP servers"],
    [-32000, "Authentication failed: private-provider-detail", "ChatGPT sign-in"],
    [-32000, "Rate limit: private-provider-detail", "usage limits"],
  ])("keeps the failed RPC stage and code %s without exposing server text", async (code, detail, advice) => {
    const { client, requests, message } = worker();
    const failure = client.call("thread/start").catch(error => error);
    message({ id: requests[0].id, error: { code, message: detail } });
    const error = await failure;
    expect(error).toMatchObject({ code: "codex_rpc_failed", message: expect.stringContaining(`thread/start (RPC ${code})`) });
    expect(error.message).toContain(advice);
    expect(error.message).not.toContain("private-provider-detail");
    client.close();
  });
  it.each([
    ["ENOENT", "codex_not_found"], ["EACCES", "codex_start_failed"],
  ])("distinguishes executable startup failure %s from sign-in", async (code, expected) => {
    const { child, client } = worker();
    const failed = client.call("initialize").catch(error => error);
    child.emit("error", Object.assign(new Error("private-provider-detail"), { code }));
    // A subsequent process-close notification must not overwrite the startup error.
    child.emit("close", -1);
    expect(await failed).toMatchObject({ code: expected });
    expect((await client.call("model/list").catch(error => error)).message).not.toContain("private-provider-detail");
    client.close();
  });
  it("reports a broken app-server protocol without displaying stdout", async () => {
    const { child, client } = worker();
    const failed = client.call("initialize").catch(error => error);
    child.stdout.write("private-provider-detail\n");
    expect(await failed).toMatchObject({ code: "codex_protocol_error", message: expect.not.stringContaining("private-provider-detail") });
    client.close();
  });
  it.each([false, true])("preserves interruption reason during a running turn (timeout=%s)", async timeout => {
    const { client, requests, message } = worker();
    const controller = new AbortController();
    const failed = client.turn("thread", [], controller.signal).catch(error => error);
    message({ id: requests[0].id, result: { turn: { id: "turn" } } });
    controller.abort(timeout ? new DOMException("private-provider-detail", "TimeoutError") : undefined);
    expect(await failed).toMatchObject({ code: timeout ? "codex_timeout" : "codex_interrupted" });
  });
  it.each([false, true])("preserves interruption reason while initializing (timeout=%s)", async timeout => {
    const { child, requests } = workerProcess();
    vi.stubEnv("CODEX_CLI_PATH", "codex-test");
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    const controller = new AbortController(); const action = vi.fn();
    const failed = withCodex(action, controller.signal).catch(error => error);
    await vi.waitFor(() => expect(requests[0]?.method).toBe("initialize"));
    controller.abort(timeout ? new DOMException("private-provider-detail", "TimeoutError") : undefined);
    expect(await failed).toMatchObject({ code: timeout ? "codex_timeout" : "codex_interrupted" });
    expect(action).not.toHaveBeenCalled();
  });
  it("reports a process exit during a running turn", async () => {
    const { child, client, requests, message } = worker();
    const failed = client.turn("thread", [], new AbortController().signal).catch(error => error);
    message({ id: requests[0].id, result: { turn: { id: "turn" } } });
    child.emit("close", 1);
    expect(await failed).toMatchObject({ code: "codex_process_exited", message: expect.stringContaining("code 1") });
  });
  it("rejects server approval requests", async () => {
    const { client, requests, message } = worker();
    message({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "external-action" } });
    expect(requests[0]).toMatchObject({ id: 99, error: { code: -32000 } });
    client.close();
  });
});
