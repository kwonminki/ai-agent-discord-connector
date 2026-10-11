import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectSyncStateStore, type SyncedSessionChannelState } from "./directState.js";
import { syncSubagentThreads, subagentRoot } from "./subagentThreads.js";
import type { DiscoveredCodexSession } from "../../../packages/codex-adapter/src/index.js";
import { notifyCodexTaskCompletions } from "./codexTaskNotifications.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const rootChannel: SyncedSessionChannelState = { codexSessionId: "root", threadName: "Main task", updatedAt: new Date().toISOString(), cwd: "/repo", workspaceRoot: "/repo", workspaceDisplayName: "repo", discordCategoryId: null, discordChannelId: "parent", discordParentChannelId: "admin", discordDeliveryMode: "thread", channelName: "Main task", computerId: "computer", workspaceId: "workspace" };
const child = (id: string, source: "codex" | "orca" = "codex"): DiscoveredCodexSession => ({ id, threadName: "Report task outcome", updatedAt: new Date().toISOString(), cwdHint: "/repo", subagent: { source, parentSessionId: "root", name: "Review database", agentPath: source === "codex" ? "/root/review" : undefined } });
async function setup(old?: SyncedSessionChannelState) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "subagents-")); roots.push(dir);
  const stateStore = createDirectSyncStateStore(path.join(dir, "state.json"));
  await stateStore.update(state => ({ ...state, sessionChannels: [rootChannel, ...(old ? [old] : [])] }));
  let id = 0;
  const guild = { createCategory: vi.fn(), createTextChannel: vi.fn(), createThread: vi.fn(async () => ({ id: `thread-${++id}` })), findThreadByName: vi.fn(async () => null),
    ensureSubagentContainer: vi.fn(async () => ({ id: "quiet" })), archiveThread: vi.fn(), addThreadMember: vi.fn(), threadOperatorIds: vi.fn(async () => ["operator-user"]), sendTextMessage: vi.fn(async (_channel: string, _content: unknown, _options?: unknown) => ({ id: "message" })) };
  const controlApi = { createCategoryMapping: vi.fn(), createManagedChannel: vi.fn(), linkCodexSession: vi.fn() };
  return { guild, controlApi, stateStore, adminChannelId: "admin", computerId: "computer", computerDisplayName: "Computer", defaultWorkspaceRoot: "/repo", mentionRoleIds: ["operator-role"] };
}
describe("subagent thread grouping", () => {
  it("groups native and Orca children, mentions only the index, and survives polls/restarts", async () => {
    const input = await setup();
    const sessions = [child("native"), child("orca", "orca")];
    await Promise.all([syncSubagentThreads({ ...input, sessions }), syncSubagentThreads({ ...input, sessions })]);
    expect(input.guild.createThread).toHaveBeenCalledTimes(3);
    expect(input.guild.addThreadMember.mock.calls).toEqual([["thread-1", "operator-user"]]);
    const state = await input.stateStore.read();
    expect(state.sessionChannels.filter(row => row.subagent)).toHaveLength(2);
    expect(state.sessionChannels.find(row => row.codexSessionId === "native")).toMatchObject({ discordParentChannelId: "quiet", channelName: expect.stringContaining("review · Review database") });
    for (const [channel, message, options] of input.guild.sendTextMessage.mock.calls as unknown as Array<[string, { allowedMentions: { users?: string[] } }, unknown]>) {
      if (channel !== "thread-1") { expect(message.allowedMentions.users).toEqual([]); expect(options).toBeUndefined(); }
    }
    input.guild.sendTextMessage.mockClear();
    await syncSubagentThreads({ ...input, stateStore: createDirectSyncStateStore(path.join(roots.at(-1)!, "state.json")), sessions: [...sessions, child("later")] });
    expect(input.guild.createThread).toHaveBeenCalledTimes(4);
    expect(input.guild.sendTextMessage.mock.calls.filter(call => call[0] === "thread-1")).toHaveLength(1);
    expect(input.guild.threadOperatorIds).toHaveBeenCalledTimes(1);
  });
  it("moves an old flat binding while preserving its history and redirect", async () => {
    const input = await setup({ ...rootChannel, codexSessionId: "worker", discordChannelId: "old-worker", lastTranscriptMessageKey: "already-seen" });
    await syncSubagentThreads({ ...input, sessions: [child("worker", "orca")] });
    const state = await input.stateStore.read();
    expect(state.sessionChannels.find(row => row.discordChannelId === "old-worker")).toMatchObject({ codexSessionId: null, channelPurpose: "subagent-redirect", redirectChannelId: "thread-2", redirectPostedAt: expect.any(String) });
    expect(state.sessionChannels.find(row => row.codexSessionId === "worker")).toMatchObject({ lastTranscriptMessageKey: "already-seen" });
    expect(input.guild.archiveThread).toHaveBeenCalledWith("old-worker");
  });
  it("retries an announcement without duplicating channels or initial mention", async () => {
    const input = await setup();
    input.guild.sendTextMessage.mockImplementationOnce(async () => ({ id: "intro" })).mockImplementationOnce(async () => ({ id: "context" })).mockRejectedValueOnce(new Error("offline"));
    await expect(syncSubagentThreads({ ...input, sessions: [child("worker")] })).rejects.toThrow("offline");
    await syncSubagentThreads({ ...input, sessions: [child("worker")] });
    expect(input.guild.createThread).toHaveBeenCalledTimes(2);
    expect(input.guild.threadOperatorIds).toHaveBeenCalledTimes(1);
  });
  it("does not group ordinary forks, cycles, or orphaned old sessions", async () => {
    const input = await setup();
    const a = child("a"), b = child("b"); a.subagent!.parentSessionId = "b"; b.subagent!.parentSessionId = "a";
    expect(subagentRoot("a", new Map([["a", a], ["b", b]]))).toBeNull();
    await syncSubagentThreads({ ...input, sessions: [a, b, { ...child("fork"), subagent: undefined, forkedFromId: "root" }] });
    expect(input.guild.createThread).not.toHaveBeenCalled();
  });
  it("never mentions child completions or leaks an ungrouped child into the admin channel", async () => {
    const input = await setup();
    const session = child("worker");
    await syncSubagentThreads({ ...input, sessions: [session] });
    await notifyCodexTaskCompletions({ ...input, sessions: [session] });
    input.guild.sendTextMessage.mockClear();
    await notifyCodexTaskCompletions({ ...input, sessions: [{ ...session, realtimeEvents: [{ key: "done", kind: "status", text: "작업 완료" }], contextPreview: [{ role: "assistant", text: "Done" }] }, { ...child("unknown"), realtimeEvents: [{ key: "done", kind: "status", text: "작업 완료" }] }] });
    expect(input.guild.sendTextMessage).toHaveBeenCalled();
    for (const [id, , options] of input.guild.sendTextMessage.mock.calls as unknown as Array<[string, unknown, unknown]>) { expect(id).toBe("thread-2"); expect(options).toBeUndefined(); }
  });
});
