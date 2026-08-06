import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChannelMode } from "../../../packages/core/src/index.js";
import {
  DEFAULT_AGENT_SETTINGS,
  normalizeAgentDefaultSettings,
  normalizeAgentSettingsOverride,
  type AgentDefaultSettings,
  type AgentEffort,
  type AgentKind,
} from "./agentSettings.js";

export interface SyncedWorkspaceState {
  workspaceRoot: string;
  workspaceDisplayName: string;
  discordCategoryId: string;
  computerId: string;
  workspaceId: string;
}

export type TranscriptSyncMode = "on-chat" | "realtime";
export type DiscordSessionDeliveryMode = "channel" | "thread";
export type DiscordSessionChannelPurpose = "maintenance";

export interface SyncedSessionChannelState {
  codexSessionId: string | null;
  threadName: string;
  updatedAt: string;
  cwd: string;
  workspaceRoot: string;
  workspaceDisplayName: string;
  discordCategoryId: string | null;
  discordChannelId: string;
  discordParentChannelId?: string | null;
  discordDeliveryMode?: DiscordSessionDeliveryMode;
  channelPurpose?: DiscordSessionChannelPurpose | null;
  channelMode?: ChannelMode;
  claudeSessionId?: string | null;
  agentModelOverride?: string | null;
  agentEffortOverride?: AgentEffort | null;
  pendingForkSourceDiscordChannelId?: string | null;
  pendingForkSourceSessionId?: string | null;
  channelName: string;
  computerId: string;
  workspaceId: string;
  contextPostedAt?: string | null;
  lastTranscriptMessageKey?: string | null;
  lastTranscriptSyncedAt?: string | null;
  lastTranscriptDiscordMessageId?: string | null;
}

export type ScheduledCommandSpec =
  | { type: "once"; runAt: string }
  | { type: "interval"; everyMs: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; weekdays: number[] };

export interface ScheduledCommandState {
  id: string;
  channelId: string;
  userId: string;
  roleIds: string[];
  command: string;
  schedule: ScheduledCommandSpec;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  runCount: number;
}

export interface CodexTaskCompletionNotificationState {
  sessionId: string;
  lastTaskCompleteEventKey: string;
  threadName?: string | null;
  updatedAt?: string | null;
  notifiedAt?: string | null;
}

export interface ClaudeCodeCompletionNotificationState {
  sessionId: string;
  lastAssistantMessageKey: string;
  threadName?: string | null;
  updatedAt?: string | null;
  notifiedAt?: string | null;
}

export interface DiscordRequestedCodexSessionState {
  sessionId: string;
  requestedAt: string;
  discordChannelId?: string | null;
  completionMentionSent?: boolean;
}

export interface DirectSyncState {
  version: 1;
  agentDefaults: AgentDefaultSettings;
  transcriptSyncMode: TranscriptSyncMode;
  archivedCodexSessionIds: string[];
  workspaces: SyncedWorkspaceState[];
  sessionChannels: SyncedSessionChannelState[];
  scheduledCommands: ScheduledCommandState[];
  taskCompletionNotificationsInitializedAt?: string | null;
  taskCompletionNotificationScope?: string | null;
  taskCompletionNotifications: CodexTaskCompletionNotificationState[];
  claudeCompletionNotificationsInitializedAt?: string | null;
  claudeCompletionNotificationScope?: string | null;
  claudeCompletionNotifications: ClaudeCodeCompletionNotificationState[];
  discordRequestedCodexSessionIds: string[];
  discordRequestedCodexSessionRequests: DiscordRequestedCodexSessionState[];
}

export type DirectSyncStateWriteInput = Omit<
  DirectSyncState,
  | "transcriptSyncMode"
  | "agentDefaults"
  | "scheduledCommands"
  | "taskCompletionNotificationsInitializedAt"
  | "taskCompletionNotifications"
  | "claudeCompletionNotificationsInitializedAt"
  | "claudeCompletionNotifications"
  | "discordRequestedCodexSessionIds"
  | "discordRequestedCodexSessionRequests"
> & {
  transcriptSyncMode?: TranscriptSyncMode;
  agentDefaults?: AgentDefaultSettings;
  scheduledCommands?: ScheduledCommandState[];
  taskCompletionNotificationsInitializedAt?: string | null;
  taskCompletionNotificationScope?: string | null;
  taskCompletionNotifications?: CodexTaskCompletionNotificationState[];
  claudeCompletionNotificationsInitializedAt?: string | null;
  claudeCompletionNotificationScope?: string | null;
  claudeCompletionNotifications?: ClaudeCodeCompletionNotificationState[];
  discordRequestedCodexSessionIds?: string[];
  discordRequestedCodexSessionRequests?: DiscordRequestedCodexSessionState[];
};

export interface DirectSyncStateStore {
  read(): Promise<DirectSyncState>;
  write(state: DirectSyncStateWriteInput): Promise<void>;
  update(
    updater: (state: DirectSyncState) => DirectSyncStateWriteInput | DirectSyncState,
  ): Promise<DirectSyncState>;
  findSessionChannelByDiscordId(discordChannelId: string): Promise<SyncedSessionChannelState | null>;
  updateChannelCwd(discordChannelId: string, cwd: string): Promise<void>;
  updateSessionChannelCodexSession(
    discordChannelId: string,
    codexSessionId: string,
    threadName?: string,
  ): Promise<void>;
  updateSessionChannelClaudeSession(discordChannelId: string, claudeSessionId: string): Promise<void>;
  updateAgentDefaults(
    agent: AgentKind,
    patch: { model?: string | null; effort?: AgentEffort },
  ): Promise<AgentDefaultSettings>;
  updateSessionChannelAgentSettings(
    discordChannelId: string,
    patch: { model?: string | null; effort?: AgentEffort | null },
  ): Promise<void>;
  removePendingSessionChannel(discordChannelId: string): Promise<boolean>;
  updateTranscriptSyncMode(mode: TranscriptSyncMode): Promise<void>;
  markDiscordRequestedCodexSession(
    sessionId: string,
    options?: { discordChannelId?: string | null; completionMentionSent?: boolean },
  ): Promise<void>;
}

export function createEmptyDirectSyncState(): DirectSyncState {
  return {
    version: 1,
    agentDefaults: DEFAULT_AGENT_SETTINGS,
    transcriptSyncMode: "realtime",
    archivedCodexSessionIds: [],
    workspaces: [],
    sessionChannels: [],
    scheduledCommands: [],
    taskCompletionNotificationsInitializedAt: null,
    taskCompletionNotificationScope: null,
    taskCompletionNotifications: [],
    claudeCompletionNotificationsInitializedAt: null,
    claudeCompletionNotificationScope: null,
    claudeCompletionNotifications: [],
    discordRequestedCodexSessionIds: [],
    discordRequestedCodexSessionRequests: [],
  };
}

function normalizeDirectSyncState(state: Partial<DirectSyncState>): DirectSyncState {
  const transcriptSyncMode =
    state.transcriptSyncMode === "realtime" || state.transcriptSyncMode === "on-chat"
      ? state.transcriptSyncMode
      : "realtime";

  return {
    version: 1,
    agentDefaults: normalizeAgentDefaultSettings(state.agentDefaults),
    transcriptSyncMode,
    archivedCodexSessionIds: Array.isArray(state.archivedCodexSessionIds)
      ? state.archivedCodexSessionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
    workspaces: Array.isArray(state.workspaces) ? state.workspaces : [],
    sessionChannels: Array.isArray(state.sessionChannels)
      ? state.sessionChannels.map((channel) => {
          const agent = channel.channelMode === "claude-code" ? "claude" : "codex";
          const override = normalizeAgentSettingsOverride(agent, {
            model: channel.agentModelOverride,
            effort: channel.agentEffortOverride,
          });
          return {
            ...channel,
            ...(Object.hasOwn(channel, "agentModelOverride") ? { agentModelOverride: override.model } : {}),
            ...(Object.hasOwn(channel, "agentEffortOverride") ? { agentEffortOverride: override.effort } : {}),
          };
        })
      : [],
    scheduledCommands: Array.isArray(state.scheduledCommands)
      ? state.scheduledCommands.filter(
          (schedule): schedule is ScheduledCommandState =>
            typeof schedule === "object" &&
            schedule !== null &&
            typeof (schedule as ScheduledCommandState).id === "string" &&
            typeof (schedule as ScheduledCommandState).channelId === "string" &&
            typeof (schedule as ScheduledCommandState).command === "string",
        )
      : [],
    taskCompletionNotificationsInitializedAt:
      typeof state.taskCompletionNotificationsInitializedAt === "string"
        ? state.taskCompletionNotificationsInitializedAt
        : null,
    taskCompletionNotificationScope:
      typeof state.taskCompletionNotificationScope === "string"
        ? state.taskCompletionNotificationScope
        : null,
    taskCompletionNotifications: Array.isArray(state.taskCompletionNotifications)
      ? state.taskCompletionNotifications.filter(
          (notification): notification is CodexTaskCompletionNotificationState =>
            typeof notification === "object" &&
            notification !== null &&
            typeof (notification as CodexTaskCompletionNotificationState).sessionId === "string" &&
            typeof (notification as CodexTaskCompletionNotificationState).lastTaskCompleteEventKey === "string",
        )
      : [],
    claudeCompletionNotificationsInitializedAt:
      typeof state.claudeCompletionNotificationsInitializedAt === "string"
        ? state.claudeCompletionNotificationsInitializedAt
        : null,
    claudeCompletionNotificationScope:
      typeof state.claudeCompletionNotificationScope === "string"
        ? state.claudeCompletionNotificationScope
        : null,
    claudeCompletionNotifications: Array.isArray(state.claudeCompletionNotifications)
      ? state.claudeCompletionNotifications.filter(
          (notification): notification is ClaudeCodeCompletionNotificationState =>
            typeof notification === "object" &&
            notification !== null &&
            typeof (notification as ClaudeCodeCompletionNotificationState).sessionId === "string" &&
            typeof (notification as ClaudeCodeCompletionNotificationState).lastAssistantMessageKey === "string",
        )
      : [],
    discordRequestedCodexSessionIds: Array.isArray(state.discordRequestedCodexSessionIds)
      ? [
          ...new Set(
            state.discordRequestedCodexSessionIds
              .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0)
              .map((sessionId) => sessionId.toLowerCase()),
          ),
        ]
      : [],
    discordRequestedCodexSessionRequests: Array.isArray(state.discordRequestedCodexSessionRequests)
      ? [
          ...new Map(
            state.discordRequestedCodexSessionRequests
              .filter(
                (request): request is DiscordRequestedCodexSessionState =>
                  typeof request === "object" &&
                  request !== null &&
                  typeof (request as DiscordRequestedCodexSessionState).sessionId === "string" &&
                  typeof (request as DiscordRequestedCodexSessionState).requestedAt === "string",
              )
              .map((request) => [
                request.sessionId.toLowerCase(),
                {
                  sessionId: request.sessionId.toLowerCase(),
                  requestedAt: request.requestedAt,
                  ...(typeof (request as DiscordRequestedCodexSessionState).discordChannelId === "string" &&
                  (request as DiscordRequestedCodexSessionState).discordChannelId?.trim()
                    ? {
                        discordChannelId: (request as DiscordRequestedCodexSessionState).discordChannelId?.trim(),
                      }
                    : {}),
                  ...((request as DiscordRequestedCodexSessionState).completionMentionSent === true
                    ? { completionMentionSent: true }
                    : {}),
                },
              ]),
          ).values(),
        ]
      : [],
  };
}

export function defaultDirectSyncStatePath(): string {
  return path.resolve(process.env.CONNECT_STATE_PATH ?? ".connect/state.json");
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDirectSyncStateStore(statePath = defaultDirectSyncStatePath()): DirectSyncStateStore {
  const resolvedStatePath = path.resolve(statePath);
  let mutationQueue: Promise<void> = Promise.resolve();

  async function readState(): Promise<DirectSyncState> {
    let lastParseError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return normalizeDirectSyncState(JSON.parse(await readFile(resolvedStatePath, "utf8")) as Partial<DirectSyncState>);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return createEmptyDirectSyncState();
        }

        if (!isJsonParseError(error)) {
          throw error;
        }

        lastParseError = error;
        await wait(25);
      }
    }

    throw lastParseError;
  }

  async function writeState(state: DirectSyncStateWriteInput): Promise<DirectSyncState> {
    const normalizedState = normalizeDirectSyncState(state);
    await mkdir(path.dirname(resolvedStatePath), { recursive: true });
    const tempPath = `${resolvedStatePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

    try {
      await writeFile(tempPath, `${JSON.stringify(normalizedState, null, 2)}\n`, "utf8");
      await rename(tempPath, resolvedStatePath);
      return normalizedState;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function mutate<T>(
    mutator: (state: DirectSyncState) => {
      state: DirectSyncStateWriteInput | DirectSyncState;
      result: T;
    } | Promise<{
      state: DirectSyncStateWriteInput | DirectSyncState;
      result: T;
    }>,
  ): Promise<T> {
    const operation = mutationQueue.then(async () => {
      const currentState = await readState();
      const next = await mutator(currentState);
      await writeState(next.state);
      return next.result;
    });

    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  const store: DirectSyncStateStore = {
    async read() {
      await mutationQueue;
      return readState();
    },
    async write(state) {
      await mutate(() => ({ state, result: undefined }));
    },
    async update(updater) {
      return mutate((state) => {
        const nextState = updater(state);
        return { state: nextState, result: normalizeDirectSyncState(nextState) };
      });
    },
    async findSessionChannelByDiscordId(discordChannelId) {
      const state = await store.read();
      return state.sessionChannels.find((channel) => channel.discordChannelId === discordChannelId) ?? null;
    },
    async updateChannelCwd(discordChannelId, cwd) {
      await store.update((state) => ({
        ...state,
        sessionChannels: state.sessionChannels.map((channel) =>
          channel.discordChannelId === discordChannelId ? { ...channel, cwd } : channel,
        ),
      }));
    },
    async updateSessionChannelCodexSession(discordChannelId, codexSessionId, threadName) {
      const normalizedSessionId = codexSessionId.trim();

      if (!normalizedSessionId) {
        throw new Error("Codex session ID is required.");
      }

      await store.update((state) => {
        const target = state.sessionChannels.find((channel) => channel.discordChannelId === discordChannelId);

        if (!target) {
          throw new Error(`Discord session channel was not found: ${discordChannelId}`);
        }

        if (
          target.codexSessionId &&
          target.codexSessionId.toLowerCase() !== normalizedSessionId.toLowerCase()
        ) {
          throw new Error(
            `Discord channel ${discordChannelId} is already bound to Codex session ${target.codexSessionId}.`,
          );
        }

        if (target.pendingForkSourceSessionId?.toLowerCase() === normalizedSessionId.toLowerCase()) {
          throw new Error("Fork returned the source Codex session ID instead of a new session ID.");
        }

        const conflictingChannel = state.sessionChannels.find(
          (channel) =>
            channel.discordChannelId !== discordChannelId &&
            channel.codexSessionId?.toLowerCase() === normalizedSessionId.toLowerCase(),
        );

        if (conflictingChannel) {
          throw new Error(`Codex session is already linked to Discord channel ${conflictingChannel.discordChannelId}.`);
        }

        return {
          ...state,
          sessionChannels: state.sessionChannels.map((channel) =>
            channel.discordChannelId === discordChannelId
              ? {
                  ...channel,
                  codexSessionId: normalizedSessionId,
                  threadName: threadName?.trim() || channel.threadName,
                  updatedAt: new Date().toISOString(),
                  pendingForkSourceDiscordChannelId: null,
                  pendingForkSourceSessionId: null,
                }
              : channel,
          ),
        };
      });
    },
    async updateSessionChannelClaudeSession(discordChannelId, claudeSessionId) {
      const normalizedSessionId = claudeSessionId.trim();

      if (!normalizedSessionId) {
        return;
      }

      await store.update((state) => {
        const target = state.sessionChannels.find((channel) => channel.discordChannelId === discordChannelId);

        if (!target) {
          throw new Error(`Discord session channel was not found: ${discordChannelId}`);
        }

        if (
          target.claudeSessionId &&
          target.claudeSessionId.toLowerCase() !== normalizedSessionId.toLowerCase()
        ) {
          throw new Error(
            `Discord channel ${discordChannelId} is already bound to Claude Code session ${target.claudeSessionId}.`,
          );
        }

        if (target.pendingForkSourceSessionId?.toLowerCase() === normalizedSessionId.toLowerCase()) {
          throw new Error("Fork returned the source Claude Code session ID instead of a new session ID.");
        }

        const conflictingChannel = state.sessionChannels.find(
          (channel) =>
            channel.discordChannelId !== discordChannelId &&
            channel.claudeSessionId?.toLowerCase() === normalizedSessionId.toLowerCase(),
        );

        if (conflictingChannel) {
          throw new Error(`Claude Code session is already linked to Discord channel ${conflictingChannel.discordChannelId}.`);
        }

        return {
          ...state,
          sessionChannels: state.sessionChannels.map((channel) =>
            channel.discordChannelId === discordChannelId
              ? {
                  ...channel,
                  claudeSessionId: normalizedSessionId,
                  updatedAt: new Date().toISOString(),
                  pendingForkSourceDiscordChannelId: null,
                  pendingForkSourceSessionId: null,
                }
              : channel,
          ),
        };
      });
    },
    async updateAgentDefaults(agent, patch) {
      return store.update((state) => ({
        ...state,
        agentDefaults: normalizeAgentDefaultSettings({
          ...state.agentDefaults,
          [agent]: {
            ...state.agentDefaults[agent],
            ...patch,
          },
        }),
      })).then((state) => state.agentDefaults);
    },
    async updateSessionChannelAgentSettings(discordChannelId, patch) {
      await store.update((state) => {
        const target = state.sessionChannels.find((channel) => channel.discordChannelId === discordChannelId);

        if (!target) {
          throw new Error(`Discord session channel was not found: ${discordChannelId}`);
        }

        const agent = target.channelMode === "claude-code" ? "claude" : "codex";
        const override = normalizeAgentSettingsOverride(agent, {
          model: Object.hasOwn(patch, "model") ? patch.model : target.agentModelOverride,
          effort: Object.hasOwn(patch, "effort") ? patch.effort : target.agentEffortOverride,
        });

        return {
          ...state,
          sessionChannels: state.sessionChannels.map((channel) =>
            channel.discordChannelId === discordChannelId
              ? {
                  ...channel,
                  agentModelOverride: override.model,
                  agentEffortOverride: override.effort,
                }
              : channel,
          ),
        };
      });
    },
    async removePendingSessionChannel(discordChannelId) {
      return mutate((state) => {
        const target = state.sessionChannels.find((channel) => channel.discordChannelId === discordChannelId);
        const pending = Boolean(
          target &&
          !target.codexSessionId &&
          !target.claudeSessionId,
        );

        return {
          state: pending
            ? {
                ...state,
                sessionChannels: state.sessionChannels.filter(
                  (channel) => channel.discordChannelId !== discordChannelId,
                ),
              }
            : state,
          result: pending,
        };
      });
    },
    async updateTranscriptSyncMode(mode) {
      await store.update((state) => ({
        ...state,
        transcriptSyncMode: mode,
      }));
    },
    async markDiscordRequestedCodexSession(sessionId, options) {
      const normalizedSessionId = sessionId.trim().toLowerCase();

      if (!normalizedSessionId) {
        return;
      }

      await store.update((state) => {
        const existingRequest = state.discordRequestedCodexSessionRequests.find(
          (request) => request.sessionId === normalizedSessionId,
        );
        const linkedChannels = state.sessionChannels.filter(
          (channel) => channel.codexSessionId?.trim().toLowerCase() === normalizedSessionId,
        );
        const requestedChannelId = options?.discordChannelId?.trim() || null;
        const linkedChannelIds = new Set(linkedChannels.map((channel) => channel.discordChannelId));
        const canonicalLinkedChannelId = linkedChannels.length === 1
          ? linkedChannels[0]?.discordChannelId ?? null
          : existingRequest?.discordChannelId && linkedChannelIds.has(existingRequest.discordChannelId)
            ? existingRequest.discordChannelId
            : requestedChannelId && linkedChannelIds.has(requestedChannelId)
              ? requestedChannelId
              : null;
        const discordChannelId =
          canonicalLinkedChannelId ||
          existingRequest?.discordChannelId ||
          requestedChannelId ||
          null;

        if (
          existingRequest &&
          (!options?.completionMentionSent || existingRequest.completionMentionSent) &&
          discordChannelId === (existingRequest.discordChannelId ?? null)
        ) {
          return state;
        }

        return {
          ...state,
          discordRequestedCodexSessionIds: [],
          discordRequestedCodexSessionRequests: [
            ...state.discordRequestedCodexSessionRequests.filter(
              (request) => request.sessionId !== normalizedSessionId,
            ),
            {
              sessionId: normalizedSessionId,
              requestedAt: existingRequest?.requestedAt ?? new Date().toISOString(),
              ...(discordChannelId ? { discordChannelId } : {}),
              ...(options?.completionMentionSent || existingRequest?.completionMentionSent
                ? { completionMentionSent: true }
                : {}),
            },
          ],
        };
      });
    },
  };

  return store;
}
