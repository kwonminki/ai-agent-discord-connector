import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transcript: vi.fn(async () => ({ updatedChannels: 1, postedMessages: 1 })),
  completion: vi.fn(async () => ({ initialized: false, notifiedSessions: 1 })),
  claude: vi.fn(async () => []),
}));
vi.mock("./discordGatewayWatchdog.js", () => ({ watchDiscordGateway: () => () => {} }));
vi.mock("./codexTranscriptSync.js", () => ({ syncCodexSessionTranscriptUpdates: mocks.transcript }));
vi.mock("./codexTaskNotifications.js", () => ({ notifyCodexTaskCompletions: mocks.completion }));
vi.mock("./claudeSessionSync.js", () => ({ discoverClaudeCodeSessions: mocks.claude, syncClaudeCodeSessionsToDiscord: vi.fn(async () => ({ createdThreads: 0 })) }));
vi.mock("./claudeTaskNotifications.js", () => ({ DEFAULT_CLAUDE_COMPLETION_IDLE_MS: 10000, notifyClaudeCodeTaskCompletions: vi.fn(async () => ({ notifiedSessions: 0 })) }));
vi.mock("./subagentThreads.js", () => ({ syncSubagentThreads: vi.fn(async () => {}), subagentThreadName: vi.fn() }));
vi.mock("./messageHandler.js", () => ({ createDiscordMessageHandler: () => Object.assign(async () => {}, { drainRestoredMessages() {} }) }));
vi.mock("./directWorkerClient.js", () => ({ createDirectWorkerClient: () => null }));
vi.mock("./durableRequestStore.js", () => ({ createDurableDiscordRequestStore: () => ({ list: async () => [] }) }));
vi.mock("./directState.js", () => ({ createDirectSyncStateStore: () => ({ read: async () => ({ transcriptSyncMode: "realtime", sessionChannels: [{ codexSessionId: "session", discordChannelId: "thread" }], scheduledCommands: [] }) }) }));
vi.mock("./directControlClient.js", () => ({ createDirectControlClient: () => ({ listCodexSessions: async () => ({ result: [] }) }) }));
vi.mock("./connectConfig.js", () => ({ loadConnectConfig: async () => ({ mode: "direct", discord: { token: "test", guildId: "guild", allowedRoleIds: [] }, direct: { computerId: "pc", channelId: "admin", claudeChannelId: "claude", workspaceRoot: "/repo", orca: { enabled: false } } }) }));
vi.mock("./scheduler.js", () => ({ runDueScheduledCommands: vi.fn(async () => {}) }));

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();
  vi.doUnmock("./discordClient.js");
  for (const mock of Object.values(mocks)) mock.mockClear();
});

async function start() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.stubEnv("CONNECT_BACKGROUND_MAX_LOAD", "0.7");
  vi.stubEnv("CONNECT_BACKGROUND_POLL_MAX_INTERVAL_MS", "20000");
  vi.stubEnv("CONNECT_TRANSCRIPT_SYNC_INTERVAL_MS", "5000");
  vi.stubEnv("CONNECT_TASK_NOTIFICATION_INTERVAL_MS", "3000");
  vi.stubEnv("CONNECT_CLAUDE_SESSION_SYNC_INTERVAL_MS", "5000");
  vi.stubEnv("CONNECT_DESKTOP_INPUT_ENABLED", "false");
  vi.spyOn(os, "availableParallelism").mockReturnValue(48);
  const load = vi.spyOn(os, "loadavg").mockReturnValue([149, 154, 155]);
  let ready: (() => void) | undefined;
  const client = { login: vi.fn(), once: vi.fn((_name, handler) => { ready = handler; }), on: vi.fn(), guilds: { cache: new Map([["guild", {}]]) } };
  vi.doMock("./discordClient.js", () => ({ createDiscordClient: () => client, createDiscordGuildSurface: () => ({ sendTextMessage: vi.fn() }), attachDiscordMessageHandler: vi.fn(), attachDiscordInteractionHandler: vi.fn(), registerDiscordApplicationCommands: vi.fn(async () => {}) }));
  const { startBot } = await import("./index.js");
  await startBot(); ready!();
  return load;
}

it("continues transcript, completion and Claude polling during sustained high host load", async () => {
  const load = await start();
  await vi.advanceTimersByTimeAsync(65_000);
  expect(mocks.transcript.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(mocks.transcript.mock.calls.length).toBeLessThanOrEqual(5);
  expect(mocks.completion.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(mocks.claude.mock.calls.length).toBeGreaterThanOrEqual(3);
  load.mockReturnValue([1, 1, 1]);
  await vi.advanceTimersByTimeAsync(25_000);
  const calls = mocks.transcript.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.transcript).toHaveBeenCalledTimes(calls + 2);
});

it("does not overlap a slow scan, while independent completion polling continues", async () => {
  let finish!: () => void;
  mocks.transcript.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ updatedChannels: 1, postedMessages: 1 }); }));
  await start();
  await vi.advanceTimersByTimeAsync(65_000);
  expect(mocks.transcript).toHaveBeenCalledTimes(1);
  expect(mocks.completion.mock.calls.length).toBeGreaterThanOrEqual(3);
  finish();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(mocks.transcript.mock.calls.length).toBeGreaterThan(1);
});
