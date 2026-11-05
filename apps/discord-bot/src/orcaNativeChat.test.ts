import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findNativeChat, orcaFingerprint, orcaProfiles, orcaRpc, withOrcaNativeChat } from "./orcaNativeChat.js";
import type { OrcaClient } from "./orcaClient.js";

const thread = "01a1a8eb-64f2-7802-8601-9efa8dab6041";
const chat = { sessionId: "codex_chat", threadId: thread, title: "Test", host: "local", workspace: "/work", kind: "native", reconciling: 0, handoff: null, profile: "/profile" };
const history = { ok: true, page: { sessionId: chat.sessionId, fence: 2, working: true, actionablePromptIds: [] as string[],
  items: [{ body: { kind: "message", role: "assistant", blocks: [{ type: "text", text: "Working" }] } }],
} };
function setup() {
  const cli: OrcaClient = { show: vi.fn(), list: vi.fn(), screen: vi.fn(), send: vi.fn(), resolveSession: vi.fn().mockResolvedValue(null) };
  const find = vi.fn().mockResolvedValue(chat);
  const rpc = vi.fn(async (_profile: string, method: string, _params: unknown, _runtime?: string) => ({ runtimeId: "runtime", result:
    method === "agentSession.history" ? history : method === "agentSession.handoffStatus" ? { owner: "native", phase: "idle" } : { ok: true, value: { dispatchState: "pending" } },
  }));
  return { cli, find, rpc, client: withOrcaNativeChat(cli, find, rpc) };
}
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Orca native chat routing", () => {
  it("routes a linked native chat through its host instead of a stale CLI or another app-server", async () => {
    const { client, rpc, cli } = setup();
    const target = (await client.resolveSession!("codex", thread))!;
    expect(target.handle).toBe("orca-chat:codex_chat");
    expect(await client.show(target.handle)).toEqual(target);
    expect(await client.screen(target, true)).toBe("assistant: Working");
    expect(await client.send(target, "literal $(not a shell)\nanswer")).toEqual({ accepted: true, turnStarted: false });
    expect(cli.resolveSession).not.toHaveBeenCalled(); expect(cli.send).not.toHaveBeenCalled();
    const [, method, params, runtime] = rpc.mock.calls.at(-1)!;
    expect(method).toBe("agentSession.send"); expect(runtime).toBe("runtime");
    expect(params).toMatchObject({ body: { blocks: [{ text: "literal $(not a shell)\nanswer" }] }, delivery: "queue-if-active", envelope: { sessionId: chat.sessionId, expectedRuntimeFence: 2 } });
    const p = params as any;
    expect(p.envelope.payloadFingerprint).toBe(orcaFingerprint({ method, sessionId: chat.sessionId, fields: { body: p.body, delivery: p.delivery } }));
    expect(p.envelope.clientOperationId).toMatch(/^\d{13}-[a-f0-9]{32}$/);
  });
  it("keeps existing CLI routing for sessions without a native chat", async () => {
    const { client, find, cli } = setup(); find.mockResolvedValue(null);
    expect(await client.resolveSession!("codex", thread)).toBeNull();
    expect(cli.resolveSession).toHaveBeenCalledWith("codex", thread);
  });
  it("does not fall through on a native ownership/read failure", async () => {
    const { client, rpc, cli } = setup(); rpc.mockRejectedValue(new Error("offline"));
    await expect(client.resolveSession!("codex", thread)).rejects.toThrow("offline");
    expect(cli.resolveSession).not.toHaveBeenCalled();
  });
  it("refuses another provider session and owner transfer", async () => {
    const { client, rpc } = setup();
    rpc.mockResolvedValueOnce({ runtimeId: "runtime", result: { ...history, page: { ...history.page, sessionId: "different" } } });
    await expect(client.resolveSession!("codex", thread)).rejects.toThrow("another chat");
    rpc.mockImplementation(async () => ({ runtimeId: "runtime", result: history }));
    await expect(client.resolveSession!("codex", thread)).rejects.toThrow("changing owners");
  });
  it("refuses changed ownership before sending and leaves local prompts alone", async () => {
    const { client, find, rpc } = setup();
    const target = (await client.resolveSession!("codex", thread))!;
    rpc.mockResolvedValueOnce({ runtimeId: "runtime", result: { ...history, page: { ...history.page, actionablePromptIds: ["approval"] } } });
    await expect(client.screen(target, true)).rejects.toThrow("approval");
    find.mockResolvedValue({ ...chat, sessionId: "other" });
    await expect(client.send(target, "hello")).rejects.toThrow("ownership changed");
    expect(rpc.mock.calls.some(([, method]) => method === "agentSession.send")).toBe(false);
  });
  it("reports a refused send and never resends an ambiguous one", async () => {
    const { client, rpc } = setup(); const target = (await client.resolveSession!("codex", thread))!;
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (...args) => args[1] === "agentSession.send" ? { runtimeId: "runtime", result: { ok: false } as any } : original(...args));
    expect(await client.send(target, "hello")).toEqual({ accepted: false, turnStarted: false });
    rpc.mockImplementation(async (...args) => { if (args[1] === "agentSession.send") throw new Error("timeout"); return original(...args); });
    await expect(client.send(target, "hello")).rejects.toThrow("timeout");
    expect(rpc.mock.calls.filter(([, method]) => method === "agentSession.send")).toHaveLength(2);
  });
  it("discovers current proven handles only, and refuses duplicates across profiles", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const root = await mkdtemp(path.join(os.tmpdir(), "orca-native-")); roots.push(root);
    const db = new DatabaseSync(path.join(root, "agent-session-journal.db"));
    db.exec("create table agent_session_records(session_id TEXT PRIMARY KEY, record_json TEXT)");
    const record = { provider: "codex", conversationName: "Test", location: { executionHostId: "local", workspaceId: "/work" },
      lease: { provenHandleLinkId: "current", runtimeKind: "native", unreconciled: false, handoffStage: null },
      providerHandleChain: [{ linkId: "old", handle: { threadId: "01a11111-1111-7111-8111-111111111111" } }, { linkId: "current", handle: { threadId: thread } }],
    };
    db.prepare("insert into agent_session_records values(?,?)").run(chat.sessionId, JSON.stringify(record));
    expect(await findNativeChat(thread, [root])).toEqual({ ...chat, profile: root });
    expect(await findNativeChat("01a11111-1111-7111-8111-111111111111", [root])).toBeNull();
    record.lease.runtimeKind = "terminal";
    db.prepare("update agent_session_records set record_json=?").run(JSON.stringify(record));
    expect(await findNativeChat(thread, [root])).toBeNull();
    record.lease.runtimeKind = "native";
    db.prepare("update agent_session_records set record_json=?").run(JSON.stringify(record));
    db.prepare("insert into agent_session_records values(?,?)").run("duplicate", JSON.stringify(record)); db.close();
    await expect(findNativeChat(thread, [root])).rejects.toThrow("Multiple");
  });
  it("uses explicit profiles and the generated Linux profile without executing a screen reader", () => {
    expect(orcaProfiles({}, "linux", "/home/member")).toEqual(["/home/member/.orca", "/home/member/.config/orca"]);
    expect(orcaProfiles({ CONNECT_ORCA_USER_DATA_PATH: "/custom" }, "linux", "/home/member")).toEqual(["/custom"]);
  });
});

describe("Orca runtime transport", () => {
  async function serve(response: (frame: any) => unknown) {
    const root = await mkdtemp(path.join(os.tmpdir(), "orpc-")); roots.push(root);
    const endpoint = path.join(root, "s");
    await writeFile(path.join(root, "orca-runtime.json"), JSON.stringify({ runtimeId: "runtime", authToken: "test-secret", transports: [{ kind: "unix", endpoint }] }));
    const seen: any[] = [];
    const server = createServer(socket => { socket.setEncoding("utf8"); let text = "";
      socket.on("data", chunk => { text += chunk; if (!text.includes("\n")) return;
        const frame = JSON.parse(text.trim()); seen.push(frame); socket.end(JSON.stringify(response(frame)) + "\n");
      });
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(endpoint, resolve)); return { root, seen };
  }
  it("authenticates locally and checks the runtime before writing", async () => {
    const { root, seen } = await serve(frame => ({ id: frame.id, ok: true, result: { status: "ok" }, _meta: { runtimeId: "runtime" } }));
    expect(await orcaRpc(root, "status.get", {}, "runtime")).toEqual({ result: { status: "ok" }, runtimeId: "runtime" });
    expect(seen[0]).toMatchObject({ authToken: "test-secret", method: "status.get" });
    await expect(orcaRpc(root, "agentSession.send", {}, "old-runtime")).rejects.toThrow("restarted");
    expect(seen).toHaveLength(1);
  });
  it("rejects wrong runtimes and does not expose server prompt/credential errors", async () => {
    const wrong = await serve(frame => ({ id: frame.id, ok: true, result: {}, _meta: { runtimeId: "other" } }));
    await expect(orcaRpc(wrong.root, "status.get", {})).rejects.toThrow("Unsupported");
    const failed = await serve(frame => ({ id: frame.id, ok: false, error: { message: "private prompt test-secret" }, _meta: { runtimeId: "runtime" } }));
    await expect(orcaRpc(failed.root, "status.get", {})).rejects.toThrow(/^Orca refused the chat request/);
    expect(failed.seen).toHaveLength(1);
  });
});
