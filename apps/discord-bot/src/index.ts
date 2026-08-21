import os from "node:os";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { DiscoveredCodexSession } from "../../../packages/codex-adapter/src/index.js";
import {
  resolveConnectorLocale,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";
import { createAnswerCopyStore, type AnswerCopyStore } from "./answerCopyStore.js";
import { createAgentRelayPresenceStore } from "./agentRelayPresence.js";
import { agentKindForContext } from "./agentSettingsController.js";
import { DISCORD_APPLICATION_COMMANDS } from "./applicationCommands.js";
import {
  createForkedDiscordSessionThread,
  createNewCodexChatChannel,
  discardPendingDiscordSessionThread,
  ensureConnectorMaintenanceThread,
  linkPendingNewCodexChatSession,
  type ConnectorMaintenanceThreadResult,
} from "./codexNewChat.js";
import { archiveSyncedCodexSession } from "./codexSessionArchive.js";
import {
  deleteSyncedDiscordSessions,
  previewSyncedDiscordSessionDelete,
  type SyncedDeleteMode,
} from "./codexSessionDelete.js";
import {
  syncCodexSessionsToDiscord,
  type DiscordGuildSurface,
  type SyncCodexSessionsProgress,
} from "./codexSessionSync.js";
import { syncCodexSessionTranscriptUpdates } from "./codexTranscriptSync.js";
import { notifyCodexTaskCompletions } from "./codexTaskNotifications.js";
import {
  discoverClaudeCodeSessions,
  listResumableClaudeSessions,
  resumeClaudeCodeSessionThread,
  syncClaudeCodeSessionsToDiscord,
  type DiscoveredClaudeCodeSession,
} from "./claudeSessionSync.js";
import {
  DEFAULT_CLAUDE_COMPLETION_IDLE_MS,
  notifyClaudeCodeTaskCompletions,
} from "./claudeTaskNotifications.js";
import { deliverClaudeIdleNotifications } from "./claudeIdleNotifications.js";
import { loadConnectConfig } from "./connectConfig.js";
import { createControlApiClient } from "./controlApiClient.js";
import { createDirectSyncStateStore } from "./directState.js";
import { createDirectControlClient } from "./directControlClient.js";
import { createDirectWorkerClient } from "./directWorkerClient.js";
import { createDurableDiscordRequestStore } from "./durableRequestStore.js";
import {
  appendDiscordAttachmentsToPrompt,
  createIncomingAttachmentStore,
} from "./incomingAttachments.js";
import {
  attachDiscordInteractionHandler,
  attachDiscordMessageHandler,
  createDiscordGuildSurface,
  createDiscordClient,
  registerDiscordApplicationCommands,
} from "./discordClient.js";
import { createDiscordMessageHandler } from "./messageHandler.js";
import type { BotReloadExecutionState, DiscordOutgoingMessage } from "./messageHandler.js";
import {
  loadCodexModelChoices,
  modelAutocompleteChoices,
} from "./modelAutocomplete.js";
import { manageScheduledCommand, runDueScheduledCommands } from "./scheduler.js";

export const BOT_RELOAD_EXIT_CODE = 42;
const DEFAULT_TRANSCRIPT_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_TASK_NOTIFICATION_INTERVAL_MS = 3_000;
const DEFAULT_CLAUDE_SESSION_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_CLAUDE_IDLE_NOTIFICATION_INTERVAL_MS = 5_000;
const DEFAULT_CLAUDE_SESSION_SYNC_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLAUDE_SESSION_SYNC_LIMIT = 10;
const DEFAULT_SCHEDULE_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BACKGROUND_POLL_MAX_INTERVAL_MS = 20_000;
const DEFAULT_BACKGROUND_MAX_NORMALIZED_LOAD = 0.7;

export function linkedCodexSessionIds(
  sessionChannels: Array<{ codexSessionId?: string | null }>,
): string[] {
  return [
    ...new Set(
      sessionChannels
        .map((channel) => channel.codexSessionId?.trim() ?? "")
        .filter((sessionId) => sessionId.length > 0),
    ),
  ];
}

export function resolveRealtimeIntervalMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }

  return Math.min(Math.max(parsed, 500), 60_000);
}

export function resolveBackgroundMaxNormalizedLoad(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (parsed <= 0) {
    return 0;
  }

  return Math.min(Math.max(parsed, 0.1), 4);
}

function resolveBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function identifierList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

let packageVersionPromise: Promise<string> | null = null;

function connectorPackageVersion(): Promise<string> {
  packageVersionPromise ??= readFile(new URL("../../../package.json", import.meta.url), "utf8")
    .then((content) => {
      const version = (JSON.parse(content) as { version?: unknown }).version;
      return typeof version === "string" && version.trim() ? version.trim() : "unknown";
    })
    .catch(() => process.env.npm_package_version?.trim() || "unknown");
  return packageVersionPromise;
}

function maintenanceAgent(input: string | undefined): "codex" | "claude" {
  return input?.trim().toLowerCase() === "claude" ? "claude" : "codex";
}

export function shouldSkipBackgroundPolling(input: {
  loadAverage: number;
  cpuCount: number;
  maxNormalizedLoad: number;
}): boolean {
  if (input.maxNormalizedLoad <= 0 || input.cpuCount <= 0 || input.loadAverage <= 0) {
    return false;
  }

  return input.loadAverage / input.cpuCount >= input.maxNormalizedLoad;
}

export function shouldDeferBotRestart(execution: BotReloadExecutionState): boolean {
  return execution.activeCount > 0 || execution.pendingCount > 0;
}

export interface BackgroundPollState {
  nextRunAt: number;
  currentIntervalMs: number;
}

export function createBackgroundPollState(now: number, baseIntervalMs: number): BackgroundPollState {
  return {
    nextRunAt: now,
    currentIntervalMs: baseIntervalMs,
  };
}

export function shouldRunBackgroundPoll(state: BackgroundPollState, now: number): boolean {
  return now >= state.nextRunAt;
}

export function recordBackgroundPollResult(
  state: BackgroundPollState,
  input: {
    now: number;
    baseIntervalMs: number;
    maxIntervalMs: number;
    changed: boolean;
    skippedForLoad?: boolean;
  },
): void {
  const maxIntervalMs = Math.max(input.baseIntervalMs, input.maxIntervalMs);
  const nextIntervalMs =
    input.changed && !input.skippedForLoad
      ? input.baseIntervalMs
      : Math.min(maxIntervalMs, Math.max(input.baseIntervalMs, state.currentIntervalMs * 2));

  state.currentIntervalMs = nextIntervalMs;
  state.nextRunAt = input.now + nextIntervalMs;
}

export function shouldRunRealtimeSessionAutosync(input: {
  mode: "on-chat" | "realtime";
  now: number;
  lastAutoSyncAt: number;
  intervalMs: number;
}): boolean {
  void input;
  return false;
}

const TRANSCRIPT_SYNC_INTERVAL_MS = resolveRealtimeIntervalMs(
  process.env.CONNECT_TRANSCRIPT_SYNC_INTERVAL_MS,
  DEFAULT_TRANSCRIPT_SYNC_INTERVAL_MS,
);
const TASK_NOTIFICATION_INTERVAL_MS = resolveRealtimeIntervalMs(
  process.env.CONNECT_TASK_NOTIFICATION_INTERVAL_MS,
  DEFAULT_TASK_NOTIFICATION_INTERVAL_MS,
);
const CLAUDE_SESSION_SYNC_INTERVAL_MS = resolveRealtimeIntervalMs(
  process.env.CONNECT_CLAUDE_SESSION_SYNC_INTERVAL_MS,
  DEFAULT_CLAUDE_SESSION_SYNC_INTERVAL_MS,
);
const CLAUDE_IDLE_NOTIFICATION_INTERVAL_MS = resolveRealtimeIntervalMs(
  process.env.CONNECT_CLAUDE_IDLE_NOTIFICATION_INTERVAL_MS,
  DEFAULT_CLAUDE_IDLE_NOTIFICATION_INTERVAL_MS,
);
const CLAUDE_SESSION_SYNC_LOOKBACK_MS = resolveBoundedInteger(
  process.env.CONNECT_CLAUDE_SESSION_SYNC_LOOKBACK_MS,
  DEFAULT_CLAUDE_SESSION_SYNC_LOOKBACK_MS,
  60_000,
  7 * 24 * 60 * 60 * 1_000,
);
const CLAUDE_SESSION_SYNC_LIMIT = resolveBoundedInteger(
  process.env.CONNECT_CLAUDE_SESSION_SYNC_LIMIT,
  DEFAULT_CLAUDE_SESSION_SYNC_LIMIT,
  1,
  50,
);
const CLAUDE_COMPLETION_IDLE_MS = resolveBoundedInteger(
  process.env.CONNECT_CLAUDE_COMPLETION_IDLE_MS,
  DEFAULT_CLAUDE_COMPLETION_IDLE_MS,
  5_000,
  60 * 60 * 1_000,
);
const SCHEDULE_POLL_INTERVAL_MS = resolveRealtimeIntervalMs(
  process.env.CONNECT_SCHEDULE_POLL_INTERVAL_MS,
  DEFAULT_SCHEDULE_POLL_INTERVAL_MS,
);
const BACKGROUND_POLL_MAX_INTERVAL_MS = resolveRealtimeIntervalMs(
  process.env.CONNECT_BACKGROUND_POLL_MAX_INTERVAL_MS,
  DEFAULT_BACKGROUND_POLL_MAX_INTERVAL_MS,
);
const BACKGROUND_MAX_NORMALIZED_LOAD = resolveBackgroundMaxNormalizedLoad(
  process.env.CONNECT_BACKGROUND_MAX_LOAD,
  DEFAULT_BACKGROUND_MAX_NORMALIZED_LOAD,
);

function currentBackgroundLoadInput(): { loadAverage: number; cpuCount: number; maxNormalizedLoad: number } {
  return {
    loadAverage: os.loadavg()[0] ?? 0,
    cpuCount: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    maxNormalizedLoad: BACKGROUND_MAX_NORMALIZED_LOAD,
  };
}

function outgoingMessageToText(message: DiscordOutgoingMessage): string {
  if (typeof message === "string") {
    return message;
  }

  const lines = [
    message.content,
    ...(message.embeds ?? []).flatMap((embed) => [
      embed.title,
      embed.description,
      ...(embed.fields ?? []).flatMap((field) => [`${field.name}:`, field.value]),
    ]),
  ].filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  const text = lines.join("\n");

  return text.length <= 1_900 ? text : `${text.slice(0, 1_875)}\n... (일부만 표시)`;
}

function resolveReadyGuildSurface(
  client: ReturnType<typeof createDiscordClient>,
  guildId?: string,
  answerCopyStore?: AnswerCopyStore,
  locale: ConnectorLocale = "ko",
): DiscordGuildSurface | null {
  const cache = client.guilds?.cache;
  if (!cache) {
    return null;
  }
  const guild = guildId ? cache.get(guildId) : cache.first();

  return createDiscordGuildSurface(guild ?? null, { answerCopyStore, locale });
}

export async function startBot(): Promise<void> {
  const connectConfig = await loadConnectConfig();
  const token = process.env.DISCORD_TOKEN ?? connectConfig?.discord.token;
  const locale = resolveConnectorLocale(
    process.env.CONNECT_LOCALE ?? connectConfig?.discord.locale,
  );

  if (!token) {
    throw new Error("DISCORD_TOKEN is required");
  }

  const client = createDiscordClient();
  const startedAt = new Date().toISOString();
  const requestedMode = connectConfig?.mode ?? process.env.CONNECT_MODE;
  const directStateStore = connectConfig?.mode === "direct" ? createDirectSyncStateStore() : null;
  const directWorkerClient = connectConfig?.mode === "direct" ? createDirectWorkerClient() : null;
  const durableRequestStore = connectConfig?.mode === "direct" ? createDurableDiscordRequestStore() : null;
  const incomingAttachmentStore = connectConfig?.mode === "direct" ? createIncomingAttachmentStore() : null;
  const relayPresenceStore = connectConfig?.mode === "direct" ? createAgentRelayPresenceStore() : null;
  const answerCopyStore = createAnswerCopyStore();
  const activelyStreamedSessionIds = new Set<string>();
  let connectorMaintenanceThreadPromise: Promise<ConnectorMaintenanceThreadResult> | null = null;

  if (requestedMode === "direct" && connectConfig?.mode !== "direct") {
    throw new Error("Direct mode requires .connect/config.json. Run `pnpm connect setup --direct`.");
  }

  const controlApiClient =
    connectConfig?.mode === "direct"
      ? createDirectControlClient(connectConfig, {
          stateStore: directStateStore ?? undefined,
          workerClient: directWorkerClient,
        })
      : createControlApiClient({
            baseUrl:
            connectConfig?.mode === "hub"
              ? connectConfig.hub.controlApiUrl
              : process.env.CONTROL_API_URL ?? "http://127.0.0.1:4317",
        });
  const listDirectCodexSessions =
    connectConfig?.mode === "direct"
      ? async (
          options: {
            activeOnly?: boolean;
            includeExecSessions?: boolean;
            includeSessionIds?: string[];
          } = {},
        ): Promise<DiscoveredCodexSession[]> => {
          const response = await controlApiClient.listCodexSessions({
            computerId: connectConfig.direct.computerId,
            codexHome: connectConfig.direct.codexHome,
            activeOnly: options.activeOnly,
            includeExecSessions: options.includeExecSessions,
            includeSessionIds: options.includeSessionIds,
          });

          if ("error" in response) {
            throw new Error(response.error.message);
          }

          return response.result as DiscoveredCodexSession[];
        }
      : undefined;
  const syncCodexSessions =
    connectConfig?.mode === "direct" && directStateStore
      ? async (input: {
          guild: DiscordGuildSurface;
          limit: number;
          sessionIds?: string[];
          onProgress?: (progress: SyncCodexSessionsProgress) => Promise<void> | void;
        }) => {
          const sessions = await listDirectCodexSessions?.();

          if (!sessions) {
            throw new Error("Direct Codex session listing is not connected.");
          }

          const selectedSessionIds = input.sessionIds ? new Set(input.sessionIds) : null;
          const syncSessions = selectedSessionIds
            ? sessions.filter((session) => selectedSessionIds.has(session.id))
            : sessions;

          return syncCodexSessionsToDiscord({
            guild: input.guild,
            controlApi: controlApiClient,
            stateStore: directStateStore,
            computerId: connectConfig.direct.computerId,
            computerDisplayName: connectConfig.direct.computerDisplayName,
            defaultWorkspaceRoot: connectConfig.direct.workspaceRoot,
            sessions: syncSessions,
            limit: input.limit,
            sessionThreadParentChannelId: connectConfig.direct.channelId,
            mentionRoleIds: connectConfig.discord.allowedRoleIds,
            onProgress: input.onProgress,
          });
        }
      : undefined;
  const previewSelectableCodexSessions =
    connectConfig?.mode === "direct" && directStateStore
      ? async (input: { limit: number }) => {
          const sessions = await listDirectCodexSessions?.();

          if (!sessions) {
            throw new Error("Direct Codex session listing is not connected.");
          }

          const state = await directStateStore.read();
          const archivedSessionIds = new Set(state.archivedCodexSessionIds);
          const activeSessions = sessions.filter((session) => !archivedSessionIds.has(session.id));
          const limit = Math.min(input.limit, 25);

          return {
            sessions: activeSessions.slice(0, limit).map((session) => ({
              id: session.id,
              threadName: session.threadName,
              updatedAt: session.updatedAt,
              workspaceDisplayName:
                session.cwdHint?.split("/").filter(Boolean).at(-1) ?? connectConfig.direct.workspaceDisplayName,
            })),
            totalAvailable: activeSessions.length,
            limit,
          };
        }
      : undefined;
  const syncTranscriptUpdates =
    connectConfig?.mode === "direct" && directStateStore
      ? async (input: {
          guild: DiscordGuildSurface;
          discordChannelId?: string;
          trigger: "on-chat" | "realtime";
          postUpdates?: boolean;
        }) => {
          const state = await directStateStore.read();

          if (input.trigger === "realtime" && state.transcriptSyncMode !== "realtime") {
            return {
              mode: state.transcriptSyncMode,
              trigger: input.trigger,
              checkedChannels: 0,
              updatedChannels: 0,
              postedMessages: 0,
              skippedByMode: true,
            };
          }

          const linkedSessionIds = linkedCodexSessionIds(state.sessionChannels);

          if (linkedSessionIds.length === 0) {
            return {
              mode: state.transcriptSyncMode,
              trigger: input.trigger,
              checkedChannels: 0,
              updatedChannels: 0,
              postedMessages: 0,
              skippedByMode: false,
            };
          }

          const sessions = await listDirectCodexSessions?.({
            activeOnly: false,
            includeExecSessions: true,
            includeSessionIds: linkedSessionIds,
          });

          if (!sessions) {
            throw new Error("Direct Codex session listing is not connected.");
          }

          return syncCodexSessionTranscriptUpdates({
            guild: input.guild,
            stateStore: directStateStore,
            sessions,
            trigger: input.trigger,
            discordChannelId: input.discordChannelId,
            postUpdates: input.postUpdates,
            ignoredSessionIds: activelyStreamedSessionIds,
          });
        }
      : undefined;
  const notifyTaskCompletions =
    connectConfig?.mode === "direct" && directStateStore
      ? async (input: { guild: DiscordGuildSurface }) => {
          const state = await directStateStore.read();
          const linkedSessionIds = linkedCodexSessionIds(state.sessionChannels);
          const sessions = await listDirectCodexSessions?.({
            activeOnly: false,
            includeExecSessions: true,
            includeSessionIds: linkedSessionIds,
          });

          if (!sessions) {
            throw new Error("Direct Codex session listing is not connected.");
          }

          return notifyCodexTaskCompletions({
            guild: input.guild,
            controlApi: controlApiClient,
            stateStore: directStateStore,
            adminChannelId: connectConfig.direct.channelId,
            computerId: connectConfig.direct.computerId,
            defaultWorkspaceRoot: connectConfig.direct.workspaceRoot,
            sessions,
            mentionRoleIds: connectConfig.discord.allowedRoleIds,
            ignoredSessionIds: activelyStreamedSessionIds,
          });
      }
      : undefined;
  const syncClaudeCodeSessions =
    connectConfig?.mode === "direct" && directStateStore && connectConfig.direct.claudeChannelId?.trim()
      ? async (input: { guild: DiscordGuildSurface; sessions?: DiscoveredClaudeCodeSession[] }) =>
          syncClaudeCodeSessionsToDiscord({
            guild: input.guild,
            controlApi: controlApiClient,
            stateStore: directStateStore,
            computerId: connectConfig.direct.computerId,
            computerDisplayName: connectConfig.direct.computerDisplayName,
            parentChannelId: connectConfig.direct.claudeChannelId?.trim() ?? "",
            mentionRoleIds: connectConfig.discord.allowedRoleIds,
            lookbackMs: CLAUDE_SESSION_SYNC_LOOKBACK_MS,
            limit: CLAUDE_SESSION_SYNC_LIMIT,
            sessions: input.sessions,
          })
      : undefined;
  const notifyClaudeCodeCompletions =
    connectConfig?.mode === "direct" && directStateStore && connectConfig.direct.claudeChannelId?.trim()
      ? async (input: { guild: DiscordGuildSurface; sessions?: DiscoveredClaudeCodeSession[] }) => {
          return notifyClaudeCodeTaskCompletions({
            guild: input.guild,
            stateStore: directStateStore,
            sessions:
              input.sessions ??
              await discoverClaudeCodeSessions({
                updatedAfter: new Date(Date.now() - CLAUDE_SESSION_SYNC_LOOKBACK_MS),
              }),
            mentionRoleIds: connectConfig.discord.allowedRoleIds,
            idleMs: CLAUDE_COMPLETION_IDLE_MS,
          });
        }
      : undefined;
  const getSyncStatus =
    directStateStore
      ? async () => {
          const state = await directStateStore.read();

          return {
            workspaceCount: state.workspaces.length,
            sessionChannelCount: state.sessionChannels.length,
            archivedSessionCount: state.archivedCodexSessionIds.length,
            contextPostedCount: state.sessionChannels.filter((channel) => Boolean(channel.contextPostedAt)).length,
            transcriptSyncMode: state.transcriptSyncMode,
            transcriptSyncedChannelCount: state.sessionChannels.filter((channel) =>
              Boolean(channel.lastTranscriptMessageKey),
            ).length,
          };
      }
      : undefined;
  const setTranscriptSyncMode =
    directStateStore
      ? async (mode: "on-chat" | "realtime") => {
          await directStateStore.updateTranscriptSyncMode(mode);
          return { mode };
        }
      : undefined;
  const reloadBot = async (input: {
    mode: "commands" | "restart";
    execution: BotReloadExecutionState;
    force: boolean;
  }) => {
    await registerDiscordApplicationCommands(client, connectConfig?.discord.guildId, locale);
    const workerExecution = await directWorkerClient?.executionState();
    const execution = workerExecution
      ? {
          activeCount: Math.max(input.execution.activeCount, workerExecution.activeCount),
          pendingCount: Math.max(input.execution.pendingCount, workerExecution.pendingCount),
        }
      : input.execution;
    const deferred = input.mode === "restart" && !input.force && shouldDeferBotRestart(execution);

    if (input.mode === "restart" && !deferred) {
      setTimeout(() => {
        process.exit(BOT_RELOAD_EXIT_CODE);
      }, 1_500).unref();
    }

    return {
      mode: input.mode,
      commandCount: DISCORD_APPLICATION_COMMANDS.length,
      restarting: input.mode === "restart" && !deferred,
      deferred,
      forced: input.mode === "restart" && input.force,
      activeCount: execution.activeCount,
      pendingCount: execution.pendingCount,
      startedAt,
    };
  };
  const previewSyncedChannelsDelete =
    directStateStore
      ? async (input: { mode: SyncedDeleteMode; sessionId?: string | null }) =>
          previewSyncedDiscordSessionDelete({
            stateStore: directStateStore,
            mode: input.mode,
            sessionId: input.sessionId,
          })
      : undefined;
  const deleteSyncedChannels =
    directStateStore
      ? async (input: { guild: DiscordGuildSurface; mode: SyncedDeleteMode; sessionId?: string | null }) =>
          deleteSyncedDiscordSessions({
            guild: {
              deleteChannel: async (id) => {
                if (!input.guild.deleteChannel) {
                  throw new Error("Discord guild deleteChannel surface is unavailable.");
                }

                await input.guild.deleteChannel(id);
              },
              deleteCategory: async (id) => {
                if (!input.guild.deleteCategory) {
                  throw new Error("Discord guild deleteCategory surface is unavailable.");
                }

                await input.guild.deleteCategory(id);
              },
            },
            stateStore: directStateStore,
            mode: input.mode,
            sessionId: input.sessionId,
          })
      : undefined;
  const archiveSyncedSession =
    directStateStore
      ? async (input: { guild: DiscordGuildSurface | null | undefined; discordChannelId: string; codexSessionId?: string | null }) =>
          archiveSyncedCodexSession({
            guild: input.guild,
            stateStore: directStateStore,
            discordChannelId: input.discordChannelId,
            codexSessionId: input.codexSessionId,
          })
      : undefined;
  const scheduleCommand =
    directStateStore
      ? async (input: {
          request: Parameters<typeof manageScheduledCommand>[0]["request"];
          channelId: string;
          userId: string;
          roleIds: string[];
        }) =>
          manageScheduledCommand({
            stateStore: directStateStore,
            request: input.request,
            channelId: input.channelId,
            userId: input.userId,
            roleIds: input.roleIds,
          })
      : undefined;
  const createNewCodexChat =
    connectConfig?.mode === "direct" && directStateStore
      ? async (input: {
          guild: DiscordGuildSurface;
          name: string | null;
          cwd: string | null;
          currentCwd: string;
          useCategory: boolean;
          initialPrompt: string | null;
          channelMode: "session-linked" | "claude-code";
          sessionThreadParentChannelId: string | null;
        }) =>
          createNewCodexChatChannel({
            guild: input.guild,
            controlApi: controlApiClient,
            stateStore: directStateStore,
            computerId: connectConfig.direct.computerId,
            computerDisplayName: connectConfig.direct.computerDisplayName,
            defaultWorkspaceRoot: connectConfig.direct.workspaceRoot,
            currentCwd: input.currentCwd,
            name: input.name,
            cwd: input.cwd,
            useCategory: input.useCategory,
            initialPrompt: input.initialPrompt,
            channelMode: input.channelMode,
            sessionThreadParentChannelId: input.sessionThreadParentChannelId ?? connectConfig.direct.channelId,
          })
      : undefined;
  const createForkedSessionThread =
    connectConfig?.mode === "direct" && directStateStore
      ? async (input: {
          guild: DiscordGuildSurface;
          sourceDiscordChannelId: string;
          sourceSessionId: string;
          name: string;
        }) =>
          createForkedDiscordSessionThread({
            guild: input.guild,
            controlApi: controlApiClient,
            stateStore: directStateStore,
            sourceDiscordChannelId: input.sourceDiscordChannelId,
            sourceSessionId: input.sourceSessionId,
            name: input.name,
          })
      : undefined;
  const discardForkedSessionThread =
    connectConfig?.mode === "direct" && directStateStore
      ? (input: { guild: DiscordGuildSurface; discordChannelId: string }) =>
          discardPendingDiscordSessionThread({
            guild: input.guild,
            stateStore: directStateStore,
            discordChannelId: input.discordChannelId,
          })
      : undefined;
  const linkNewCodexSession =
    directStateStore
      ? async (input: { discordChannelId: string; codexSessionId: string; threadName: string }) =>
          linkPendingNewCodexChatSession({
            controlApi: controlApiClient,
            stateStore: directStateStore,
            discordChannelId: input.discordChannelId,
            codexSessionId: input.codexSessionId,
            threadName: input.threadName,
          })
      : undefined;
  const processMessage = createDiscordMessageHandler({
    locale,
    resolveChannelContext: controlApiClient.getChannelContext,
    submitCommandJob: controlApiClient.submitCommandJob,
    submitCodexPrompt: controlApiClient.submitCodexPrompt,
    controlCodexTurn: controlApiClient.controlCodexTurn,
    submitClaudePrompt: controlApiClient.submitClaudePrompt,
    syncCodexSessions,
    createNewCodexChat,
    createForkedSessionThread,
    discardForkedSessionThread,
    linkNewCodexSession,
    resolveCodexGoalStatus: listDirectCodexSessions
      ? async (sessionId) => {
          const sessions = await listDirectCodexSessions({
            activeOnly: false,
            includeExecSessions: true,
            includeSessionIds: [sessionId],
          });
          return sessions.find((session) => session.id === sessionId)?.goalStatus ?? null;
        }
      : undefined,
    recordClaudeSession: directStateStore
      ? (input) =>
          directStateStore.updateSessionChannelClaudeSession(input.discordChannelId, input.claudeSessionId)
      : undefined,
    updateAgentDefaults: directStateStore
      ? (agent, patch) => directStateStore.updateAgentDefaults(agent, patch)
      : undefined,
    updateSessionAgentSettings: directStateStore
      ? (discordChannelId, patch) => directStateStore.updateSessionChannelAgentSettings(discordChannelId, patch)
      : undefined,
    previewSelectableCodexSessions,
    listResumableClaudeSessions:
      connectConfig?.mode === "direct"
        ? (resumeInput) => listResumableClaudeSessions({ limit: resumeInput.limit })
        : undefined,
    resumeClaudeSession: (() => {
      if (connectConfig?.mode !== "direct" || !directStateStore) {
        return undefined;
      }

      const claudeParentChannelId = connectConfig.direct.claudeChannelId?.trim();

      if (!claudeParentChannelId) {
        return undefined;
      }

      return (resumeInput: { sessionId: string; guild: DiscordGuildSurface }) =>
        resumeClaudeCodeSessionThread({
          guild: resumeInput.guild,
          controlApi: controlApiClient,
          stateStore: directStateStore,
          computerId: connectConfig.direct.computerId,
          computerDisplayName: connectConfig.direct.computerDisplayName,
          parentChannelId: claudeParentChannelId,
          mentionRoleIds: connectConfig.discord.allowedRoleIds,
          sessionId: resumeInput.sessionId,
        });
    })(),
    getSyncStatus,
    setTranscriptSyncMode,
    syncTranscriptUpdates,
    setSessionStreaming: (sessionId, active) => {
      if (active) {
        activelyStreamedSessionIds.add(sessionId);
        return;
      }

      activelyStreamedSessionIds.delete(sessionId);
    },
    markDiscordRequestedCodexSession: directStateStore
      ? (sessionId, options) => directStateStore.markDiscordRequestedCodexSession(sessionId, options)
      : undefined,
    reloadBot,
    previewSyncedChannelsDelete,
    deleteSyncedChannels,
    archiveSyncedSession,
    scheduleCommand,
    updateChannelCwd: controlApiClient.updateChannelCwd,
    recordCommandAudit: controlApiClient.recordCommandAudit,
    resolveRelayPresence: relayPresenceStore
      ? (threadId) => relayPresenceStore.findByThread(threadId)
      : undefined,
    relayControlChannelId:
      process.env.CONNECT_RELAY_CONTROL_CHANNEL_ID?.trim() ||
      (connectConfig?.mode === "direct" ? connectConfig.direct.relay?.controlChannelId : undefined),
    persistDurableRequest: durableRequestStore
      ? (request) => durableRequestStore.enqueue(request)
      : undefined,
    completeDurableRequest: durableRequestStore
      ? async (requestId) => {
          await durableRequestStore.remove(requestId);
          await directWorkerClient?.markDelivered(requestId);
        }
      : undefined,
    materializeIncomingAttachments: incomingAttachmentStore
      ? async (input) => {
          const files = await incomingAttachmentStore.materialize({
            messageId: input.messageId,
            attachments: input.attachments,
          });
          return {
            files,
            content: appendDiscordAttachmentsToPrompt(input.content, files),
          };
        }
      : undefined,
  });
  let releaseDurableRecovery: () => void = () => undefined;
  const durableRecoveryReady = durableRequestStore
    ? new Promise<void>((resolve) => {
        releaseDurableRecovery = resolve;
      })
    : Promise.resolve();
  const handleMessage = async (message: Parameters<typeof processMessage>[0]): Promise<void> => {
    await durableRecoveryReady;
    await processMessage(message);
  };

  client.once("clientReady", () => {
    console.info(`Discord bot ready as ${client.user?.tag ?? "unknown"}`);
    void registerDiscordApplicationCommands(client, connectConfig?.discord.guildId, locale).catch((error) => {
      console.error("discord-bot failed to register slash commands", error);
    });

    if (durableRequestStore) {
      const guild = resolveReadyGuildSurface(client, connectConfig?.discord.guildId, answerCopyStore, locale);
      if (guild?.sendTextMessage) {
        void (async () => {
          const requests = await durableRequestStore.list();
          for (const request of requests) {
            try {
              await processMessage({
                authorBot: request.authorBot ?? false,
                relayRequest: request.relayRequest,
                userId: request.userId,
                channelId: request.channelId,
                content: request.content,
                roleIds: request.roleIds,
                messageId: request.messageId,
                requestId: request.requestId,
                durableQueuedAt: request.createdAt,
                restoreOnly: true,
                guild,
                reply: async (replyMessage) => {
                  const sent = await guild.sendTextMessage?.(request.channelId, replyMessage);
                  const messageId = sent?.id;
                  const editTextMessage = guild.editTextMessage;
                  if (!messageId || !editTextMessage) {
                    return undefined;
                  }
                  return {
                    edit: (nextMessage) => editTextMessage(request.channelId, messageId, nextMessage),
                  };
                },
              });
            } catch (error) {
              console.error(`discord-bot failed to recover durable request ${request.requestId}`, error);
            }
          }
          processMessage.drainRestoredMessages();
        })()
          .catch((error) => console.error("discord-bot failed to load durable Discord requests", error))
          .finally(releaseDurableRecovery);
      } else {
        releaseDurableRecovery();
      }
    }

    if (syncTranscriptUpdates) {
      let running = false;
      const pollState = createBackgroundPollState(Date.now(), TRANSCRIPT_SYNC_INTERVAL_MS);
      const timer = setInterval(() => {
        const now = Date.now();

        if (!shouldRunBackgroundPoll(pollState, now)) {
          return;
        }

        if (running) {
          return;
        }

        if (shouldSkipBackgroundPolling(currentBackgroundLoadInput())) {
          recordBackgroundPollResult(pollState, {
            now,
            baseIntervalMs: TRANSCRIPT_SYNC_INTERVAL_MS,
            maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
            changed: false,
            skippedForLoad: true,
          });
          return;
        }

        const guild = resolveReadyGuildSurface(client, connectConfig?.discord.guildId, answerCopyStore, locale);

        if (!guild) {
          return;
        }

        running = true;
        void (async () => {
          const result = await syncTranscriptUpdates({ guild, trigger: "realtime" });
          recordBackgroundPollResult(pollState, {
            now: Date.now(),
            baseIntervalMs: TRANSCRIPT_SYNC_INTERVAL_MS,
            maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
            changed: result.updatedChannels > 0 || result.postedMessages > 0,
          });
        })()
          .catch((error) => {
            console.error("discord-bot failed to sync Codex transcripts", error);
            recordBackgroundPollResult(pollState, {
              now: Date.now(),
              baseIntervalMs: TRANSCRIPT_SYNC_INTERVAL_MS,
              maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
              changed: false,
            });
          })
          .finally(() => {
            running = false;
          });
      }, TRANSCRIPT_SYNC_INTERVAL_MS);
      timer.unref();
    }

    if (notifyTaskCompletions) {
      let running = false;
      const pollState = createBackgroundPollState(Date.now(), TASK_NOTIFICATION_INTERVAL_MS);
      const timer = setInterval(() => {
        const now = Date.now();

        if (!shouldRunBackgroundPoll(pollState, now)) {
          return;
        }

        if (running) {
          return;
        }

        if (shouldSkipBackgroundPolling(currentBackgroundLoadInput())) {
          recordBackgroundPollResult(pollState, {
            now,
            baseIntervalMs: TASK_NOTIFICATION_INTERVAL_MS,
            maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
            changed: false,
            skippedForLoad: true,
          });
          return;
        }

        const guild = resolveReadyGuildSurface(client, connectConfig?.discord.guildId, answerCopyStore, locale);

        if (!guild?.sendTextMessage) {
          return;
        }

        running = true;
        void notifyTaskCompletions({ guild })
          .then((result) => {
            recordBackgroundPollResult(pollState, {
              now: Date.now(),
              baseIntervalMs: TASK_NOTIFICATION_INTERVAL_MS,
              maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
              changed: result.initialized || result.notifiedSessions > 0,
            });
          })
          .catch((error) => {
            console.error("discord-bot failed to notify Codex task completions", error);
            recordBackgroundPollResult(pollState, {
              now: Date.now(),
              baseIntervalMs: TASK_NOTIFICATION_INTERVAL_MS,
              maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
              changed: false,
            });
          })
          .finally(() => {
            running = false;
          });
      }, TASK_NOTIFICATION_INTERVAL_MS);
      timer.unref();
    }

    if (syncClaudeCodeSessions || notifyClaudeCodeCompletions) {
      let running = false;
      const pollState = createBackgroundPollState(Date.now(), CLAUDE_SESSION_SYNC_INTERVAL_MS);
      const timer = setInterval(() => {
        const now = Date.now();

        if (!shouldRunBackgroundPoll(pollState, now)) {
          return;
        }

        if (running) {
          return;
        }

        if (shouldSkipBackgroundPolling(currentBackgroundLoadInput())) {
          recordBackgroundPollResult(pollState, {
            now,
            baseIntervalMs: CLAUDE_SESSION_SYNC_INTERVAL_MS,
            maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
            changed: false,
            skippedForLoad: true,
          });
          return;
        }

        const guild = resolveReadyGuildSurface(client, connectConfig?.discord.guildId, answerCopyStore, locale);

        if (!guild) {
          return;
        }

        running = true;
        void (async () => {
          const sessions = await discoverClaudeCodeSessions({
            updatedAfter: new Date(Date.now() - CLAUDE_SESSION_SYNC_LOOKBACK_MS),
          });
          const syncResult = syncClaudeCodeSessions
            ? await syncClaudeCodeSessions({ guild, sessions })
            : null;
          const notifyResult = notifyClaudeCodeCompletions
            ? await notifyClaudeCodeCompletions({ guild, sessions })
            : null;

          return { syncResult, notifyResult };
        })()
          .then(({ syncResult, notifyResult }) => {
            recordBackgroundPollResult(pollState, {
              now: Date.now(),
              baseIntervalMs: CLAUDE_SESSION_SYNC_INTERVAL_MS,
              maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
              changed:
                (syncResult?.createdThreads ?? 0) > 0 ||
                (notifyResult?.notifiedSessions ?? 0) > 0 ||
                Boolean(notifyResult?.initialized),
            });
          })
          .catch((error) => {
            console.error("discord-bot failed to sync Claude Code sessions", error);
            recordBackgroundPollResult(pollState, {
              now: Date.now(),
              baseIntervalMs: CLAUDE_SESSION_SYNC_INTERVAL_MS,
              maxIntervalMs: BACKGROUND_POLL_MAX_INTERVAL_MS,
              changed: false,
            });
          })
          .finally(() => {
            running = false;
          });
      }, CLAUDE_SESSION_SYNC_INTERVAL_MS);
      timer.unref();
    }

    if (directWorkerClient) {
      let running = false;
      const timer = setInterval(() => {
        if (running) {
          return;
        }

        const guild = resolveReadyGuildSurface(client, connectConfig?.discord.guildId, answerCopyStore, locale);

        if (!guild?.sendTextMessage) {
          return;
        }

        running = true;
        void deliverClaudeIdleNotifications({
          guild,
          source: directWorkerClient,
          mentionRoleIds: connectConfig?.discord.allowedRoleIds ?? [],
        })
          .catch((error) => {
            console.error("discord-bot failed to deliver Claude idle notifications", error);
          })
          .finally(() => {
            running = false;
          });
      }, CLAUDE_IDLE_NOTIFICATION_INTERVAL_MS);
      timer.unref();
    }

    if (directStateStore) {
      let running = false;
      const timer = setInterval(() => {
        if (running) {
          return;
        }

        const guild = resolveReadyGuildSurface(client, connectConfig?.discord.guildId, answerCopyStore, locale);

        if (!guild?.sendTextMessage) {
          return;
        }

        running = true;
        void runDueScheduledCommands({
          stateStore: directStateStore,
          execute: async (schedule) => {
            await guild.sendTextMessage?.(
              schedule.channelId,
              `예약 실행: \`${schedule.command.replace(/`/g, "'")}\``,
            );
            await handleMessage({
              authorBot: false,
              userId: schedule.userId,
              channelId: schedule.channelId,
              content: schedule.command,
              roleIds: schedule.roleIds,
              guild,
              reply: async (replyMessage) => {
                await guild.sendTextMessage?.(schedule.channelId, outgoingMessageToText(replyMessage));
              },
            });
          },
        })
          .catch((error) => {
            console.error("discord-bot failed to run scheduled commands", error);
          })
          .finally(() => {
            running = false;
          });
      }, SCHEDULE_POLL_INTERVAL_MS);
      timer.unref();
    }
  });
  attachDiscordMessageHandler(client, handleMessage, {
    answerCopyStore,
    locale,
    relayControlChannelId:
      process.env.CONNECT_RELAY_CONTROL_CHANNEL_ID?.trim() ||
      (connectConfig?.mode === "direct" ? connectConfig.direct.relay?.controlChannelId : undefined),
    trustedRelayBotUserIds: (() => {
      const environmentIds = identifierList(process.env.CONNECT_RELAY_BOT_USER_IDS);
      return environmentIds.length > 0
        ? environmentIds
        : connectConfig?.mode === "direct"
          ? connectConfig.direct.relay?.trustedBotUserIds
          : undefined;
    })(),
    onRelayState: relayPresenceStore
      ? (state) => relayPresenceStore.apply(state)
      : undefined,
    onConnectorDiscovery:
      connectConfig?.mode === "direct" && directStateStore
        ? async (discoveryId, guild) => {
            if (!guild) {
              return null;
            }
            const preferredAgent = maintenanceAgent(
              process.env.CONNECT_MAINTENANCE_AGENT ?? connectConfig.direct.maintenanceAgent,
            );
            connectorMaintenanceThreadPromise ??= ensureConnectorMaintenanceThread({
              guild,
              controlApi: controlApiClient,
              stateStore: directStateStore,
              computerId: connectConfig.direct.computerId,
              defaultWorkspaceRoot: connectConfig.direct.workspaceRoot,
              preferredAgent,
              codexParentChannelId: connectConfig.direct.channelId,
              claudeParentChannelId: connectConfig.direct.claudeChannelId,
              locale,
            }).finally(() => {
              connectorMaintenanceThreadPromise = null;
            });
            const maintenance = await connectorMaintenanceThreadPromise;

            return {
              version: 1,
              discoveryId,
              computerId: connectConfig.direct.computerId,
              computerDisplayName: connectConfig.direct.computerDisplayName,
              connectorVersion: await connectorPackageVersion(),
              preferredAgent,
              channels: {
                codex: connectConfig.direct.channelId,
                claude: connectConfig.direct.claudeChannelId?.trim() || null,
              },
              maintenance: {
                agent: maintenance.agent,
                channelId: maintenance.channelId,
              },
              registeredAt: new Date().toISOString(),
            };
          }
        : undefined,
  });
  attachDiscordInteractionHandler(client, handleMessage, {
    cwdPicker: connectConfig?.mode === "direct",
    isManagedChannel: async (channelId) => Boolean(await controlApiClient.getChannelContext(channelId)),
    modelAutocomplete: async (channelId, query) => {
      const channelContext = await controlApiClient.getChannelContext(channelId);
      if (!channelContext) {
        return [];
      }

      const agent = agentKindForContext(channelContext);
      const currentModel = channelContext.agentMain
        ? channelContext.agentDefaults?.[agent]?.model
        : channelContext.agentModelOverride ?? channelContext.agentDefaults?.[agent]?.model;
      const codexModels =
        agent === "codex" && connectConfig?.mode === "direct"
          ? await loadCodexModelChoices(connectConfig.direct.codexHome)
          : [];

      return modelAutocompleteChoices({
        agent,
        query,
        currentModel,
        codexModels,
      });
    },
    answerCopyStore,
    locale,
  });

  await client.login(token);
}

export async function main(): Promise<void> {
  await startBot();
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  await main();
}
