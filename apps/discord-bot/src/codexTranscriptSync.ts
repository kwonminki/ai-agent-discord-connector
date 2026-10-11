import { isUnknownDiscordChannelError } from "./discordErrors.js";
import { createHash } from "node:crypto";
import { splitDiscordMessageContent, type ConnectorLocale } from "../../../packages/core/src/index.js";
import { syncCodexTranscriptProgress } from "./codexTranscriptProgress.js";
import type {
  CodexSessionContextMessage,
  CodexSessionRealtimeEvent,
  DiscoveredCodexSession,
} from "../../../packages/codex-adapter/src/index.js";
import type { DiscordGuildSurface } from "./codexSessionSync.js";
import type {
  DirectSyncStateStore,
  SyncedSessionChannelState,
  TranscriptSyncMode,
} from "./directState.js";

const MAX_DISCORD_TEXT_LENGTH = 1_900;

export interface SyncCodexSessionTranscriptUpdatesInput {
  guild: Pick<DiscordGuildSurface, "sendTextMessage" | "editTextMessage">;
  stateStore: DirectSyncStateStore;
  sessions: DiscoveredCodexSession[];
  trigger: "on-chat" | "realtime";
  discordChannelId?: string;
  postUpdates?: boolean;
  ignoredSessionIds?: Iterable<string>;
  locale?: ConnectorLocale;
  now?: () => number;
}

export interface SyncCodexSessionTranscriptUpdatesResult {
  mode: TranscriptSyncMode;
  trigger: "on-chat" | "realtime";
  checkedChannels: number;
  updatedChannels: number;
  postedMessages: number;
  skippedByMode: boolean;
}

interface TranscriptMessage {
  key: string;
  role: CodexSessionContextMessage["role"] | "status";
  text: string;
  phase?: CodexSessionRealtimeEvent["phase"];
}

function transcriptMessageKey(message: CodexSessionContextMessage, occurrence: number): string {
  return createHash("sha1")
    .update(`${message.role}\0${message.text.trim()}\0${occurrence}`)
    .digest("hex");
}

function extractTranscriptMessages(session: DiscoveredCodexSession): TranscriptMessage[] {
  if (Array.isArray(session.realtimeEvents) && session.realtimeEvents.length > 0) {
    return session.realtimeEvents
      .filter((event) => event.text.trim().length > 0)
      .map((event) => ({
        key: event.key,
        role: realtimeEventRole(event),
        text: event.text.trim(),
        ...(event.phase ? { phase: event.phase } : {}),
      }));
  }

  const occurrenceByMessage = new Map<string, number>();
  const messages = session.contextPreview?.filter((message) => message.text.trim().length > 0) ?? [];

  return messages.map((message) => {
    const normalizedText = message.text.trim();
    const occurrenceKey = `${message.role}\0${normalizedText}`;
    const occurrence = occurrenceByMessage.get(occurrenceKey) ?? 0;
    occurrenceByMessage.set(occurrenceKey, occurrence + 1);

    return {
      key: transcriptMessageKey({ role: message.role, text: normalizedText }, occurrence),
      role: message.role,
      text: normalizedText,
      ...(message.role === "assistant" ? { phase: "final_answer" as const } : {}),
    };
  });
}

export function latestTranscriptMessageKey(session: DiscoveredCodexSession): string | null {
  return extractTranscriptMessages(session).at(-1)?.key ?? null;
}

function realtimeEventRole(event: CodexSessionRealtimeEvent): TranscriptMessage["role"] {
  switch (event.kind) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    default:
      return "status";
  }
}

function sanitizeDiscordText(value: string): string {
  return value.replace(/@/g, "[at]").trimEnd();
}

function truncateDiscordText(value: string): string {
  if (value.length <= MAX_DISCORD_TEXT_LENGTH) {
    return value;
  }

  const suffix = "\n\n... (일부만 표시)";
  return `${value.slice(0, MAX_DISCORD_TEXT_LENGTH - suffix.length)}${suffix}`;
}

function formatTranscriptUpdateMessage(input: {
  message: TranscriptMessage;
}): string {
  const text = sanitizeDiscordText(input.message.text);

  if (input.message.role === "user") {
    const [firstLine = "", ...remainingLines] = text.split(/\r?\n/);
    const heading = `### ${firstLine}`;
    return truncateDiscordText([heading, ...remainingLines].join("\n").trimEnd());
  }

  if (input.message.role === "assistant") {
    return text;
  }

  return truncateDiscordText(text);
}

function shouldMirrorTranscriptMessage(message: TranscriptMessage): boolean {
  return message.role === "user" ||
    (message.role === "assistant" && message.phase === "commentary");
}

async function postTranscriptDiscordMessage(input: {
  guild: Pick<DiscordGuildSurface, "sendTextMessage">;
  channel: SyncedSessionChannelState;
  message: TranscriptMessage;
}): Promise<number> {
  const chunks = splitDiscordMessageContent(formatTranscriptUpdateMessage({ message: input.message }), MAX_DISCORD_TEXT_LENGTH);
  for (const chunk of chunks) await input.guild.sendTextMessage?.(input.channel.discordChannelId, chunk);
  return chunks.length;
}

function nextChannelState(
  channel: SyncedSessionChannelState,
  session: DiscoveredCodexSession,
  latestMessageKey: string,
): SyncedSessionChannelState {
  return {
    ...channel,
    threadName: session.threadName,
    updatedAt: session.updatedAt,
    cwd: session.cwdHint ?? channel.cwd,
    lastTranscriptMessageKey: latestMessageKey,
    lastTranscriptSyncedAt: new Date().toISOString(),
  };
}

const pendingSyncs = new WeakMap<DirectSyncStateStore, Promise<unknown>>();
export function syncCodexSessionTranscriptUpdates(input: SyncCodexSessionTranscriptUpdatesInput): Promise<SyncCodexSessionTranscriptUpdatesResult> {
  // On-chat and background sync share a cursor. Serialize them to avoid
  // publishing the same public update twice.
  const next = (pendingSyncs.get(input.stateStore) ?? Promise.resolve()).then(() => syncTranscriptUpdates(input));
  pendingSyncs.set(input.stateStore, next.catch(() => undefined));
  return next;
}

async function syncTranscriptUpdates(
  input: SyncCodexSessionTranscriptUpdatesInput,
): Promise<SyncCodexSessionTranscriptUpdatesResult> {
  const state = await input.stateStore.read();
  const mode = state.transcriptSyncMode;

  if (input.trigger === "realtime" && mode !== "realtime") {
    return {
      mode,
      trigger: input.trigger,
      checkedChannels: 0,
      updatedChannels: 0,
      postedMessages: 0,
      skippedByMode: true,
    };
  }

  const ignoredSessionIds = new Set(input.ignoredSessionIds ?? []);
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  let checkedChannels = 0;
  let updatedChannels = 0;
  let postedMessages = 0;
  const changedChannels = new Map<string, SyncedSessionChannelState>();

  const persistChanges = async () => {
    await input.stateStore.update((latestState) => ({
      ...latestState,
      sessionChannels: latestState.sessionChannels.map((channel) => {
        const changedChannel = changedChannels.get(channel.discordChannelId);

        if (
          !changedChannel ||
          changedChannel.codexSessionId?.toLowerCase() !== channel.codexSessionId?.toLowerCase()
        ) {
          return channel;
        }

        return {
          ...channel,
          threadName: changedChannel.threadName,
          updatedAt: changedChannel.updatedAt,
          cwd: changedChannel.cwd,
          lastTranscriptMessageKey: changedChannel.lastTranscriptMessageKey,
          lastTranscriptSyncedAt: changedChannel.lastTranscriptSyncedAt,
          transcriptProgress: changedChannel.transcriptProgress,
        };
      }),
    }));
    changedChannels.clear();
  };

  const sessionChannels = [...state.sessionChannels];

  for (let index = 0; index < sessionChannels.length; index += 1) {
    const channel = sessionChannels[index];

    if (input.discordChannelId && channel.discordChannelId !== input.discordChannelId) {
      continue;
    }

    if (!channel.codexSessionId) {
      continue;
    }

    const session = sessionsById.get(channel.codexSessionId);

    if (!session) {
      continue;
    }

    const transcriptMessages = extractTranscriptMessages(session);
    const latestMessage = transcriptMessages.at(-1);

    if (!latestMessage) {
      continue;
    }

    checkedChannels += 1;

    if (channel.lastTranscriptMessageKey === latestMessage.key && !channel.transcriptProgress) {
      continue;
    }

    const markerIndex = channel.lastTranscriptMessageKey
      ? transcriptMessages.findIndex((message) => message.key === channel.lastTranscriptMessageKey)
      : -1;
    const newMessages = channel.lastTranscriptMessageKey
      ? markerIndex >= 0
        ? transcriptMessages.slice(markerIndex + 1)
        : []
      : [];

    let progress = channel.transcriptProgress;
    if (
      input.guild.sendTextMessage &&
      input.postUpdates !== false &&
      !ignoredSessionIds.has(session.id)
    ) {
      try {
        const result = await syncCodexTranscriptProgress({
          guild: input.guild, channel, session,
          newEventKeys: new Set(newMessages.map(message => message.key)),
          locale: input.locale, now: input.now?.() ?? Date.now(),
        });
        progress = result.progress;
        postedMessages += result.posted;
        if (progress !== channel.transcriptProgress) {
          changedChannels.set(channel.discordChannelId, { ...channel, transcriptProgress: progress });
          await persistChanges();
        }
        for (const message of newMessages.filter(shouldMirrorTranscriptMessage)) {
          postedMessages += await postTranscriptDiscordMessage({ guild: input.guild, channel, message });
          changedChannels.set(channel.discordChannelId, { ...nextChannelState(channel, session, message.key), transcriptProgress: progress });
          await persistChanges();
        }
      } catch (error) {
        if (!isUnknownDiscordChannelError(error)) throw error;
        // A deleted destination must not block other channels or replay history.
        progress = undefined;
      }
    }

    if (channel.lastTranscriptMessageKey === latestMessage.key && progress === channel.transcriptProgress) continue;
    sessionChannels[index] = { ...nextChannelState(channel, session, latestMessage.key), transcriptProgress: progress };
    changedChannels.set(channel.discordChannelId, sessionChannels[index]);
    updatedChannels += 1;
    await persistChanges();
  }


  return {
    mode,
    trigger: input.trigger,
    checkedChannels,
    updatedChannels,
    postedMessages,
    skippedByMode: false,
  };
}
