import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDirectSyncStateStore } from "./directState.js";

describe("direct sync state store", () => {
  it("migrates agent defaults and persists main and thread settings", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await expect(store.read()).resolves.toMatchObject({
        agentDefaults: {
          codex: { model: null, effort: "xhigh" },
          claude: { model: null, effort: "max" },
        },
      });

      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [{
          codexSessionId: "session-1",
          threadName: "Settings test",
          updatedAt: "2026-07-23T00:00:00.000Z",
          cwd: "/repo",
          workspaceRoot: "/repo",
          workspaceDisplayName: "repo",
          discordCategoryId: null,
          discordChannelId: "thread-1",
          channelMode: "session-linked",
          channelName: "settings-test",
          computerId: "local-dev",
          workspaceId: "local-dev:/repo",
        }],
      });

      await store.updateAgentDefaults("codex", { model: "gpt-5.6-sol", effort: "high" });
      await store.updateAgentDefaults("claude", { model: "claude-fable-5[1m]", effort: "max" });
      await store.updateSessionChannelAgentSettings("thread-1", {
        model: "gpt-5.4",
        effort: "medium",
      });

      await expect(store.read()).resolves.toMatchObject({
        agentDefaults: {
          codex: { model: "gpt-5.6-sol", effort: "high" },
          claude: { model: "claude-fable-5[1m]", effort: "max" },
        },
        sessionChannels: [{
          discordChannelId: "thread-1",
          agentModelOverride: "gpt-5.4",
          agentEffortOverride: "medium",
        }],
      });

      await store.updateSessionChannelAgentSettings("thread-1", { model: null, effort: null });
      await expect(store.read()).resolves.toMatchObject({
        sessionChannels: [{
          discordChannelId: "thread-1",
          agentModelOverride: null,
          agentEffortOverride: null,
        }],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults transcript sync to realtime and persists transcript markers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await expect(store.read()).resolves.toMatchObject({
        transcriptSyncMode: "realtime",
        taskCompletionNotificationsInitializedAt: null,
        taskCompletionNotificationScope: null,
        taskCompletionNotifications: [],
        discordRequestedCodexSessionIds: [],
      });

      await store.write({
        version: 1,
        transcriptSyncMode: "realtime",
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [
          {
            codexSessionId: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-1",
            discordChannelId: "channel-1",
            channelName: "build-bridge",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
            lastTranscriptMessageKey: "message-key-1",
            lastTranscriptSyncedAt: "2026-04-23T00:01:00.000Z",
            lastTranscriptDiscordMessageId: "discord-message-1",
          },
        ],
      });

      await expect(store.read()).resolves.toMatchObject({
        transcriptSyncMode: "realtime",
        sessionChannels: [
          {
            lastTranscriptMessageKey: "message-key-1",
            lastTranscriptSyncedAt: "2026-04-23T00:01:00.000Z",
            lastTranscriptDiscordMessageId: "discord-message-1",
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries transient partial JSON reads", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const statePath = path.join(tempRoot, "state.json");
      const store = createDirectSyncStateStore(statePath);
      await writeFile(statePath, "{", "utf8");

      setTimeout(() => {
        void writeFile(
          statePath,
          JSON.stringify({
            version: 1,
            transcriptSyncMode: "on-chat",
            archivedCodexSessionIds: [],
            workspaces: [],
            sessionChannels: [],
            scheduledCommands: [],
            taskCompletionNotifications: [],
            discordRequestedCodexSessionIds: [],
          }),
          "utf8",
        );
      }, 5);

      await expect(store.read()).resolves.toMatchObject({
        transcriptSyncMode: "on-chat",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists synced session channels and updates per-channel cwd", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [
          {
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-1",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
        sessionChannels: [
          {
            codexSessionId: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-1",
            discordChannelId: "channel-1",
            channelName: "build-bridge",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
      });

      await expect(store.read()).resolves.toMatchObject({
        version: 1,
        sessionChannels: [
          {
            codexSessionId: "session-1",
            discordChannelId: "channel-1",
            cwd: "/repo",
          },
        ],
      });

      await store.updateChannelCwd("channel-1", "/repo/apps");

      await expect(store.findSessionChannelByDiscordId("channel-1")).resolves.toMatchObject({
        codexSessionId: "session-1",
        cwd: "/repo/apps",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists pending new-chat channels and links the Codex session id later", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [
          {
            codexSessionId: null,
            threadName: "General Codex chat",
            updatedAt: "2026-04-24T00:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "General Chat",
            discordCategoryId: null,
            discordChannelId: "channel-1",
            channelName: "general-codex-chat",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo:general",
          },
        ],
      });

      await store.updateSessionChannelCodexSession("channel-1", "session-new", "General Codex chat");
      await store.updateSessionChannelClaudeSession("channel-1", "claude-session-1");

      await expect(
        store.updateSessionChannelCodexSession("channel-1", "foreign-session", "Wrong chat"),
      ).rejects.toThrow("already bound to Codex session session-new");
      await expect(
        store.updateSessionChannelClaudeSession("channel-1", "foreign-claude-session"),
      ).rejects.toThrow("already bound to Claude Code session claude-session-1");

      await expect(store.findSessionChannelByDiscordId("channel-1")).resolves.toMatchObject({
        codexSessionId: "session-new",
        claudeSessionId: "claude-session-1",
        threadName: "General Codex chat",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists scheduled commands", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [],
        scheduledCommands: [
          {
            id: "sched-1",
            channelId: "channel-1",
            userId: "user-1",
            roleIds: ["role-operator"],
            command: "shell pwd",
            schedule: { type: "interval", everyMs: 60_000 },
            enabled: true,
            nextRunAt: "2026-04-24T01:00:00.000Z",
            createdAt: "2026-04-24T00:00:00.000Z",
            updatedAt: "2026-04-24T00:00:00.000Z",
            runCount: 0,
          },
        ],
      });

      await expect(store.read()).resolves.toMatchObject({
        scheduledCommands: [
          {
            id: "sched-1",
            command: "shell pwd",
            nextRunAt: "2026-04-24T01:00:00.000Z",
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists pending Discord-requested Codex sessions without duplicates", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await store.markDiscordRequestedCodexSession("SESSION-1");
      await store.markDiscordRequestedCodexSession("session-1");
      await store.markDiscordRequestedCodexSession("session-1", {
        discordChannelId: "thread-1",
        completionMentionSent: true,
      });
      await store.markDiscordRequestedCodexSession("session-2");

      await expect(store.read()).resolves.toMatchObject({
        discordRequestedCodexSessionIds: [],
        discordRequestedCodexSessionRequests: [
          {
            sessionId: "session-1",
            requestedAt: expect.any(String),
            discordChannelId: "thread-1",
            completionMentionSent: true,
          },
          {
            sessionId: "session-2",
            requestedAt: expect.any(String),
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a linked Codex session's Discord channel as canonical request provenance", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [{
          codexSessionId: "session-1",
          threadName: "Canonical session",
          updatedAt: "2026-08-06T00:00:00.000Z",
          cwd: "/repo",
          workspaceRoot: "/repo",
          workspaceDisplayName: "repo",
          discordCategoryId: null,
          discordChannelId: "canonical-channel",
          channelName: "canonical-session",
          computerId: "local-dev",
          workspaceId: "local-dev:/repo",
        }],
        discordRequestedCodexSessionRequests: [{
          sessionId: "session-1",
          requestedAt: "2026-08-06T00:00:00.000Z",
          discordChannelId: "foreign-channel",
        }],
      });

      await store.markDiscordRequestedCodexSession("session-1", {
        discordChannelId: "another-foreign-channel",
        completionMentionSent: true,
      });

      await expect(store.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [{
          sessionId: "session-1",
          discordChannelId: "canonical-channel",
          completionMentionSent: true,
        }],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects source or duplicate session IDs when a pending fork is linked", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));

    try {
      const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
      const channel = (input: {
        discordChannelId: string;
        codexSessionId: string | null;
        pendingForkSourceSessionId?: string;
      }) => ({
        codexSessionId: input.codexSessionId,
        threadName: input.discordChannelId,
        updatedAt: "2026-07-21T00:00:00.000Z",
        cwd: "/repo",
        workspaceRoot: "/repo",
        workspaceDisplayName: "repo",
        discordCategoryId: null,
        discordChannelId: input.discordChannelId,
        discordDeliveryMode: "thread" as const,
        channelMode: "session-linked" as const,
        channelName: input.discordChannelId,
        computerId: "local-dev",
        workspaceId: "local-dev:/repo",
        pendingForkSourceSessionId: input.pendingForkSourceSessionId ?? null,
      });

      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [
          channel({ discordChannelId: "source-thread", codexSessionId: "source-session" }),
          channel({
            discordChannelId: "fork-thread",
            codexSessionId: null,
            pendingForkSourceSessionId: "source-session",
          }),
        ],
      });

      await expect(
        store.updateSessionChannelCodexSession("fork-thread", "source-session", "Fork"),
      ).rejects.toThrow("source Codex session ID");

      await store.updateSessionChannelCodexSession("fork-thread", "fork-session", "Fork");

      await store.update((state) => ({
        ...state,
        sessionChannels: [
          ...state.sessionChannels,
          channel({ discordChannelId: "second-fork", codexSessionId: null }),
        ],
      }));

      await expect(
        store.updateSessionChannelCodexSession("second-fork", "fork-session", "Second fork"),
      ).rejects.toThrow("already linked");
      await expect(store.removePendingSessionChannel("fork-thread")).resolves.toBe(false);
      await expect(store.removePendingSessionChannel("second-fork")).resolves.toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
