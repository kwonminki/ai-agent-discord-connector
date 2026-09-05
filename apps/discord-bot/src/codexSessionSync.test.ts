import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncCodexSessionsToDiscord } from "./codexSessionSync.js";
import { syncCodexSessionTranscriptUpdates } from "./codexTranscriptSync.js";
import { createDirectSyncStateStore } from "./directState.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;

  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("syncCodexSessionsToDiscord", () => {
  it("creates one Discord category per Codex workspace and one channel per Codex session", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createCategory: vi
        .fn()
        .mockResolvedValueOnce({ id: "category-repo" })
        .mockResolvedValueOnce({ id: "category-other" }),
      createTextChannel: vi
        .fn()
        .mockResolvedValueOnce({ id: "channel-a" })
        .mockResolvedValueOnce({ id: "channel-b" })
        .mockResolvedValueOnce({ id: "channel-c" }),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await expect(
        syncCodexSessionsToDiscord({
          guild,
          controlApi,
          stateStore: store,
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          defaultWorkspaceRoot: "/fallback",
          sessions: [
            {
              id: "session-a",
              threadName: "Codex Discord sync design",
              updatedAt: "2026-04-23T10:00:00.000Z",
              cwdHint: "/repo",
            },
            {
              id: "session-b",
              threadName: "Direct mode 구현",
              updatedAt: "2026-04-23T09:00:00.000Z",
              cwdHint: "/repo",
            },
            {
              id: "session-c",
              threadName: "Other project task",
              updatedAt: "2026-04-23T08:00:00.000Z",
              cwdHint: "/other",
            },
          ],
          limit: 25,
        }),
      ).resolves.toEqual({
        createdCategories: 2,
        existingCategories: 0,
        createdChannels: 3,
        existingChannels: 0,
        skippedSessions: 0,
      });

      expect(guild.createCategory).toHaveBeenCalledWith({ name: "repo" });
      expect(guild.createCategory).toHaveBeenCalledWith({ name: "other" });
      expect(guild.createTextChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "codex-discord-sync-design",
          parentId: "category-repo",
          topic: expect.stringContaining("session-a"),
        }),
      );
      expect(controlApi.linkCodexSession).toHaveBeenCalledWith(
        expect.objectContaining({
          discordChannelId: "channel-a",
          codexSessionId: "session-a",
          origin: "imported_native",
        }),
      );
      await expect(store.findSessionChannelByDiscordId("channel-b")).resolves.toMatchObject({
        codexSessionId: "session-b",
        workspaceRoot: "/repo",
        channelName: "direct-mode-구현",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates session threads under the configured parent channel and mentions operator roles for context", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createCategory: vi.fn().mockResolvedValueOnce({ id: "category-repo" }),
      createTextChannel: vi.fn(),
      createThread: vi.fn().mockResolvedValueOnce({ id: "thread-a" }),
      sendTextMessage: vi.fn().mockResolvedValue({ id: "context-message" }),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await expect(
        syncCodexSessionsToDiscord({
          guild,
          controlApi,
          stateStore: store,
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          defaultWorkspaceRoot: "/fallback",
          sessions: [
            {
              id: "session-a",
              threadName: "Codex Discord sync design",
              updatedAt: "2026-04-23T10:00:00.000Z",
              cwdHint: "/repo",
              contextPreview: [{ role: "user", text: "이전 질문" }],
            },
          ],
          limit: 25,
          sessionThreadParentChannelId: "admin-channel",
          mentionRoleIds: ["operator-role"],
        }),
      ).resolves.toMatchObject({
        createdChannels: 1,
        existingChannels: 0,
      });

      expect(guild.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Codex Discord sync design",
          parentChannelId: "admin-channel",
          autoArchiveDuration: 10_080,
          reason: expect.stringContaining("session-a"),
        }),
      );
      expect(guild.createTextChannel).not.toHaveBeenCalled();
      expect(guild.sendTextMessage).toHaveBeenCalledWith(
        "thread-a",
        expect.stringContaining("이전 질문"),
        { mentionRoleIds: ["operator-role"] },
      );
      expect(controlApi.createManagedChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          discordChannelId: "thread-a",
          channelMode: "session-linked",
        }),
      );
      await expect(store.findSessionChannelByDiscordId("thread-a")).resolves.toMatchObject({
        codexSessionId: "session-a",
        discordParentChannelId: "admin-channel",
        discordDeliveryMode: "thread",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips bridge-archived sessions and reports readable progress", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const progress: unknown[] = [];
    const guild = {
      createCategory: vi.fn().mockResolvedValueOnce({ id: "category-repo" }),
      createTextChannel: vi.fn().mockResolvedValueOnce({ id: "channel-active" }),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await store.write({
        version: 1,
        archivedCodexSessionIds: ["archived-session"],
        workspaces: [],
        sessionChannels: [],
      });

      await expect(
        syncCodexSessionsToDiscord({
          guild,
          controlApi,
          stateStore: store,
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          defaultWorkspaceRoot: "/repo",
          sessions: [
            {
              id: "active-session",
              threadName: "Active bridge session",
              updatedAt: "2026-04-23T10:00:00.000Z",
              cwdHint: "/repo",
            },
            {
              id: "archived-session",
              threadName: "Archived bridge session",
              updatedAt: "2026-04-23T09:00:00.000Z",
              cwdHint: "/repo",
            },
          ],
          limit: 25,
          onProgress: async (event) => {
            progress.push(event);
          },
        }),
      ).resolves.toMatchObject({
        createdChannels: 1,
        skippedSessions: 1,
      });

      expect(guild.createTextChannel).toHaveBeenCalledTimes(1);
      expect(guild.createTextChannel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "active-bridge-session" }),
      );
      expect(progress).toEqual([
        expect.objectContaining({
          phase: "syncing",
          processedSessions: 0,
          totalSessions: 1,
          filteredSessions: 1,
        }),
        expect.objectContaining({
          phase: "syncing",
          processedSessions: 1,
          totalSessions: 1,
          currentSessionName: "Active bridge session",
        }),
        expect.objectContaining({
          phase: "complete",
          processedSessions: 1,
          totalSessions: 1,
          filteredSessions: 1,
        }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recreates a stale workspace category when Discord rejects the stored parent id", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const staleParentError = new Error(
      "Invalid Form Body parent_id[CHANNEL_PARENT_INVALID]: Category does not exist",
    );
    const guild = {
      createCategory: vi.fn().mockResolvedValueOnce({ id: "category-recreated" }),
      createTextChannel: vi
        .fn()
        .mockRejectedValueOnce(staleParentError)
        .mockResolvedValueOnce({ id: "channel-a" }),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [
          {
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "deleted-category",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
        sessionChannels: [],
      });

      await expect(
        syncCodexSessionsToDiscord({
          guild,
          controlApi,
          stateStore: store,
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          defaultWorkspaceRoot: "/repo",
          sessions: [
            {
              id: "session-a",
              threadName: "Fresh session",
              updatedAt: "2026-04-23T10:00:00.000Z",
              cwdHint: "/repo",
            },
          ],
          limit: 25,
        }),
      ).resolves.toMatchObject({
        createdCategories: 1,
        createdChannels: 1,
      });

      expect(guild.createTextChannel).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ parentId: "deleted-category" }),
      );
      expect(guild.createTextChannel).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ parentId: "category-recreated" }),
      );
      await expect(store.read()).resolves.toMatchObject({
        workspaces: [
          expect.objectContaining({
            workspaceRoot: "/repo",
            discordCategoryId: "category-recreated",
          }),
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("posts a compact context preview once for synced session channels", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };
    const session = {
      id: "session-a",
      threadName: "Context rich session",
      updatedAt: "2026-04-23T10:00:00.000Z",
      cwdHint: "/repo",
      contextPreview: [
        { role: "user" as const, text: "이전 요구사항 정리해줘" },
        { role: "assistant" as const, text: "Discord 버튼 UX를 개선했습니다." },
      ],
    };

    try {
      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [
          {
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-repo",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
        sessionChannels: [
          {
            codexSessionId: "session-a",
            threadName: "Context rich session",
            updatedAt: "2026-04-23T10:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-repo",
            discordChannelId: "channel-a",
            channelName: "context-rich-session",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
      });

      await syncCodexSessionsToDiscord({
        guild,
        controlApi,
        stateStore: store,
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        defaultWorkspaceRoot: "/repo",
        sessions: [session],
        limit: 25,
      });
      await syncCodexSessionsToDiscord({
        guild,
        controlApi,
        stateStore: store,
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        defaultWorkspaceRoot: "/repo",
        sessions: [session],
        limit: 25,
      });

      expect(guild.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(guild.sendTextMessage).toHaveBeenCalledWith(
        "channel-a",
        expect.stringContaining("이전 Codex 대화 맥락"),
      );
      expect(guild.sendTextMessage).toHaveBeenCalledWith(
        "channel-a",
        expect.stringContaining("### 이전 요구사항 정리해줘"),
      );
      await expect(store.read()).resolves.toMatchObject({
        sessionChannels: [
          expect.objectContaining({
            codexSessionId: "session-a",
            contextPostedAt: expect.any(String),
          }),
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes the transcript marker during sync so realtime posts the next desktop update", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-marker-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await store.write({
        version: 1,
        transcriptSyncMode: "realtime",
        archivedCodexSessionIds: [],
        workspaces: [
          {
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-repo",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
        sessionChannels: [
          {
            codexSessionId: "session-a",
            threadName: "Realtime session",
            updatedAt: "2026-04-23T10:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-repo",
            discordChannelId: "channel-a",
            channelName: "realtime-session",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
      });

      await syncCodexSessionsToDiscord({
        guild,
        controlApi,
        stateStore: store,
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        defaultWorkspaceRoot: "/repo",
        sessions: [
          {
            id: "session-a",
            threadName: "Realtime session",
            updatedAt: "2026-04-23T10:00:00.000Z",
            cwdHint: "/repo",
            realtimeEvents: [
              { key: "event-1", kind: "user", text: "이전 질문" },
              { key: "event-2", kind: "assistant", text: "이전 답변" },
            ],
          },
        ],
        limit: 25,
      });

      await expect(store.findSessionChannelByDiscordId("channel-a")).resolves.toMatchObject({
        lastTranscriptMessageKey: "event-2",
        lastTranscriptSyncedAt: expect.any(String),
      });

      await syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage: guild.sendTextMessage },
        stateStore: store,
        trigger: "realtime",
        sessions: [
          {
            id: "session-a",
            threadName: "Realtime session",
            updatedAt: "2026-04-23T10:01:00.000Z",
            cwdHint: "/repo",
            realtimeEvents: [
              { key: "event-1", kind: "user", text: "이전 질문" },
              { key: "event-2", kind: "assistant", text: "이전 답변" },
              { key: "event-3", kind: "user", text: "데스크탑에서 새로 보낸 질문" },
            ],
          },
        ],
      });

      expect(guild.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(guild.sendTextMessage).toHaveBeenCalledWith(
        "channel-a",
        expect.stringContaining("### 데스크탑에서 새로 보낸 질문"),
      );
      expect(guild.sendTextMessage.mock.calls[0]?.[1]).not.toContain("이전 질문");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not let background sync claim a session reserved by a pending explicit fork", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-pending-fork-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const guild = {
      createCategory: vi.fn().mockResolvedValue({ id: "category-repo" }),
      createTextChannel: vi.fn().mockResolvedValue({ id: "unexpected-channel" }),
      createThread: vi.fn().mockResolvedValue({ id: "unexpected-thread" }),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [],
        sessionChannels: [{
          codexSessionId: null,
          threadName: "Harness Builder",
          updatedAt: "2026-09-05T19:23:10.687Z",
          cwd: "/repo",
          workspaceRoot: "/repo",
          workspaceDisplayName: "repo",
          discordCategoryId: null,
          discordChannelId: "pending-fork-thread",
          discordParentChannelId: "admin-channel",
          discordDeliveryMode: "thread",
          channelMode: "session-linked",
          pendingForkSourceDiscordChannelId: "source-thread",
          pendingForkSourceSessionId: "source-session",
          channelName: "harness-builder",
          computerId: "local-dev",
          workspaceId: "local-dev:/repo",
        }],
      });

      await expect(syncCodexSessionsToDiscord({
        guild,
        controlApi,
        stateStore: store,
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        defaultWorkspaceRoot: "/repo",
        sessions: [{
          id: "fork-session",
          threadName: "Harness Builder",
          updatedAt: "2026-09-05T19:23:11.274Z",
          cwdHint: "/repo",
          forkedFromId: "source-session",
        }],
        limit: 25,
      })).resolves.toEqual({
        createdCategories: 0,
        existingCategories: 0,
        createdChannels: 0,
        existingChannels: 0,
        skippedSessions: 1,
      });

      expect(guild.createCategory).not.toHaveBeenCalled();
      expect(guild.createTextChannel).not.toHaveBeenCalled();
      expect(guild.createThread).not.toHaveBeenCalled();
      expect(controlApi.linkCodexSession).not.toHaveBeenCalled();
      await expect(store.findSessionChannelByDiscordId("pending-fork-thread")).resolves.toMatchObject({
        codexSessionId: null,
        pendingForkSourceSessionId: "source-session",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates channels concurrently within the same workspace", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sync-parallel-"));
    const store = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const firstChannel = deferred<{ id: string }>();
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi
        .fn()
        .mockReturnValueOnce(firstChannel.promise)
        .mockResolvedValueOnce({ id: "channel-b" }),
    };
    const controlApi = {
      createCategoryMapping: vi.fn().mockResolvedValue({}),
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await store.write({
        version: 1,
        archivedCodexSessionIds: [],
        workspaces: [
          {
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: "category-repo",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
        sessionChannels: [],
      });

      const syncPromise = syncCodexSessionsToDiscord({
        guild,
        controlApi,
        stateStore: store,
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        defaultWorkspaceRoot: "/repo",
        sessions: [
          {
            id: "session-a",
            threadName: "First parallel session",
            updatedAt: "2026-04-23T10:00:00.000Z",
            cwdHint: "/repo",
          },
          {
            id: "session-b",
            threadName: "Second parallel session",
            updatedAt: "2026-04-23T10:01:00.000Z",
            cwdHint: "/repo",
          },
        ],
        limit: 25,
      });
      await flushPromises();
      await waitFor(() => guild.createTextChannel.mock.calls.length > 0);

      expect(guild.createTextChannel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "first-parallel-session" }),
      );
      expect(guild.createTextChannel).toHaveBeenCalledWith(
        expect.objectContaining({ name: "second-parallel-session" }),
      );

      firstChannel.resolve({ id: "channel-a" });
      await expect(syncPromise).resolves.toMatchObject({
        createdChannels: 2,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
