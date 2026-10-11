import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverCodexSessions } from "../../../packages/codex-adapter/src/index.js";
import { createDirectSyncStateStore } from "./directState.js";
import { syncCodexSessionTranscriptUpdates } from "./codexTranscriptSync.js";
import { TRANSCRIPT_PROGRESS_STALE_MS } from "./codexTranscriptProgress.js";
import { notifyCodexTaskCompletions } from "./codexTaskNotifications.js";

const sessionId = "019dbcc5-5d37-7662-9b8e-d9f1eb824fc2";
const initialTime = Date.parse("2026-10-11T23:00:00Z");
let root: string, rollout: string, statePath: string, now: number;
let stateStore: ReturnType<typeof createDirectSyncStateStore>;
let guild: { sendTextMessage: ReturnType<typeof vi.fn>; editTextMessage: ReturnType<typeof vi.fn> };
const event = (type: string, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const message = (phase: string, text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] } });
async function append(...events: object[]) {
  await appendFile(rollout, events.map(e => JSON.stringify({ timestamp: new Date(now).toISOString(), ...e })).join("\n") + "\n");
}
async function sync(options: { ignoredSessionIds?: string[]; postUpdates?: boolean } = {}) {
  const sessions = await discoverCodexSessions(root, { includeRealtimeEvents: true, includeContextPreview: true, contextMessageMaxChars: 8000, realtimeEventLimit: 200 });
  return syncCodexSessionTranscriptUpdates({ guild, stateStore, sessions, trigger: "realtime", now: () => now, ...options });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "transcript-progress-"));
  statePath = path.join(root, "state.json");
  now = initialTime;
  rollout = path.join(root, "sessions", "2026", "10", "11", `rollout-${sessionId}.jsonl`);
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: "Existing work", updated_at: new Date(now).toISOString() }) + "\n");
  await append({ type: "session_meta", payload: { id: sessionId, cwd: "/repo", source: "cli" } }, message("final_answer", "Old answer"));
  stateStore = createDirectSyncStateStore(statePath);
  await stateStore.write({ version: 1, transcriptSyncMode: "realtime", archivedCodexSessionIds: [], workspaces: [], sessionChannels: [{
    codexSessionId: sessionId, threadName: "Existing work", updatedAt: new Date(now).toISOString(), cwd: "/repo", workspaceRoot: "/repo", workspaceDisplayName: "repo", discordCategoryId: null, discordChannelId: "channel", channelName: "work", computerId: "local", workspaceId: "local:/repo",
    agentModelOverride: "gpt-6-astra", agentEffortOverride: "xhigh",
  }] });
  guild = { sendTextMessage: vi.fn().mockImplementation(async () => ({ id: `sent-${guild.sendTextMessage.mock.calls.length}` })), editTextMessage: vi.fn().mockResolvedValue(undefined) };
  await sync();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("public progress for existing Desktop and Orca Codex sessions", () => {
  it("flushes pending public updates before the completion notification and delivers the final answer once", async () => {
    const notify = async () => notifyCodexTaskCompletions({ guild, stateStore, adminChannelId: "admin", sessions: await discoverCodexSessions(root, { includeRealtimeEvents: true, includeContextPreview: true }) });
    await notify();
    await append(event("task_started")); await sync();
    await append(message("commentary", "Check complete"), message("final_answer", "Unique final answer"), event("task_complete", { last_agent_message: "Unique final answer" }));
    // Let the completion timer win the race with the normal transcript timer.
    await notify();
    expect(guild.sendTextMessage.mock.calls[1]).toEqual(["channel", "Check complete"]);
    expect(JSON.stringify(guild.sendTextMessage.mock.calls[2])).toContain("Unique final answer");
    const count = guild.sendTextMessage.mock.calls.length;
    await sync(); await notify();
    expect(guild.sendTextMessage).toHaveBeenCalledTimes(count);
  });
  it("shows thinking, public commentary, and edits the same card on completion without a second final answer", async () => {
    await append(event("task_started"));
    await sync();
    expect(guild.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(guild.sendTextMessage.mock.calls)).toContain("생각 중");
    await append(message("commentary", "파일을 확인하고 있습니다."));
    await sync();
    expect(guild.sendTextMessage).toHaveBeenLastCalledWith("channel", "파일을 확인하고 있습니다.");
    await append(message("final_answer", "The actual final answer"), event("task_complete", { last_agent_message: "The actual final answer" }));
    await sync();
    expect(guild.editTextMessage).toHaveBeenCalledWith("channel", "sent-1", expect.objectContaining({ allowedMentions: { parse: [] }, embeds: [expect.objectContaining({ description: "✅ 작업 완료" })] }));
    expect(guild.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(guild.sendTextMessage.mock.calls)).not.toContain("The actual final answer");
    expect(await stateStore.findSessionChannelByDiscordId("channel")).toMatchObject({ codexSessionId: sessionId, cwd: "/repo", agentModelOverride: "gpt-6-astra", agentEffortOverride: "xhigh" });
  });

  it("reuses the persisted card and cursor after restart, then starts a new card for the next app/terminal turn", async () => {
    await append(event("task_started"), message("commentary", "First update"));
    await sync();
    stateStore = createDirectSyncStateStore(statePath);
    await Promise.all([sync(), sync()]);
    expect(guild.sendTextMessage).toHaveBeenCalledTimes(2);
    await append(event("turn_aborted"));
    await sync();
    expect(JSON.stringify(guild.editTextMessage.mock.calls)).toContain("작업 중단");
    now += 1000;
    await append(event("task_started"), message("commentary", "Continued in the original app"));
    await Promise.all([sync(), sync()]);
    expect(guild.sendTextMessage).toHaveBeenCalledTimes(4);
    expect(await stateStore.findSessionChannelByDiscordId("channel")).toMatchObject({ codexSessionId: sessionId, transcriptProgress: { status: "running", messageId: "sent-3" } });
  });

  it("ends the indicator for an empty completion without reusing a previous answer", async () => {
    await append(event("task_started")); await sync();
    await append(event("task_complete", { last_agent_message: "" })); await sync();
    expect(JSON.stringify(guild.editTextMessage.mock.calls)).toContain("작업 종료");
    expect(guild.sendTextMessage).toHaveBeenCalledTimes(1);
    const sessions = await discoverCodexSessions(root, { includeRealtimeEvents: true });
    expect(sessions[0].realtimeEvents?.at(-1)).toMatchObject({ text: "작업 종료", turnStatus: "completed" });
  });

  it("marks a silent/crashed session as uncertain and resumes its card when activity returns", async () => {
    await append(event("task_started")); await sync();
    now += TRANSCRIPT_PROGRESS_STALE_MS + 1;
    await sync();
    expect(JSON.stringify(guild.editTextMessage.mock.calls)).toContain("상태 확인 지연");
    await append(message("commentary", "Still working")); await sync();
    expect(guild.editTextMessage.mock.calls.at(-1)?.[2].embeds[0].description).toContain("생각 중");
    expect(await stateStore.findSessionChannelByDiscordId("channel")).toMatchObject({ transcriptProgress: { status: "running", messageId: "sent-1" } });
  });

  it("splits long public updates in order and excludes private reasoning and tool bodies", async () => {
    const long = "Progress details ".repeat(280);
    await append(event("task_started"), { type: "response_item", payload: { type: "reasoning", content: [{ text: "PRIVATE REASONING" }] } }, { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "echo PRIVATE TOOL" }) } }, message("commentary", long));
    await sync();
    const chunks = guild.sendTextMessage.mock.calls.map(call => call[1]).filter(value => typeof value === "string") as string[];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(text => text.length <= 1900)).toBe(true);
    expect(chunks.join(" ").replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));
    expect(JSON.stringify(guild.sendTextMessage.mock.calls)).not.toContain("PRIVATE");
  });

  it("does not replay old thinking cards or old commentary when a channel is first synced", async () => {
    await append(event("task_started"), message("commentary", "Before linking"));
    await stateStore.update(state => ({ ...state, sessionChannels: state.sessionChannels.map(channel => ({ ...channel, lastTranscriptMessageKey: undefined })) }));
    await sync();
    expect(guild.sendTextMessage).not.toHaveBeenCalled();
  });

  it("suppresses duplicate progress for connector-owned turns and respects disabled posting", async () => {
    await append(event("task_started"), message("commentary", "Worker streams this"));
    await sync({ ignoredSessionIds: [sessionId] });
    await sync();
    expect(guild.sendTextMessage).not.toHaveBeenCalled();
    now += 1000;
    await append(event("task_started")); await sync({ postUpdates: false }); await sync();
    expect(guild.sendTextMessage).not.toHaveBeenCalled();
  });

  it("replaces a deleted active card, without swallowing unrelated Discord failures", async () => {
    await append(event("task_started")); await sync();
    now += TRANSCRIPT_PROGRESS_STALE_MS + 1;
    await sync();
    now += 1000;
    guild.editTextMessage.mockRejectedValueOnce({ code: 10008 });
    await append(message("commentary", "Recovered")); await sync();
    expect(await stateStore.findSessionChannelByDiscordId("channel")).toMatchObject({ transcriptProgress: { messageId: "sent-2" } });
    guild.editTextMessage.mockRejectedValueOnce(new Error("rate limited"));
    await append(event("turn_aborted"));
    await expect(sync()).rejects.toThrow("rate limited");
  });
});
