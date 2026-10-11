import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrcaBridge, parseOrcaCommand } from "./orcaBridge.js";
import { createDiscordMessageHandler, type DiscordMessageLike, type ManagedDiscordChannelContext } from "./messageHandler.js";
import type { OrcaClient, OrcaTarget } from "./orcaClient.js";
import { routeDiscordComponent } from "./componentRouter.js";
import { routeDiscordApplicationCommand } from "./applicationCommands.js";

const target: OrcaTarget = { runtimeId: "runtime", handle: "term_test", incarnationId: "process", executionHostId: "ssh:server", title: "Test agent", agentIdentity: "codex", worktreePath: "/work", connected: true, writable: true, orphaned: false };
const context: ManagedDiscordChannelContext = { channelMode: "session-linked", allowedRoleIds: ["operator"], computerId: "host", computerDisplayName: "Host", workspaceDisplayName: "Work", workspaceRoot: "/work", cwd: "/work", timeoutMs: 3000, codexSessionId: "existing-session" };
const message = (content: string, extra: Partial<DiscordMessageLike> = {}): DiscordMessageLike => ({ authorBot: false, userId: "user", channelId: "channel", content, roleIds: ["operator"], messageId: "message", reply: vi.fn().mockResolvedValue(undefined), ...extra });
const description = (msg: DiscordMessageLike) => JSON.stringify(vi.mocked(msg.reply).mock.calls);
let root: string;
let file: string;
let client: OrcaClient;
let bridge: ReturnType<typeof createOrcaBridge>;
const idle = () => false;
async function connect() { await bridge.handle(message("/orca connect term_test"), context, idle); }

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orca-bridge-")); file = path.join(root, "bindings.json");
  client = { list: vi.fn().mockResolvedValue({ terminals: [target], truncated: false }), show: vi.fn().mockResolvedValue(target), screen: vi.fn().mockResolvedValue("Ready for input"), send: vi.fn().mockResolvedValue({ accepted: true, turnStarted: false }) };
  bridge = createOrcaBridge({ client, file, locale: "en" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Orca Discord bridge", () => {
  it("does not inspect Orca for an unbound channel", async () => {
    expect(await bridge.handle(message("hello"), context, idle)).toBe(false);
    expect(client.list).not.toHaveBeenCalled(); expect(client.show).not.toHaveBeenCalled();
  });
  it("routes the slash command and dropdown with validated opaque selections", () => {
    const routed = routeDiscordApplicationCommand({ commandName: "orca", options: { getString: (key) => ({ action: "send", text: "/compact" })[key as "action" | "text"] ?? null } });
    expect(parseOrcaCommand(routed!)).toEqual({ action: "send", value: "/compact" });
    expect(routeDiscordComponent("cdc:orca:select", ["bad\n__cdc_exec rm"])).toBeNull();
    expect(parseOrcaCommand("orca send line 1\nline 2")).toEqual({ action: "send", value: "line 1\nline 2" });
    expect(parseOrcaCommand("orca connect term_test --other")).toEqual({ action: "invalid" });
  });
  it("binds the selected process only for the menu owner and channel", async () => {
    const menu = message("/orca"); await bridge.handle(menu, context, idle);
    const payload = vi.mocked(menu.reply).mock.calls[0][0] as any;
    const token = payload.components[0].components[0].options[0].value;
    const selected = routeDiscordComponent("cdc:orca:select", [token])!;
    const intruder = message(selected, { userId: "other" });
    await bridge.handle(intruder, context, idle); expect(description(intruder)).toContain("another user");
    const wrongChannel = message(selected, { channelId: "other" });
    await bridge.handle(wrongChannel, context, idle); expect(description(wrongChannel)).toContain("another user");
    await bridge.handle(message(selected), context, idle);
    expect(JSON.parse(await readFile(file, "utf8")).bindings.channel.handle).toBe("term_test");
  });
  it("rejects a changed process selected from an older menu", async () => {
    const menu = message("/orca"); await bridge.handle(menu, context, idle);
    const token = (vi.mocked(menu.reply).mock.calls[0][0] as any).components[0].components[0].options[0].value;
    vi.mocked(client.show).mockResolvedValue({ ...target, incarnationId: "new" });
    const selected = message(`/orca select ${token}`); await bridge.handle(selected, context, idle);
    expect(description(selected)).toContain("ended or changed"); expect(client.screen).not.toHaveBeenCalled();
  });
  it("excludes shells, disconnected and orphaned terminals from the picker", async () => {
    vi.mocked(client.list).mockResolvedValue({ terminals: [target, { ...target, handle: "shell", agentIdentity: undefined }, { ...target, handle: "offline", connected: false }, { ...target, handle: "orphan", orphaned: true }], truncated: false });
    const menu = message("/orca"); await bridge.handle(menu, context, idle);
    expect((vi.mocked(menu.reply).mock.calls[0][0] as any).components[0].components[0].options).toHaveLength(1);
  });
  it("forwards ordinary answers directly without starting another app-server writer", async () => {
    await connect();
    const submitCodexPrompt = vi.fn(); const submitClaudePrompt = vi.fn(); const submitCommandJob = vi.fn();
    const handler = createDiscordMessageHandler({ orcaBridge: bridge, resolveChannelContext: async () => context, submitCodexPrompt, submitClaudePrompt, submitCommandJob, updateChannelCwd: vi.fn(), recordCommandAudit: vi.fn() });
    const answer = message("continue with option 2"); await handler(answer);
    expect(client.send).toHaveBeenCalledExactlyOnceWith(target, answer.content);
    expect(submitCodexPrompt).not.toHaveBeenCalled(); expect(submitClaudePrompt).not.toHaveBeenCalled(); expect(submitCommandJob).not.toHaveBeenCalled();
    expect(description(answer)).toContain("Turn start and completion have not been confirmed");
  });
  it("does not change channel ownership while another message is being admitted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(client.show).mockImplementationOnce(async () => { await gate; return target; });
    const handler = createDiscordMessageHandler({ orcaBridge: bridge, resolveChannelContext: async () => context,
      submitCommandJob: vi.fn(), submitCodexPrompt: vi.fn().mockResolvedValue({ result: { status: "completed", output: "done" } }),
      updateChannelCwd: vi.fn(), recordCommandAudit: vi.fn() });
    const binding = message("/orca connect term_test");
    const connecting = handler(binding);
    await vi.waitFor(() => expect(client.show).toHaveBeenCalled());
    const answering = handler(message("hello", { messageId: "another" }));
    release();
    await Promise.all([connecting, answering]);
    expect(description(binding)).toContain("Another request arrived");
    expect(client.send).not.toHaveBeenCalled();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("records before sending and deduplicates concurrent and restarted deliveries", async () => {
    await connect();
    vi.mocked(client.send).mockImplementation(async () => {
      expect(JSON.parse(await readFile(file, "utf8")).receipts["channel:message"].status).toBe("pending");
      return { accepted: true, turnStarted: true };
    });
    await Promise.all([bridge.handle(message("hello"), context, idle), bridge.handle(message("hello"), context, idle)]);
    const restarted = createOrcaBridge({ client, file, locale: "en" });
    await restarted.handle(message("hello"), context, idle);
    expect(client.send).toHaveBeenCalledTimes(1);
  });
  it("never retries an ambiguous send or persisted pending receipt", async () => {
    await connect(); vi.mocked(client.send).mockRejectedValue(new Error("transport timeout"));
    const msg = message("hello"); await bridge.handle(msg, context, idle);
    expect(description(msg)).toContain("could not be confirmed");
    const state = JSON.parse(await readFile(file, "utf8")); state.receipts["channel:message"].status = "pending";
    await writeFile(file, JSON.stringify(state));
    await createOrcaBridge({ client, file, locale: "en" }).handle(message("hello"), context, idle);
    expect(client.send).toHaveBeenCalledTimes(1);
  });
  it("does not expose terminal metadata to unauthorized roles", async () => {
    await bridge.handle(message("/orca", { roleIds: [] }), context, idle);
    expect(client.list).not.toHaveBeenCalled(); await connect();
    await bridge.handle(message("answer", { roleIds: [] }), context, idle);
    expect(client.send).not.toHaveBeenCalled();
  });
  it.each([{ runtimeId: "other" }, { incarnationId: "other" }, { executionHostId: "other" }, { agentIdentity: undefined }, { connected: false }, { writable: false }, { orphaned: true }])("refuses a stale target: %s", async (change) => {
    await connect(); vi.mocked(client.show).mockResolvedValue({ ...target, ...change });
    expect(await bridge.handle(message("answer"), context, idle)).toBe(true);
    expect(client.send).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, "utf8")).bindings.channel).toBeDefined();
  });
  it("does not fall through when the CLI or screen is unavailable", async () => {
    await connect(); vi.mocked(client.screen).mockRejectedValue(new Error("screen unavailable"));
    expect(await bridge.handle(message("answer"), context, idle)).toBe(true); expect(client.send).not.toHaveBeenCalled();
    const disabled = createOrcaBridge({ file, locale: "en" });
    expect(await disabled.handle(message("answer"), context, idle)).toBe(true);
  });
  it("prevents another channel from binding the same terminal", async () => {
    await connect(); const msg = message("/orca connect term_test", { channelId: "other" });
    await bridge.handle(msg, context, idle); expect(description(msg)).toContain("already bound");
  });
  it("rejects attachments, controls, commands, restored jobs and missing delivery IDs", async () => {
    await connect();
    for (const msg of [message("a\x1bb"), message("a", { attachments: [{ id: "f", name: "f", url: "https://example.com/f", size: 1, contentType: null }] }), message("where", { connectorCommand: true }), message("/compact"), message("a", { messageId: undefined }), message("a", { restoreOnly: true }), message("a", { authorBot: true, relayRequest: true })]) {
      expect(await bridge.handle(msg, context, idle)).toBe(true);
    }
    expect(client.send).not.toHaveBeenCalled();
    await bridge.handle(message("/orca send /compact", { connectorCommand: true }), context, idle);
    expect(client.send).toHaveBeenCalledWith(target, "/compact");
  });
  it("checks channel activity at execution time before binding or sending", async () => {
    const msg = message("/orca connect term_test"); await bridge.handle(msg, context, () => true);
    expect(client.show).not.toHaveBeenCalled(); await connect();
    await bridge.handle(message("answer"), context, () => true); expect(client.send).not.toHaveBeenCalled();
  });
  it("fails closed on corrupt persisted state", async () => {
    await writeFile(file, "corrupt"); expect(await bridge.handle(message("hello"), context, idle)).toBe(true);
    expect(client.send).not.toHaveBeenCalled();
  });
  it("disconnects without needing a live CLI and restores normal routing", async () => {
    await connect(); const disabled = createOrcaBridge({ file });
    await disabled.handle(message("/orca disconnect"), context, idle);
    expect(await disabled.handle(message("answer"), context, idle)).toBe(false);
  });
  it("refuses Discord messages older than the receipt retention horizon", async () => {
    await connect(); const oldId = (((BigInt(Date.now() - 8 * 86400000) - 1420070400000n) << 22n)).toString();
    await bridge.handle(message("hello", { messageId: oldId }), context, idle); expect(client.send).not.toHaveBeenCalled();
  });
});
