import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredCodexSession } from "../../../packages/codex-adapter/src/index.js";
import { notifyCodexTaskCompletions } from "./codexTaskNotifications.js";
import { createDirectSyncStateStore } from "./directState.js";
import type { DiscordMessagePayload } from "./responses.js";

function session(input: {
  id?: string;
  threadName?: string;
  completionKey?: string;
  completionTimestamp?: string;
  updatedAt?: string;
  cwdHint?: string | null;
  assistantAnswer?: string;
  realtimeAssistantAnswer?: string;
  realtimeEvents?: DiscoveredCodexSession["realtimeEvents"];
  goalStatus?: DiscoveredCodexSession["goalStatus"];
  forkedFromId?: string;
}): DiscoveredCodexSession {
  const realtimeEvents = [
    ...(input.realtimeEvents ?? []),
    ...(input.realtimeAssistantAnswer
      ? [{ key: "assistant-1", kind: "assistant" as const, text: input.realtimeAssistantAnswer }]
      : []),
    ...(input.completionKey
      ? [{
          key: input.completionKey,
          kind: "status" as const,
          text: "작업 완료",
          ...(input.completionTimestamp ? { timestamp: input.completionTimestamp } : {}),
        }]
      : []),
  ];

  return {
    id: input.id ?? "session-1",
    threadName: input.threadName ?? "Build feature",
    updatedAt: input.updatedAt ?? "2026-04-24T01:00:00.000Z",
    cwdHint: input.cwdHint ?? "/repo",
    ...(input.forkedFromId ? { forkedFromId: input.forkedFromId } : {}),
    ...(input.goalStatus ? { goalStatus: input.goalStatus } : {}),
    contextPreview: input.assistantAnswer
      ? [{ role: "assistant" as const, text: input.assistantAnswer }]
      : [],
    realtimeEvents,
  };
}

describe("notifyCodexTaskCompletions", () => {
  it("baselines existing completed sessions without posting old notifications", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await expect(
        notifyCodexTaskCompletions({
          guild: { sendTextMessage },
          stateStore,
          adminChannelId: "admin-channel",
          sessions: [session({ completionKey: "complete-1" })],
        }),
      ).resolves.toMatchObject({
        checkedSessions: 1,
        completedSessions: 1,
        notifiedSessions: 0,
        initialized: true,
      });

      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.read()).resolves.toMatchObject({
        taskCompletionNotificationsInitializedAt: expect.any(String),
        taskCompletionNotifications: [
          {
            sessionId: "session-1",
            lastTaskCompleteEventKey: "complete-1",
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("posts when a later task completion appears", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });

      await expect(
        notifyCodexTaskCompletions({
          guild: { sendTextMessage },
          stateStore,
          adminChannelId: "admin-channel",
          sessions: [
            session({
              completionKey: "complete-2",
              threadName: "새 기능 구현",
              assistantAnswer: "구현이 끝났고 테스트도 통과했습니다.",
            }),
          ],
        }),
      ).resolves.toMatchObject({
        checkedSessions: 1,
        completedSessions: 1,
        notifiedSessions: 1,
        initialized: false,
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "admin-channel",
        expect.objectContaining({
          content: expect.stringContaining("Codex 작업 완료"),
          embeds: [
            {
              title: "답변",
              color: expect.any(Number),
              description: expect.stringContaining("구현이 끝났고 테스트도 통과했습니다."),
            },
          ],
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  custom_id: "cdc:codex:continue:session-1",
                  label: "이어 작업 요청",
                  style: 1,
                },
              ],
            },
          ],
        }),
      );
      expect(JSON.stringify(sendTextMessage.mock.calls[0]?.[1])).toContain("새 기능 구현");
      await expect(stateStore.read()).resolves.toMatchObject({
        taskCompletionNotifications: [
          {
            sessionId: "session-1",
            lastTaskCompleteEventKey: "complete-2",
            notifiedAt: expect.any(String),
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("posts completion notifications into a synced session thread with role mention options", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const state = await stateStore.read();
      await stateStore.write({
        ...state,
        sessionChannels: [
          {
            codexSessionId: "session-1",
            threadName: "Build feature",
            updatedAt: "2026-04-24T01:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: null,
            discordChannelId: "thread-1",
            discordParentChannelId: "admin-channel",
            discordDeliveryMode: "thread",
            channelName: "build-feature",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2" })],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          content: expect.stringContaining("Codex 작업 완료"),
        }),
        { mentionRoleIds: ["operator-role"] },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("mentions both active-goal intermediate answers and the true completion", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-goal-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const state = await stateStore.read();
      await stateStore.write({
        ...state,
        sessionChannels: [
          {
            codexSessionId: "session-1",
            threadName: "Long goal",
            updatedAt: "2026-04-24T01:00:00.000Z",
            cwd: "/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            discordCategoryId: null,
            discordChannelId: "thread-1",
            discordParentChannelId: "admin-channel",
            discordDeliveryMode: "thread",
            channelName: "long-goal",
            computerId: "local-dev",
            workspaceId: "local-dev:/repo",
          },
        ],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "goal-turn-1",
            assistantAnswer: "첫 단계 결과입니다.",
            goalStatus: "active",
          }),
        ],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenNthCalledWith(
        1,
        "thread-1",
        expect.objectContaining({
          content: expect.stringContaining("Codex 중간 답변"),
          embeds: [expect.objectContaining({ title: "중간 답변" })],
        }),
        { mentionRoleIds: ["operator-role"] },
      );

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "goal-turn-2",
            assistantAnswer: "Goal 전체 작업을 마쳤습니다.",
            goalStatus: "complete",
          }),
        ],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenNthCalledWith(
        2,
        "thread-1",
        expect.objectContaining({
          content: expect.stringContaining("Codex 작업 완료"),
          embeds: [expect.objectContaining({ title: "답변" })],
        }),
        { mentionRoleIds: ["operator-role"] },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("mentions a final IDE survey question instead of duplicating the completion mention", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-question-notification-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const state = await stateStore.read();
      await stateStore.write({
        ...state,
        sessionChannels: [{
          codexSessionId: "session-1",
          threadName: "Build feature",
          updatedAt: "2026-04-24T01:00:00.000Z",
          cwd: "/repo",
          workspaceRoot: "/repo",
          workspaceDisplayName: "repo",
          discordCategoryId: null,
          discordChannelId: "thread-1",
          discordParentChannelId: "admin-channel",
          discordDeliveryMode: "thread",
          channelName: "build-feature",
          computerId: "local-dev",
          workspaceId: "local-dev:/repo",
        }],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({
          completionKey: "complete-2",
          assistantAnswer: [
            "검토가 끝났습니다.",
            "```codex-discord-survey",
            JSON.stringify({
              question: "어느 결과를 선택할까요?",
              options: ["결과 A", "결과 B"],
            }),
            "```",
          ].join("\n"),
        })],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        1,
        "thread-1",
        expect.objectContaining({
          content: expect.stringContaining("Codex 작업 완료"),
        }),
      );
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        2,
        "thread-1",
        expect.objectContaining({
          embeds: [expect.objectContaining({
            title: "미디어 설문",
            description: expect.stringContaining("어느 결과를 선택할까요?"),
          })],
        }),
        { mentionRoleIds: ["operator-role"] },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates a missing session thread without reposting an already-notified completion", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const createThread = vi.fn().mockResolvedValue({ id: "thread-1" });
    const controlApi = {
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "complete-2",
            threadName: "Codex Discord connector 확인",
          }),
        ],
      });
      sendTextMessage.mockClear();

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage, createThread },
        controlApi,
        stateStore,
        adminChannelId: "admin-channel",
        computerId: "local-dev",
        defaultWorkspaceRoot: "/fallback",
        sessions: [
          session({
            completionKey: "complete-2",
            threadName: "Codex Discord connector 확인",
          }),
        ],
        mentionRoleIds: ["operator-role"],
      });

      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Codex Discord connector 확인",
          parentChannelId: "admin-channel",
          autoArchiveDuration: 10_080,
          reason: expect.stringContaining("session-1"),
        }),
      );
      expect(controlApi.createManagedChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          discordChannelId: "thread-1",
          channelMode: "session-linked",
        }),
      );
      expect(controlApi.linkCodexSession).toHaveBeenCalledWith(
        expect.objectContaining({
          discordChannelId: "thread-1",
          codexSessionId: "session-1",
          threadNameSnapshot: "Codex Discord connector 확인",
        }),
      );
      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.findSessionChannelByDiscordId("thread-1")).resolves.toMatchObject({
        codexSessionId: "session-1",
        threadName: "Codex Discord connector 확인",
        discordDeliveryMode: "thread",
        workspaceRoot: "/repo",
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage, createThread },
        controlApi,
        stateStore,
        adminChannelId: "admin-channel",
        computerId: "local-dev",
        defaultWorkspaceRoot: "/fallback",
        sessions: [
          session({
            completionKey: "complete-3",
            threadName: "Codex Discord connector 확인",
          }),
        ],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenCalledWith(
        "thread-1",
        expect.objectContaining({
          content: expect.stringContaining("Codex Discord connector 확인"),
        }),
        { mentionRoleIds: ["operator-role"] },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries the same completion when Discord delivery fails", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage: vi.fn().mockResolvedValue(undefined) },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });

      const sendTextMessage = vi.fn()
        .mockRejectedValueOnce(new Error("temporary Discord failure"))
        .mockResolvedValue(undefined);

      await expect(notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2" })],
      })).rejects.toThrow("temporary Discord failure");

      await expect(stateStore.read()).resolves.toMatchObject({
        taskCompletionNotifications: [],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2" })],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      await expect(stateStore.read()).resolves.toMatchObject({
        taskCompletionNotifications: [
          {
            sessionId: "session-1",
            lastTaskCompleteEventKey: "complete-2",
            notifiedAt: expect.any(String),
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates duplicate completed session records by normalized session id", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({ id: "SESSION-1", completionKey: "complete-2" }),
          session({ id: "session-1", completionKey: "complete-2" }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      await expect(stateStore.read()).resolves.toMatchObject({
        taskCompletionNotifications: [
          {
            lastTaskCompleteEventKey: "complete-2",
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("splits long answers across ordered completion notifications", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const longAnswer = `요약\n${"긴 답변입니다. ".repeat(700)}`;

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2", assistantAnswer: longAnswer })],
      });

      expect(sendTextMessage.mock.calls.length).toBeGreaterThan(2);
      const answerPayloads = sendTextMessage.mock.calls.map((call) => call[1] as DiscordMessagePayload);
      const answerPayload = answerPayloads[0];
      expect(answerPayload).toMatchObject({
        embeds: [
          {
            title: "답변",
            description: expect.stringContaining("요약"),
          },
        ],
      });
      expect(answerPayloads.every((payload) => payload.files === undefined)).toBe(true);
      expect(answerPayloads.slice(1).every((payload) => payload.embeds[0]?.title === "답변 (계속)")).toBe(true);
      expect(answerPayloads.every((payload) => (payload.embeds[0]?.description?.length ?? 0) <= 3_800)).toBe(true);
      expect(answerPayloads.flatMap((payload) => payload.embeds.map((embed) => embed.description ?? "")).join("\n"))
        .toContain("긴 답변입니다.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("attaches files from codex-discord-send blocks in completion notifications", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const videoPath = path.join(tempRoot, "demo.mp4");
    const audioPath = path.join(tempRoot, "demo.wav");

    try {
      await writeFile(videoPath, "fake video");
      await writeFile(audioPath, "fake audio");
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "complete-2",
            assistantAnswer: [
              "테스트 동영상 파일을 만들었습니다.",
              "",
              "```codex-discord-send",
              JSON.stringify({
                message: "테스트용 MP4와 WAV 파일입니다.",
                files: [
                  { path: videoPath, name: "preview.mp4" },
                  { path: audioPath, name: "preview.wav" },
                ],
              }),
              "```",
            ].join("\n"),
          }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      const answerPayload = sendTextMessage.mock.calls[0]?.[1];
      const filePayload = sendTextMessage.mock.calls[1]?.[1];
      expect(answerPayload).toMatchObject({
        embeds: [
          expect.objectContaining({
            title: "답변",
            description: "테스트 동영상 파일을 만들었습니다.\n테스트용 MP4와 WAV 파일입니다.",
          }),
        ],
      });
      expect(answerPayload.files).toBeUndefined();
      expect(filePayload).toMatchObject({
        embeds: [],
        files: [
          { attachment: videoPath, name: "preview.mp4" },
          { attachment: audioPath, name: "preview.wav" },
        ],
      });
      expect(filePayload.content).toBeUndefined();
      expect(JSON.stringify(answerPayload)).not.toContain("codex-discord-send");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("attaches local media markdown links in completion notifications", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-media-link-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const videoPath = path.join(tempRoot, "sample.mp4");

    try {
      await writeFile(videoPath, "fake video");
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "complete-2",
            assistantAnswer: `확인용 영상입니다: [sample overlay](${videoPath})`,
          }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      const answerPayload = sendTextMessage.mock.calls[0]?.[1];
      const filePayload = sendTextMessage.mock.calls[1]?.[1];
      expect(answerPayload).toMatchObject({
        embeds: [
          expect.objectContaining({
            title: "답변",
            description: `확인용 영상입니다: [sample overlay](${videoPath})`,
          }),
        ],
      });
      expect(answerPayload.files).toBeUndefined();
      expect(filePayload).toMatchObject({
        embeds: [],
        files: [{ attachment: videoPath, name: "sample.mp4" }],
      });
      expect(filePayload.content).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("omits answer embeds for sessions requested from Discord", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });
      await stateStore.markDiscordRequestedCodexSession("session-1");

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "complete-2",
            assistantAnswer: "이 답변은 이미 Discord 요청 결과 메시지로 전송되었습니다.",
          }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "admin-channel",
        expect.objectContaining({
          content: expect.stringContaining("Codex 작업 완료"),
          embeds: [],
        }),
      );
      expect(JSON.stringify(sendTextMessage.mock.calls[0]?.[1])).not.toContain("이미 Discord 요청 결과");
      await expect(stateStore.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("only omits the answer once for a Discord-requested session", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });
      await stateStore.markDiscordRequestedCodexSession("session-1");

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "complete-2",
            assistantAnswer: "Discord 요청 결과로 이미 보낸 답변입니다.",
          }),
        ],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "complete-3",
            assistantAnswer: "Mac에서 이어서 끝난 작업 답변입니다.",
          }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(sendTextMessage.mock.calls[0]?.[1]).toMatchObject({ embeds: [] });
      expect(sendTextMessage.mock.calls[1]?.[1]).toMatchObject({
        embeds: [
          expect.objectContaining({
            description: expect.stringContaining("Mac에서 이어서 끝난 작업 답변입니다."),
          }),
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a new Discord request when only its baseline completion is visible", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-1" })],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2", assistantAnswer: "이미 알림 보낸 답변입니다." })],
      });
      sendTextMessage.mockClear();
      await stateStore.markDiscordRequestedCodexSession("session-1");

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2", assistantAnswer: "이미 알림 보낸 답변입니다." })],
      });

      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [
          expect.objectContaining({
            sessionId: "session-1",
            baselineTaskCompleteEventKey: "complete-2",
          }),
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips the polled completion when the direct Discord response already sent a completion mention", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      await stateStore.markDiscordRequestedCodexSession("session-1", { completionMentionSent: true });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2", assistantAnswer: "Discord 요청 답변입니다." })],
        ignoredSessionIds: ["SESSION-1"],
      });

      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [
          {
            sessionId: "session-1",
            requestedAt: expect.any(String),
          },
        ],
        taskCompletionNotifications: [],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2", assistantAnswer: "Discord 요청 답변입니다." })],
      });

      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [],
        taskCompletionNotifications: [
          expect.objectContaining({
            sessionId: "session-1",
            notifiedAt: expect.any(String),
          }),
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not let a legacy session-scoped Discord marker suppress a later IDE completion", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const state = await stateStore.read();
      await stateStore.write({
        ...state,
        discordRequestedCodexSessionRequests: [
          {
            sessionId: "session-1",
            requestedAt: "2026-08-20T06:33:38.320Z",
            discordChannelId: "thread-1",
            completionMentionSent: true,
          },
        ],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "ide-complete-1",
            completionTimestamp: "2026-08-21T00:18:37.430Z",
            updatedAt: "2026-08-21T00:18:37.430Z",
            assistantAnswer: "IDE에서 끝난 최종 답변입니다.",
          }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "admin-channel",
        expect.objectContaining({
          embeds: [
            expect.objectContaining({
              description: expect.stringContaining("IDE에서 끝난 최종 답변입니다."),
            }),
          ],
        }),
      );
      await expect(stateStore.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [],
        taskCompletionNotifications: [
          expect.objectContaining({
            lastTaskCompleteEventKey: "ide-complete-1",
            notifiedAt: expect.any(String),
          }),
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("scopes a delivered Discord completion marker to events no later than its delivery time", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      await stateStore.markDiscordRequestedCodexSession("session-1", {
        completionMentionSent: true,
      });
      const request = (await stateStore.read()).discordRequestedCodexSessionRequests[0];
      const sentAtMs = Date.parse(request?.completionMentionSentAt ?? "");
      const laterCompletionAt = new Date(sentAtMs + 60_000).toISOString();

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [
          session({
            completionKey: "ide-complete-later",
            completionTimestamp: laterCompletionAt,
            updatedAt: laterCompletionAt,
            assistantAnswer: "다음 IDE 턴의 최종 답변입니다.",
          }),
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sendTextMessage.mock.calls[0]?.[1])).toContain("다음 IDE 턴의 최종 답변입니다.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("baselines copied completion events while an explicit fork owns the new session", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-pending-fork-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);
    const createThread = vi.fn().mockResolvedValue({ id: "unexpected-thread" });
    const controlApi = {
      createManagedChannel: vi.fn().mockResolvedValue({}),
      linkCodexSession: vi.fn().mockResolvedValue({}),
    };

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage, createThread },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const initialized = await stateStore.read();
      await stateStore.write({
        ...initialized,
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

      await expect(notifyCodexTaskCompletions({
        guild: { sendTextMessage, createThread },
        controlApi,
        stateStore,
        adminChannelId: "admin-channel",
        computerId: "local-dev",
        defaultWorkspaceRoot: "/repo",
        sessions: [session({
          id: "fork-session",
          forkedFromId: "source-session",
          completionKey: "copied-source-completion",
          assistantAnswer: "원본 세션의 과거 답변",
        })],
      })).resolves.toMatchObject({
        completedSessions: 1,
        notifiedSessions: 0,
      });

      expect(createThread).not.toHaveBeenCalled();
      expect(sendTextMessage).not.toHaveBeenCalled();
      expect(controlApi.linkCodexSession).not.toHaveBeenCalled();
      await expect(stateStore.read()).resolves.toMatchObject({
        sessionChannels: [expect.objectContaining({
          discordChannelId: "pending-fork-thread",
          codexSessionId: null,
        })],
        taskCompletionNotifications: [expect.objectContaining({
          sessionId: "fork-session",
          lastTaskCompleteEventKey: "copied-source-completion",
          notifiedAt: null,
        })],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the linked session thread when a requested fork channel was deleted", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-stale-request-channel-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const initialized = await stateStore.read();
      await stateStore.write({
        ...initialized,
        sessionChannels: [{
          codexSessionId: "fork-session",
          threadName: "Recovered Harness Builder",
          updatedAt: "2026-09-05T19:23:11.274Z",
          cwd: "/repo",
          workspaceRoot: "/repo",
          workspaceDisplayName: "repo",
          discordCategoryId: null,
          discordChannelId: "linked-fork-thread",
          discordParentChannelId: "admin-channel",
          discordDeliveryMode: "thread",
          channelMode: "session-linked",
          channelName: "recovered-harness-builder",
          computerId: "local-dev",
          workspaceId: "local-dev:/repo",
        }],
        discordRequestedCodexSessionRequests: [{
          sessionId: "fork-session",
          requestedAt: "2026-09-05T19:23:11.506Z",
          discordChannelId: "deleted-pending-thread",
        }],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({
          id: "fork-session",
          completionKey: "fork-complete",
          completionTimestamp: "2026-09-05T19:23:43.458Z",
          updatedAt: "2026-09-05T19:23:43.458Z",
          assistantAnswer: "복구된 Builder 답변",
        })],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenCalledWith(
        "linked-fork-thread",
        expect.objectContaining({ content: expect.stringContaining("Codex 작업 완료") }),
        { mentionRoleIds: ["operator-role"] },
      );
      expect(sendTextMessage).not.toHaveBeenCalledWith(
        "deleted-pending-thread",
        expect.anything(),
        expect.anything(),
      );
      await expect(stateStore.read()).resolves.toMatchObject({
        discordRequestedCodexSessionRequests: [],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes a Discord-requested completion to its recorded channel even if legacy state has duplicate links", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });
      const state = await stateStore.read();
      const linkedChannel = (discordChannelId: string) => ({
        codexSessionId: "session-1",
        threadName: discordChannelId,
        updatedAt: "2026-07-21T00:00:00.000Z",
        cwd: "/repo",
        workspaceRoot: "/repo",
        workspaceDisplayName: "repo",
        discordCategoryId: null,
        discordChannelId,
        discordParentChannelId: "admin-channel",
        discordDeliveryMode: "thread" as const,
        channelMode: "session-linked" as const,
        channelName: discordChannelId,
        computerId: "local-dev",
        workspaceId: "local-dev:/repo",
      });
      await stateStore.write({
        ...state,
        sessionChannels: [linkedChannel("source-thread"), linkedChannel("fork-thread")],
      });
      await stateStore.markDiscordRequestedCodexSession("session-1", {
        discordChannelId: "fork-thread",
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ completionKey: "complete-2", assistantAnswer: "Discord fork 답변입니다." })],
        mentionRoleIds: ["operator-role"],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "fork-thread",
        expect.objectContaining({
          content: expect.stringContaining("Codex 작업 완료"),
          embeds: [],
        }),
        { mentionRoleIds: ["operator-role"] },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("posts the first completion for a new session after the baseline is initialized", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-task-notifications-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [],
      });

      await notifyCodexTaskCompletions({
        guild: { sendTextMessage },
        stateStore,
        adminChannelId: "admin-channel",
        sessions: [session({ id: "session-2", completionKey: "complete-new" })],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage.mock.calls[0]?.[0]).toBe("admin-channel");
      expect(JSON.stringify(sendTextMessage.mock.calls[0]?.[1])).toContain("session-2");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
