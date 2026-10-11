import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopSessionBridge } from "./desktopSessionBridge.js";
import { createDiscordMessageHandler, type DiscordMessageLike, type ManagedDiscordChannelContext } from "./messageHandler.js";

const context: ManagedDiscordChannelContext = { channelMode: "session-linked", allowedRoleIds: ["operator"], computerId: "host", computerDisplayName: "Host", workspaceDisplayName: "Work", workspaceRoot: "/work", cwd: "/work", timeoutMs: 3000, codexSessionId: "session" };
const message = (content = "continue", extra: Partial<DiscordMessageLike> = {}): DiscordMessageLike => ({ content, authorBot: false, userId: "user", channelId: "channel", roleIds: ["operator"], messageId: "id", reply: vi.fn().mockResolvedValue(undefined), ...extra });
let root: string, file: string;
let session: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let client: { open: ReturnType<typeof vi.fn> };
let bridge: ReturnType<typeof createDesktopSessionBridge>;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "desktop-bridge-")); file = path.join(root, "deliveries.json"); session = { send: vi.fn().mockResolvedValue("steered"), close: vi.fn() }; client = { open: vi.fn().mockResolvedValue(session) }; bridge = createDesktopSessionBridge({ client, file, locale: "en" }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const idle = () => false;

describe("Discord replies to app-owned conversations", () => {
  it("routes ordinary replies to the same app session without a worker or a fork", async () => {
    const submitCodexPrompt = vi.fn(), submitCommandJob = vi.fn();
    const handler = createDiscordMessageHandler({ desktopBridge: bridge, resolveChannelContext: async () => context, submitCodexPrompt, submitCommandJob, updateChannelCwd: vi.fn(), recordCommandAudit: vi.fn() });
    await handler(message());
    expect(client.open).toHaveBeenCalledWith("session"); expect(session.send).toHaveBeenCalledExactlyOnceWith("continue", "id"); expect(session.close).toHaveBeenCalledOnce();
    expect(submitCodexPrompt).not.toHaveBeenCalled(); expect(submitCommandJob).not.toHaveBeenCalled();
  });
  it("preserves an explicit Orca route", async () => {
    const handler = createDiscordMessageHandler({ desktopBridge: bridge, orcaBridge: { handle: vi.fn().mockResolvedValue(true) }, resolveChannelContext: async () => context, submitCodexPrompt: vi.fn(), submitCommandJob: vi.fn(), updateChannelCwd: vi.fn(), recordCommandAudit: vi.fn() });
    await handler(message()); expect(client.open).not.toHaveBeenCalled();
  });
  it("keeps connector commands, unauthorized users, bot relays and restored jobs out", async () => {
    for (const extra of [{ connectorCommand: true }, { roleIds: [] }, { authorBot: true }, { relayRequest: true }, { restoreOnly: true }, { durableQueuedAt: "old" }]) expect(await bridge.handle(message("continue", extra), context, idle)).toBe(false);
    expect(await bridge.handle(message("/fork"), context, idle)).toBe(false);
    expect(await bridge.handle(message(), { ...context, channelMode: "shell-admin" }, idle)).toBe(false);
    expect(await bridge.handle(message(), context, () => true)).toBe(false); expect(client.open).not.toHaveBeenCalled();
  });
  it("uses existing routing when the app does not own the session", async () => {
    client.open.mockResolvedValue(null); expect(await bridge.handle(message(), context, idle)).toBe(false); expect(session.send).not.toHaveBeenCalled();
  });
  it("writes before delivery and deduplicates across restarts even after the app closes", async () => {
    session.send.mockImplementation(async () => { expect(JSON.parse(await readFile(file, "utf8")).receipts["channel:id"].status).toBe("pending"); return "started"; });
    await Promise.all([bridge.handle(message(), context, idle), bridge.handle(message(), context, idle)]);
    client.open.mockResolvedValue(null);
    const restarted = createDesktopSessionBridge({ client, file, locale: "en" }); expect(await restarted.handle(message(), context, idle)).toBe(true);
    expect(session.send).toHaveBeenCalledOnce(); expect(client.open).toHaveBeenCalledOnce();
    expect(await readFile(file, "utf8")).not.toContain("continue");
  });
  it("never retries an uncertain send or falls through to another writer", async () => {
    session.send.mockRejectedValue(new Error("transport timeout with private input"));
    const msg = message(); expect(await bridge.handle(msg, context, idle)).toBe(true);
    expect(JSON.stringify(vi.mocked(msg.reply).mock.calls)).toContain("unconfirmed"); expect(JSON.stringify(vi.mocked(msg.reply).mock.calls)).not.toContain("private input");
    expect(JSON.parse(await readFile(file, "utf8")).receipts["channel:id"].status).toBe("unknown");
    const restarted = createDesktopSessionBridge({ client, file }); await restarted.handle(message(), context, idle); expect(session.send).toHaveBeenCalledOnce();
  });
  it("stops on attachment or missing ID and closes the connection", async () => {
    for (const extra of [{ messageId: undefined }, { attachments: [{}] as any }]) expect(await bridge.handle(message("answer", extra), context, idle)).toBe(true);
    expect(session.send).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalledTimes(2);
  });
  it("fails closed on damaged receipts and app connection errors", async () => {
    await writeFile(file, "broken"); expect(await bridge.handle(message(), context, idle)).toBe(true); expect(client.open).not.toHaveBeenCalled();
    await rm(file); client.open.mockRejectedValue(new Error("Desktop unavailable")); expect(await bridge.handle(message(), context, idle)).toBe(true); expect(session.send).not.toHaveBeenCalled();
  });
  it("blocks jobs that become busy while discovering the app", async () => {
    const busy = vi.fn().mockReturnValueOnce(false).mockReturnValue(true); expect(await bridge.handle(message(), context, busy)).toBe(true); expect(session.send).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalledOnce();
  });
});
