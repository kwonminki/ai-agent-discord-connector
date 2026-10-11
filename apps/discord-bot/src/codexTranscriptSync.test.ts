import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncCodexSessionTranscriptUpdates } from "./codexTranscriptSync.js";
import { createDirectSyncStateStore } from "./directState.js";

function syncedSessionState() {
  return {
    version: 1 as const,
    transcriptSyncMode: "realtime" as const,
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
  };
}

describe("syncCodexSessionTranscriptUpdates", () => {
  it("baselines an already synced channel without posting old transcript messages", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await stateStore.write(syncedSessionState());

      await expect(
        syncCodexSessionTranscriptUpdates({
          guild: { sendTextMessage },
          stateStore,
          trigger: "realtime",
          sessions: [
            {
              id: "session-1",
              threadName: "Build bridge",
              updatedAt: "2026-04-23T00:02:00.000Z",
              cwdHint: "/repo",
              contextPreview: [
                { role: "user", text: "첫 질문" },
                { role: "assistant", text: "첫 답변" },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({
        checkedChannels: 1,
        updatedChannels: 1,
        postedMessages: 0,
        skippedByMode: false,
      });

      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.findSessionChannelByDiscordId("channel-1")).resolves.toMatchObject({
        lastTranscriptMessageKey: expect.any(String),
        lastTranscriptSyncedAt: expect.any(String),
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("posts IDE commentary that appears after the stored marker", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await stateStore.write(syncedSessionState());
      await syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage },
        stateStore,
        trigger: "realtime",
        sessions: [
          {
            id: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:02:00.000Z",
            cwdHint: "/repo",
            realtimeEvents: [{ key: "event-1", kind: "user", text: "첫 질문" }],
          },
        ],
      });

      await expect(
        syncCodexSessionTranscriptUpdates({
          guild: { sendTextMessage },
          stateStore,
          trigger: "realtime",
          sessions: [
            {
              id: "session-1",
              threadName: "Build bridge",
              updatedAt: "2026-04-23T00:03:00.000Z",
              cwdHint: "/repo",
              realtimeEvents: [
                { key: "event-1", kind: "user", text: "첫 질문" },
                {
                  key: "event-2",
                  kind: "assistant",
                  phase: "commentary",
                  text: "새 설명입니다.",
                },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({
        postedMessages: 1,
        updatedChannels: 1,
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "channel-1",
        expect.stringContaining("새 설명입니다."),
      );
      expect(sendTextMessage.mock.calls[0]?.[1]).toContain("새 설명입니다.");
      expect(sendTextMessage.mock.calls[0]?.[1]).not.toContain("**Codex 답변**");
      expect(sendTextMessage.mock.calls[0]?.[1]).not.toContain("Codex 데스크탑 변경사항 동기화");
      expect(sendTextMessage.mock.calls[0]?.[1]).not.toContain("세션:");
      expect(sendTextMessage.mock.calls[0]?.[1]).not.toContain("최근 업데이트:");
      expect(sendTextMessage.mock.calls[0]?.[1]).not.toContain("사용자: 첫 질문");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("posts each public IDE update separately while skipping tool status and final answers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "sync-message-1" });

    try {
      await stateStore.write(syncedSessionState());
      await syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage },
        stateStore,
        trigger: "realtime",
        sessions: [
          {
            id: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:02:00.000Z",
            cwdHint: "/repo",
            realtimeEvents: [{ key: "event-1", kind: "user", text: "첫 질문" }],
          },
        ],
      });

      sendTextMessage.mockClear();

      await expect(
        syncCodexSessionTranscriptUpdates({
          guild: { sendTextMessage },
          stateStore,
          trigger: "realtime",
          sessions: [
            {
              id: "session-1",
              threadName: "Build bridge",
              updatedAt: "2026-04-23T00:03:00.000Z",
              cwdHint: "/repo",
              realtimeEvents: [
                { key: "event-1", kind: "user", text: "첫 질문" },
                { key: "event-2", kind: "status", text: "파일 탐색 중 · rg --files" },
                {
                  key: "event-3",
                  kind: "assistant",
                  phase: "commentary",
                  text: "파일을 보는 중입니다.",
                },
                { key: "event-4", kind: "user", text: "추가 요청\n두 번째 줄" },
                {
                  key: "event-5",
                  kind: "assistant",
                  phase: "final_answer",
                  text: "최종 답변은 완료 알림에서 보냅니다.",
                },
                {
                  key: "event-6",
                  kind: "assistant",
                  text: "phase가 없는 이전 형식의 답변도 진행 피드에서는 제외합니다.",
                },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({ postedMessages: 2 });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        1,
        "channel-1",
        "파일을 보는 중입니다.",
      );
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        2,
        "channel-1",
        expect.stringContaining("### 추가 요청"),
      );
      const postedContent = JSON.stringify(sendTextMessage.mock.calls);
      expect(postedContent).not.toContain("파일 탐색 중 · rg --files");
      expect(postedContent).not.toContain("최종 답변은 완료 알림에서 보냅니다.");
      expect(postedContent).not.toContain("phase가 없는 이전 형식의 답변도 진행 피드에서는 제외합니다.");

      sendTextMessage.mockClear();

      await syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage },
        stateStore,
        trigger: "realtime",
        sessions: [
          {
            id: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:04:00.000Z",
            cwdHint: "/repo",
            realtimeEvents: [
              { key: "event-1", kind: "user", text: "첫 질문" },
              { key: "event-2", kind: "status", text: "파일 탐색 중 · rg --files" },
              {
                key: "event-3",
                kind: "assistant",
                phase: "commentary",
                text: "파일을 보는 중입니다.",
              },
              { key: "event-4", kind: "user", text: "추가 요청\n두 번째 줄" },
              {
                key: "event-5",
                kind: "assistant",
                phase: "final_answer",
                text: "최종 답변은 완료 알림에서 보냅니다.",
              },
              {
                key: "event-6",
                kind: "assistant",
                text: "phase가 없는 이전 형식의 답변도 진행 피드에서는 제외합니다.",
              },
              {
                key: "event-7",
                kind: "assistant",
                phase: "commentary",
                text: "다음 turn의 추가 설명입니다.",
              },
            ],
          },
        ],
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(
        "channel-1",
        "다음 turn의 추가 설명입니다.",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("baselines instead of replaying old events when the marker fell outside the realtime window", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await stateStore.write(syncedSessionState());
      await syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage },
        stateStore,
        trigger: "realtime",
        sessions: [{
          id: "session-1",
          threadName: "Build bridge",
          updatedAt: "2026-04-23T00:02:00.000Z",
          cwdHint: "/repo",
          realtimeEvents: [{ key: "event-1", kind: "user", text: "첫 질문" }],
        }],
      });

      await expect(syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage },
        stateStore,
        trigger: "realtime",
        sessions: [{
          id: "session-1",
          threadName: "Build bridge",
          updatedAt: "2026-04-23T00:10:00.000Z",
          cwdHint: "/repo",
          realtimeEvents: [{
            key: "event-200",
            kind: "assistant",
            phase: "commentary",
            text: "오래된 구간의 마지막 설명",
          }],
        }],
      })).resolves.toMatchObject({ postedMessages: 0, updatedChannels: 1 });

      expect(sendTextMessage).not.toHaveBeenCalled();
      await expect(stateStore.findSessionChannelByDiscordId("channel-1")).resolves.toMatchObject({
        lastTranscriptMessageKey: "event-200",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips realtime polling while the user selected on-chat mode", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await stateStore.write({
        ...syncedSessionState(),
        transcriptSyncMode: "on-chat",
      });

      await expect(
        syncCodexSessionTranscriptUpdates({
          guild: { sendTextMessage },
          stateStore,
          trigger: "realtime",
          sessions: [
            {
              id: "session-1",
              threadName: "Build bridge",
              updatedAt: "2026-04-23T00:02:00.000Z",
              cwdHint: "/repo",
              contextPreview: [{ role: "assistant", text: "새 답변" }],
            },
          ],
        }),
      ).resolves.toMatchObject({
        checkedChannels: 0,
        postedMessages: 0,
        skippedByMode: true,
      });

      expect(sendTextMessage).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("advances desktop markers but suppresses duplicates for actively streamed Discord sessions", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-transcript-sync-"));
    const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
    const sendTextMessage = vi.fn().mockResolvedValue(undefined);

    try {
      await stateStore.write(syncedSessionState());

      await syncCodexSessionTranscriptUpdates({
        guild: { sendTextMessage },
        stateStore,
        trigger: "realtime",
        sessions: [
          {
            id: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:02:00.000Z",
            cwdHint: "/repo",
            realtimeEvents: [
              { key: "event-1", kind: "user", text: "첫 질문" },
            ],
          },
        ],
      });

      await expect(
        syncCodexSessionTranscriptUpdates({
          guild: { sendTextMessage },
          stateStore,
          trigger: "realtime",
          ignoredSessionIds: ["session-1"],
          sessions: [
            {
              id: "session-1",
              threadName: "Build bridge",
              updatedAt: "2026-04-23T00:03:00.000Z",
              cwdHint: "/repo",
              realtimeEvents: [
                { key: "event-1", kind: "user", text: "첫 질문" },
                { key: "event-2", kind: "status", text: "파일 탐색 중 · rg --files" },
                { key: "event-3", kind: "assistant", phase: "commentary", text: "파일을 보는 중입니다." },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({
        postedMessages: 0,
        updatedChannels: 1,
      });

      expect(sendTextMessage).not.toHaveBeenCalled();

      await expect(
        syncCodexSessionTranscriptUpdates({
          guild: { sendTextMessage },
          stateStore,
          trigger: "realtime",
          sessions: [
            {
              id: "session-1",
              threadName: "Build bridge",
              updatedAt: "2026-04-23T00:03:00.000Z",
              cwdHint: "/repo",
              realtimeEvents: [
                { key: "event-1", kind: "user", text: "첫 질문" },
                { key: "event-2", kind: "status", text: "파일 탐색 중 · rg --files" },
                { key: "event-3", kind: "assistant", phase: "commentary", text: "파일을 보는 중입니다." },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({
        postedMessages: 0,
        updatedChannels: 0,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

it.each([10003, 503])("preserves delivered transcript progress when a later channel fails (%s)", async (code) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "transcript-failure-"));
  const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
  const base = syncedSessionState();
  const channels = [1, 2, 3].map((i) => ({ ...base.sessionChannels[0], codexSessionId: `session-${i}`, discordChannelId: `channel-${i}`, lastTranscriptMessageKey: "old" }));
  const sessions = channels.map((c) => ({ id: c.codexSessionId, threadName: "test", updatedAt: "2026-09-23T00:00:00Z", cwdHint: "/repo", realtimeEvents: [
    { key: "old", kind: "user" as const, text: "old" },
    { key: "new", kind: "assistant" as const, phase: "commentary" as const, text: "new" },
  ] }));
  const sendTextMessage = vi.fn(async (id: string) => {
    if (id === "channel-2") throw Object.assign(new Error("destination failed"), { code });
  });
  const input = { guild: { sendTextMessage }, stateStore, sessions, trigger: "realtime" as const };
  try {
    await stateStore.write({ ...base, sessionChannels: channels });
    if (code === 10003) await syncCodexSessionTranscriptUpdates(input);
    else await expect(syncCodexSessionTranscriptUpdates(input)).rejects.toThrow("destination failed");
    expect((await stateStore.read()).sessionChannels[0].lastTranscriptMessageKey).toBe("new");
    sendTextMessage.mockClear();
    if (code === 10003) {
      await syncCodexSessionTranscriptUpdates(input);
      expect(sendTextMessage).not.toHaveBeenCalled();
      expect((await stateStore.read()).sessionChannels[2].lastTranscriptMessageKey).toBe("new");
    } else {
      await expect(syncCodexSessionTranscriptUpdates(input)).rejects.toThrow();
      expect(sendTextMessage.mock.calls.map(([id]) => id)).toEqual(["channel-2"]);
    }
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

it("retries only unsent transcript messages after a partial channel delivery", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "transcript-partial-"));
  const stateStore = createDirectSyncStateStore(path.join(tempRoot, "state.json"));
  const base = syncedSessionState();
  const sendTextMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
  const input = { guild: { sendTextMessage }, stateStore, trigger: "realtime" as const, sessions: [{ id: "session-1", threadName: "test", updatedAt: "now", cwdHint: "/repo", realtimeEvents: [
    { key: "old", kind: "user" as const, text: "old" },
    { key: "one", kind: "assistant" as const, phase: "commentary" as const, text: "one" },
    { key: "two", kind: "assistant" as const, phase: "commentary" as const, text: "two" },
  ] }] };
  try {
    await stateStore.write({ ...base, sessionChannels: [{ ...base.sessionChannels[0], lastTranscriptMessageKey: "old" }] });
    await expect(syncCodexSessionTranscriptUpdates(input)).rejects.toThrow("network");
    sendTextMessage.mockClear();
    await syncCodexSessionTranscriptUpdates(input);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith("channel-1", "two");
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});
