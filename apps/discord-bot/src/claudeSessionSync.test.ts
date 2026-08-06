import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  discoverClaudeCodeSessions,
  isExternallyStartedClaudeCodeSession,
  resumeClaudeCodeSessionThread,
  syncClaudeCodeSessionsToDiscord,
  type DiscoveredClaudeCodeSession,
} from "./claudeSessionSync.js";
import { createDirectSyncStateStore } from "./directState.js";

describe("discoverClaudeCodeSessions", () => {
  it("discovers Claude Code IDE sessions from Claude project JSONL files", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-sync-"));
    const projectRoot = path.join(tempRoot, ".claude", "projects", "-repo");
    const sessionPath = path.join(projectRoot, "session-ide.jsonl");

    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            type: "user",
            sessionId: "session-ide",
            cwd: "/repo",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:31:37.956Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "테스트 대화야" }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            sessionId: "session-ide",
            cwd: "/repo",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:31:45.812Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "좋아요" }],
            },
          }),
        ].join("\n"),
        "utf8",
      );

      await expect(discoverClaudeCodeSessions({ claudeHome: path.join(tempRoot, ".claude") })).resolves.toEqual([
        expect.objectContaining({
          id: "session-ide",
          cwd: "/repo",
          entrypoint: "claude-vscode",
          firstUserMessage: "테스트 대화야",
          latestAssistantMessage: "좋아요",
          latestAssistantMessageKey: "session-ide:2026-07-20T04:31:45.812Z:1",
          latestActivityKind: "assistant_text",
          updatedAt: "2026-07-20T04:31:45.812Z",
          filePath: sessionPath,
        }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips excluded session files before parsing them", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-sync-"));
    const projectRoot = path.join(tempRoot, ".claude", "projects", "-repo");

    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        path.join(projectRoot, "known-session.jsonl"),
        JSON.stringify({
          type: "user",
          sessionId: "known-session",
          cwd: "/repo",
          entrypoint: "claude-vscode",
          timestamp: "2026-07-20T04:31:37.956Z",
          message: { role: "user", content: "이미 연결됨" },
        }),
        "utf8",
      );

      await expect(
        discoverClaudeCodeSessions({
          claudeHome: path.join(tempRoot, ".claude"),
          excludeSessionIds: ["KNOWN-SESSION"],
        }),
      ).resolves.toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the file session identity when a foreign record is present", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-sync-isolation-"));
    const projectRoot = path.join(tempRoot, ".claude", "projects", "-repo");
    const sessionPath = path.join(projectRoot, "expected-session.jsonl");

    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            type: "user",
            sessionId: "expected-session",
            cwd: "/repo/expected",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:31:37.956Z",
            message: { role: "user", content: "expected prompt" },
          }),
          JSON.stringify({
            type: "assistant",
            sessionId: "foreign-session",
            cwd: "/repo/foreign",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:32:00.000Z",
            message: { role: "assistant", content: "foreign answer" },
          }),
          JSON.stringify({
            type: "assistant",
            sessionId: "expected-session",
            cwd: "/repo/expected",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:32:10.000Z",
            message: { role: "assistant", content: "expected answer" },
          }),
        ].join("\n"),
        "utf8",
      );

      await expect(discoverClaudeCodeSessions({
        claudeHome: path.join(tempRoot, ".claude"),
      })).resolves.toEqual([
        expect.objectContaining({
          id: "expected-session",
          cwd: "/repo/expected",
          firstUserMessage: "expected prompt",
          latestAssistantMessage: "expected answer",
          updatedAt: "2026-07-20T04:32:10.000Z",
        }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates cached Claude session details from appended JSONL records", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-sync-"));
    const projectRoot = path.join(tempRoot, ".claude", "projects", "-repo");
    const sessionPath = path.join(projectRoot, "session-cache.jsonl");

    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            type: "user",
            sessionId: "session-cache",
            cwd: "/repo",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:31:37.956Z",
            message: { role: "user", content: [{ type: "text", text: "캐시 테스트" }] },
          }),
          JSON.stringify({
            type: "assistant",
            sessionId: "session-cache",
            cwd: "/repo",
            entrypoint: "claude-vscode",
            timestamp: "2026-07-20T04:31:45.812Z",
            message: { role: "assistant", content: [{ type: "text", text: "첫 답변" }] },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      await expect(discoverClaudeCodeSessions({ claudeHome: path.join(tempRoot, ".claude") })).resolves.toEqual([
        expect.objectContaining({
          id: "session-cache",
          latestAssistantMessage: "첫 답변",
          latestAssistantMessageKey: "session-cache:2026-07-20T04:31:45.812Z:1",
          latestActivityKind: "assistant_text",
        }),
      ]);

      await writeFile(
        sessionPath,
        `${JSON.stringify({
          type: "assistant",
          sessionId: "session-cache",
          cwd: "/repo",
          entrypoint: "claude-vscode",
          timestamp: "2026-07-20T04:32:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "둘째 답변" }] },
        })}\n`,
        { flag: "a" },
      );

      await expect(discoverClaudeCodeSessions({ claudeHome: path.join(tempRoot, ".claude") })).resolves.toEqual([
        expect.objectContaining({
          id: "session-cache",
          firstUserMessage: "캐시 테스트",
          latestAssistantMessage: "둘째 답변",
          latestAssistantMessageKey: "session-cache:2026-07-20T04:32:00.000Z:2",
          latestActivityKind: "assistant_text",
        }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("isExternallyStartedClaudeCodeSession", () => {
  it("treats IDE sessions as external and skips connector SDK CLI sessions", () => {
    expect(isExternallyStartedClaudeCodeSession({ entrypoint: "claude-vscode" })).toBe(true);
    expect(isExternallyStartedClaudeCodeSession({ entrypoint: "sdk-cli" })).toBe(false);
    expect(isExternallyStartedClaudeCodeSession({ entrypoint: null })).toBe(false);
  });
});

describe("syncClaudeCodeSessionsToDiscord", () => {
  const recentIdeSession = {
    id: "session-ide",
    cwd: "/repo",
    entrypoint: "claude-vscode",
    firstUserMessage: "테스트 대화야",
    latestAssistantMessage: "좋아요",
    latestAssistantMessageKey: "session-ide:2026-07-20T04:31:45.812Z:1",
    latestActivityKind: "assistant_text",
    updatedAt: "2026-07-20T04:31:45.812Z",
    filePath: "/tmp/session-ide.jsonl",
  } satisfies DiscoveredClaudeCodeSession;

  it("creates a Claude Code thread for an unlinked external Claude session", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createThread: vi.fn().mockResolvedValue({ id: "thread-ide" }),
      sendTextMessage: vi.fn().mockResolvedValue({ id: "context-message" }),
    };
    const controlApi = {
      createManagedChannel: vi.fn().mockResolvedValue({ id: "managed-thread" }),
    };

    try {
      await expect(
        syncClaudeCodeSessionsToDiscord({
          guild,
          controlApi,
          stateStore,
          computerId: "mac",
          computerDisplayName: "Kwon Mac",
          parentChannelId: "claude-parent",
          mentionRoleIds: ["role-1"],
          lookbackMs: 24 * 60 * 60 * 1_000,
          limit: 10,
          now: new Date("2026-07-20T05:00:00.000Z"),
          sessions: [recentIdeSession],
        }),
      ).resolves.toMatchObject({
        checkedSessions: 1,
        createdThreads: 1,
        skippedExisting: 0,
        skippedEntrypoint: 0,
      });

      expect(guild.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "테스트 대화야",
          parentChannelId: "claude-parent",
          autoArchiveDuration: 10_080,
          reason: expect.stringContaining("Claude Code session: session-ide"),
        }),
      );
      expect(controlApi.createManagedChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          discordChannelId: "thread-ide",
          channelMode: "claude-code",
          workspaceId: "mac:/repo",
        }),
      );
      expect(guild.sendTextMessage).toHaveBeenCalledWith(
        "thread-ide",
        expect.stringContaining("Claude Code 세션 연결됨"),
        { mentionRoleIds: ["role-1"] },
      );
      await expect(stateStore.findSessionChannelByDiscordId("thread-ide")).resolves.toMatchObject({
        codexSessionId: null,
        claudeSessionId: "session-ide",
        channelMode: "claude-code",
        discordParentChannelId: "claude-parent",
        discordDeliveryMode: "thread",
        workspaceRoot: "/repo",
        cwd: "/repo",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips SDK CLI sessions and already linked Claude sessions", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createThread: vi.fn().mockResolvedValue({ id: "thread-new" }),
      sendTextMessage: vi.fn().mockResolvedValue({ id: "context-message" }),
    };
    const controlApi = {
      createManagedChannel: vi.fn().mockResolvedValue({ id: "managed-thread" }),
    };

    try {
      await syncClaudeCodeSessionsToDiscord({
        guild,
        controlApi,
        stateStore,
        computerId: "mac",
        computerDisplayName: "Kwon Mac",
        parentChannelId: "claude-parent",
        lookbackMs: 24 * 60 * 60 * 1_000,
        limit: 10,
        now: new Date("2026-07-20T05:00:00.000Z"),
        sessions: [recentIdeSession],
      });
      guild.createThread.mockClear();

      await expect(
        syncClaudeCodeSessionsToDiscord({
          guild,
          controlApi,
          stateStore,
          computerId: "mac",
          computerDisplayName: "Kwon Mac",
          parentChannelId: "claude-parent",
          lookbackMs: 24 * 60 * 60 * 1_000,
          limit: 10,
          now: new Date("2026-07-20T05:00:00.000Z"),
          sessions: [
            recentIdeSession,
            {
              ...recentIdeSession,
              id: "session-sdk",
              entrypoint: "sdk-cli",
              filePath: "/tmp/session-sdk.jsonl",
            },
          ],
        }),
      ).resolves.toMatchObject({
        checkedSessions: 2,
        createdThreads: 0,
        skippedExisting: 1,
        skippedEntrypoint: 1,
      });

      expect(guild.createThread).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resumeClaudeCodeSessionThread", () => {
  async function writeConnectorSessionFixture(tempRoot: string): Promise<void> {
    const projectRoot = path.join(tempRoot, ".claude", "projects", "-repo");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, "session-connector.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: "session-connector",
          cwd: "/repo",
          entrypoint: "sdk-cli",
          timestamp: "2026-07-20T04:31:37.956Z",
          message: { role: "user", content: [{ type: "text", text: "지운 스레드 대화야" }] },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "session-connector",
          cwd: "/repo",
          entrypoint: "sdk-cli",
          timestamp: "2026-07-20T04:31:45.812Z",
          message: { role: "assistant", content: [{ type: "text", text: "네" }] },
        }),
      ].join("\n"),
      "utf8",
    );
  }

  it("returns not-found for unknown session ids", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-resume-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

    try {
      await writeConnectorSessionFixture(tempRoot);
      await expect(
        resumeClaudeCodeSessionThread({
          guild: { createThread: vi.fn(), sendTextMessage: vi.fn(), ensureChannelAvailable: vi.fn() },
          controlApi: { createManagedChannel: vi.fn() },
          stateStore,
          computerId: "mac",
          computerDisplayName: "Kwon Mac",
          parentChannelId: "claude-parent",
          claudeHome: path.join(tempRoot, ".claude"),
          sessionId: "no-such-session",
        }),
      ).resolves.toEqual({ status: "not-found" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recreates a thread for a connector session, reuses live links, and replaces deleted ones", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-resume-flow-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const createThread = vi.fn()
      .mockResolvedValueOnce({ id: "thread-1" })
      .mockResolvedValueOnce({ id: "thread-2" });
    const ensureChannelAvailable = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const guild = {
      createThread,
      sendTextMessage: vi.fn().mockResolvedValue({ id: "context" }),
      ensureChannelAvailable,
    };
    const controlApi = { createManagedChannel: vi.fn().mockResolvedValue({ id: "managed" }) };
    const baseInput = {
      guild,
      controlApi,
      stateStore,
      computerId: "mac",
      computerDisplayName: "Kwon Mac",
      parentChannelId: "claude-parent",
      claudeHome: path.join(tempRoot, ".claude"),
      sessionId: "session-connector",
    };

    try {
      await writeConnectorSessionFixture(tempRoot);

      await expect(resumeClaudeCodeSessionThread(baseInput)).resolves.toEqual({
        status: "created",
        channelId: "thread-1",
        threadName: "지운 스레드 대화야",
      });
      let state = await stateStore.read();
      expect(state.sessionChannels.map((channel) => channel.discordChannelId)).toEqual(["thread-1"]);
      expect(state.sessionChannels[0]).toMatchObject({
        claudeSessionId: "session-connector",
        channelMode: "claude-code",
        discordDeliveryMode: "thread",
      });

      // The thread still exists in Discord → reuse it instead of duplicating.
      await expect(resumeClaudeCodeSessionThread(baseInput)).resolves.toEqual({
        status: "already-linked",
        channelId: "thread-1",
      });

      // The thread was deleted in Discord → drop the stale link and recreate.
      await expect(resumeClaudeCodeSessionThread(baseInput)).resolves.toEqual({
        status: "created",
        channelId: "thread-2",
        threadName: "지운 스레드 대화야",
      });
      state = await stateStore.read();
      expect(state.sessionChannels.map((channel) => channel.discordChannelId)).toEqual(["thread-2"]);
      expect(createThread).toHaveBeenCalledTimes(2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
