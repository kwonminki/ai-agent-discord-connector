import type { ConnectorLocale } from "../../../packages/core/src/index.js";
import type { DiscoveredCodexSession } from "../../../packages/codex-adapter/src/index.js";
import type { DiscordGuildSurface } from "./codexSessionSync.js";
import type { SyncedSessionChannelState } from "./directState.js";
import type { DiscordMessagePayload } from "./responses.js";

// A missing completion (for example after an app crash) must not leave an
// indefinite thinking indicator. This is uncertainty, not a task failure.
export const TRANSCRIPT_PROGRESS_STALE_MS = 30 * 60_000;

export async function syncCodexTranscriptProgress(input: {
  guild: Pick<DiscordGuildSurface, "sendTextMessage" | "editTextMessage">;
  channel: SyncedSessionChannelState;
  session: DiscoveredCodexSession;
  newEventKeys: Set<string>;
  locale?: ConnectorLocale;
  now: number;
}): Promise<{ progress: SyncedSessionChannelState["transcriptProgress"]; posted: number }> {
  const { channel, session, guild } = input;
  const previous = channel.transcriptProgress?.sessionId === session.id ? channel.transcriptProgress : undefined;
  const events = session.realtimeEvents ?? [];
  const lifecycle = [...events].reverse().find(event => event.turnStatus) ??
    (previous && (previous.status === "running" || previous.status === "stale")
      ? { key: previous.eventKey, turnStatus: "running" as const, text: "" }
      : undefined);
  if (!lifecycle) return { progress: previous, posted: 0 };

  const lastAt = Date.parse(events.at(-1)?.timestamp ?? session.updatedAt);
  const stale = !Number.isFinite(lastAt) || input.now - lastAt > TRANSCRIPT_PROGRESS_STALE_MS;
  const status = lifecycle.turnStatus === "running" && stale ? "stale" : lifecycle.turnStatus!;
  // Baseline old history silently. Existing cards may still be reconciled after
  // a Gateway restart or after the transcript cursor advances elsewhere.
  if (!previous && (status !== "running" || !input.newEventKeys.has(lifecycle.key))) {
    return { progress: undefined, posted: 0 };
  }
  if (previous?.eventKey === lifecycle.key && previous.status === status) return { progress: previous, posted: 0 };

  const en = input.locale === "en";
  const description = {
    running: en ? "⏳ Thinking / working…" : "⏳ 생각 중 · 작업 진행 중…",
    completed: lifecycle.text === "작업 종료" ? (en ? "⏹ Task ended" : "⏹ 작업 종료") : (en ? "✅ Task finished" : "✅ 작업 완료"),
    interrupted: en ? "⏹ Task interrupted" : "⏹ 작업 중단",
    stale: en ? "⚪ No recent status. Check the app or Orca." : "⚪ 상태 확인 지연 · 앱이나 Orca에서 현재 상태를 확인해 주세요.",
  }[status];
  const payload: DiscordMessagePayload = { allowedMentions: { parse: [] }, embeds: [{ title: "Codex", description, color: status === "running" ? 0x3498db : 0x95a5a6 }] };
  let messageId = previous?.messageId;
  let posted = 0;
  // Keep each turn's card together; after completion, a new turn gets a new card.
  if (status === "running" && previous?.status !== "running" && previous?.status !== "stale") messageId = undefined;
  if (messageId && guild.editTextMessage) {
    try { await guild.editTextMessage(channel.discordChannelId, messageId, payload); }
    catch (error) {
      if ((error as { code?: number }).code !== 10008) throw error;
      messageId = undefined;
    }
  } else if (messageId) {
    return { progress: previous, posted: 0 };
  }
  if (!messageId && status === "running" && guild.sendTextMessage) {
    const sent = await guild.sendTextMessage(channel.discordChannelId, payload);
    messageId = sent?.id;
    posted = 1;
  }
  return { progress: { sessionId: session.id, eventKey: lifecycle.key, status, ...(messageId ? { messageId } : {}) }, posted };
}
