import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDirectWorkerStore } from "../../local-agent/src/directWorkerStore.js";
import { deliverClaudeIdleNotifications } from "./claudeIdleNotifications.js";
import type { DiscordMessagePayload } from "./responses.js";

describe("deliverClaudeIdleNotifications", () => {
  it("posts pending idle notifications to the source channel and acks them", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-idle-notify-"));
    const store = createDirectWorkerStore(path.join(tempRoot, "worker"));
    const sent: Array<{ channelId: string; content: string | DiscordMessagePayload }> = [];
    const guild = {
      sendTextMessage: async (channelId: string, content: string | DiscordMessagePayload) => {
        sent.push({ channelId, content });
        return { id: `message-${sent.length}` };
      },
    };

    try {
      await store.initialize();
      await store.appendClaudeSessionNotification({
        at: new Date().toISOString(),
        controlKey: "123456789",
        sessionId: "claude-session-9",
        message: "예약된 점검이 끝났습니다. 결과는 정상입니다.",
        isError: false,
      });

      const first = await deliverClaudeIdleNotifications({ guild, source: store });
      expect(first).toEqual({ pendingChannels: 1, deliveredNotifications: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.channelId).toBe("123456789");
      const payload = sent[0]?.content as DiscordMessagePayload;
      expect(payload.content).toContain("Claude Code 세션 알림");
      expect(payload.content).toContain("claude-session-9");
      expect(payload.embeds?.[0]?.description).toContain("예약된 점검이 끝났습니다");

      const second = await deliverClaudeIdleNotifications({ guild, source: store });
      expect(second).toEqual({ pendingChannels: 0, deliveredNotifications: 0 });
      expect(sent).toHaveLength(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps undelivered records pending when sending fails midway", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-idle-notify-fail-"));
    const store = createDirectWorkerStore(path.join(tempRoot, "worker"));
    let calls = 0;
    const guild = {
      sendTextMessage: async () => {
        calls += 1;
        if (calls > 1) {
          throw new Error("discord unavailable");
        }
        return { id: "message-1" };
      },
    };

    try {
      await store.initialize();
      for (const message of ["첫 번째 알림", "두 번째 알림"]) {
        await store.appendClaudeSessionNotification({
          at: new Date().toISOString(),
          controlKey: "42",
          sessionId: null,
          message,
          isError: false,
        });
      }

      await expect(deliverClaudeIdleNotifications({ guild, source: store })).rejects.toThrow(
        "discord unavailable",
      );

      const pending = await store.readPendingClaudeSessionNotifications();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.records.map((record) => record.message)).toEqual(["두 번째 알림"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("formats Codex background notifications for the same delivery channel", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-idle-notify-"));
    const store = createDirectWorkerStore(path.join(tempRoot, "worker"));
    const sent: Array<{ channelId: string; content: string | DiscordMessagePayload }> = [];
    const guild = {
      sendTextMessage: async (channelId: string, content: string | DiscordMessagePayload) => {
        sent.push({ channelId, content });
        return { id: "message-codex-1" };
      },
    };

    try {
      await store.initialize();
      await store.appendClaudeSessionNotification({
        at: new Date().toISOString(),
        controlKey: "987654321",
        sessionId: "codex-session-7",
        message: "🧹 컨텍스트 자동 압축 완료",
        isError: false,
        agent: "codex",
      });

      await deliverClaudeIdleNotifications({ guild, source: store });

      const payload = sent[0]?.content as DiscordMessagePayload;
      expect(payload.content).toContain("Codex 세션 알림");
      expect(payload.content).toContain("codex-session-7");
      expect(payload.content).not.toContain("Claude Code");
      expect(payload.embeds?.[0]?.description).toContain("🧹 컨텍스트 자동 압축 완료");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
