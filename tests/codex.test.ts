import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexClient } from "../src/lib/codex";

function worker() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit("close"); return true; } });
  const requests: any[] = [];
  createInterface({ input: child.stdin }).on("line", line => requests.push(JSON.parse(line)));
  const client = new CodexClient(child as unknown as ChildProcessWithoutNullStreams);
  const message = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, client, requests, message };
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
    const second = worker(); const call = second.client.call("initialize"); const closed = expect(call).rejects.toThrow("Codex could not complete"); second.child.emit("close"); await closed;
  });
  it("rejects server approval requests", async () => {
    const { client, requests, message } = worker();
    message({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "external-action" } });
    expect(requests[0]).toMatchObject({ id: 99, error: { code: -32000 } });
    client.close();
  });
});
