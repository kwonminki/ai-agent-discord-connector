import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { discoverCodexSessions } from "../../../packages/codex-adapter/src/index.js";
import { createDirectSyncStateStore } from "./directState.js";
import type { CreateDiscordMessageHandlerInput } from "./messageHandler.js";
import { notifyCodexTaskCompletions } from "./codexTaskNotifications.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const module of ["./connectConfig.js", "./directState.js", "./directControlClient.js", "./discordClient.js", "./messageHandler.js"]) vi.doUnmock(module);
});

it.each(["cli", "vscode", "appServer"])("discovers native children of %s parents during realtime sync without Orca", async (source) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-discord-"));
  const rootId = "019db2be-b2b3-7e82-9e61-8c84b28ad280";
  const childId = "019db2be-b2b3-7e82-9e61-8c84b28ad281";
  const timestamp = new Date().toISOString();
  const stateStore = createDirectSyncStateStore(path.join(home, "discord-state.json"));
  const sourceMeta = { subagent: { thread_spawn: { parent_thread_id: rootId, agent_nickname: "Noether", agent_path: "/root/review" } } };
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload }) + "\n";
  try {
    const sessionsDir = path.join(home, "sessions", "2026", "10", "11");
    await mkdir(sessionsDir, { recursive: true });
    const childFile = path.join(sessionsDir, `rollout-2026-10-11T00-00-00-${childId}.jsonl`);
    await writeFile(path.join(sessionsDir, `rollout-2026-10-11T00-00-00-${rootId}.jsonl`), line("session_meta", { id: rootId, cwd: home, source }));
    await writeFile(childFile, line("session_meta", { id: childId, cwd: home, source: sourceMeta }) + line("event_msg", { type: "task_started", turn_id: "child-turn" }));
    await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id: rootId, thread_name: "Main task", updated_at: timestamp }) + "\n");
    await promisify(execFile)("sqlite3", [path.join(home, "state_5.sqlite"), `create table threads (id text primary key, archived integer, source text); create table thread_spawn_edges (parent_thread_id text, child_thread_id text); insert into threads values ('${rootId}', 0, '${source}'), ('${childId}', 0, '${JSON.stringify(sourceMeta)}'); insert into thread_spawn_edges values ('${rootId}', '${childId}');`]);
    await stateStore.update(state => ({ ...state, transcriptSyncMode: "realtime", sessionChannels: [{ codexSessionId: rootId, threadName: "Main task", updatedAt: timestamp, cwd: home, workspaceRoot: home, workspaceDisplayName: "repo", discordCategoryId: null, discordChannelId: "parent", discordParentChannelId: "admin", discordDeliveryMode: "thread", channelName: "Main task", computerId: "pc", workspaceId: "workspace" }] }));
    const listCodexSessions = vi.fn(async (options) => ({ result: await discoverCodexSessions(home, { ...options, includeRealtimeEvents: true, includeContextPreview: true }) }));
    const controlApi = { listCodexSessions, createCategoryMapping: vi.fn(), createManagedChannel: vi.fn(), linkCodexSession: vi.fn() };
    const createHandler = vi.fn((_input: CreateDiscordMessageHandlerInput) => Object.assign(async () => {}, { drainRestoredMessages() {} }));
    vi.stubEnv("CONNECT_DESKTOP_INPUT_ENABLED", "false");
    vi.doMock("./connectConfig.js", () => ({ loadConnectConfig: async () => ({ mode: "direct", discord: { token: "test-token", guildId: "guild", allowedRoleIds: ["operator"] }, direct: { computerId: "pc", computerDisplayName: "PC", workspaceId: "workspace", workspaceRoot: home, workspaceDisplayName: "repo", channelId: "admin", channelMode: "shell-admin", timeoutMs: 1000, codexHome: home, orca: { enabled: false } } }) }));
    vi.doMock("./directState.js", async () => ({ ...await vi.importActual<typeof import("./directState.js")>("./directState.js"), createDirectSyncStateStore: () => stateStore }));
    vi.doMock("./directControlClient.js", () => ({ createDirectControlClient: () => controlApi }));
    vi.doMock("./messageHandler.js", () => ({ createDiscordMessageHandler: createHandler }));
    vi.doMock("./discordClient.js", () => ({ createDiscordClient: () => ({ login: vi.fn(), once: vi.fn(), on: vi.fn() }), attachDiscordMessageHandler: vi.fn(), attachDiscordInteractionHandler: vi.fn(), createDiscordGuildSurface: vi.fn(), registerDiscordApplicationCommands: vi.fn() }));
    const { startBot } = await import("./index.js");
    await startBot();
    const hooks = createHandler.mock.calls[0]?.[0] as unknown as CreateDiscordMessageHandlerInput;
    let threadId = 0;
    const guild = { createCategory: vi.fn(), createTextChannel: vi.fn(), createThread: vi.fn(async () => ({ id: `thread-${++threadId}` })), ensureSubagentContainer: vi.fn(async () => ({ id: "quiet" })), sendTextMessage: vi.fn(async (_id: string, _content: unknown, _options?: unknown) => ({ id: "message" })), editTextMessage: vi.fn() };
    await hooks.syncTranscriptUpdates!({ guild, trigger: "realtime" });
    const child = (await stateStore.read()).sessionChannels.find(channel => channel.codexSessionId === childId);
    expect(child).toMatchObject({ discordParentChannelId: "quiet", subagentRootSessionId: rootId, channelName: "review · Noether · 8c84b28ad281" });
    expect(await hooks.resolveSubagentParentChannel!(rootId)).toBe("parent");
    expect(guild.createThread).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(guild.sendTextMessage.mock.calls)).toContain("생각 중");

    const notifications = async () => notifyCodexTaskCompletions({ guild, stateStore, adminChannelId: "admin", mentionRoleIds: ["operator"], sessions: (await listCodexSessions({ includeSubAgents: true, activeOnly: false })).result });
    await notifications();
    guild.sendTextMessage.mockClear();
    await appendFile(childFile, line("response_item", { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reviewing the implementation" }] }));
    await hooks.syncTranscriptUpdates!({ guild, trigger: "realtime" });
    expect(JSON.stringify(guild.sendTextMessage.mock.calls)).toContain("Reviewing the implementation");
    await appendFile(childFile, line("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Review complete" }] }) + line("event_msg", { type: "task_complete", turn_id: "child-turn" }));
    await notifications();
    expect(JSON.stringify(guild.sendTextMessage.mock.calls)).toContain("Review complete");
    for (const [id, , options] of guild.sendTextMessage.mock.calls) { expect(id).toBe(child!.discordChannelId); expect(options).toBeUndefined(); }
    await hooks.syncTranscriptUpdates!({ guild, trigger: "realtime" });
    expect(guild.createThread).toHaveBeenCalledTimes(2);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 15_000);
