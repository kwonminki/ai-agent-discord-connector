import path from "node:path";
import type { SessionOrigin } from "../../../packages/core/src/index.js";
import type { DiscoveredCodexSession } from "../../../packages/codex-adapter/src/index.js";
import type { ControlApiClient } from "./controlApiClient.js";
import {
  hasPendingCodexForkReservation,
  type DirectSyncState,
  type DirectSyncStateStore,
  type SyncedSessionChannelState,
  type SyncedWorkspaceState,
} from "./directState.js";
import { mapWithConcurrency } from "./concurrency.js";
import { latestTranscriptMessageKey } from "./codexTranscriptSync.js";
import type { DiscordMessagePayload } from "./responses.js";

const DISCORD_SYNC_CONCURRENCY = 5;
const MAX_DISCORD_THREAD_NAME_LENGTH = 100;

export interface DiscordGuildSurface {
  createCategory(input: { name: string }): Promise<{ id: string }>;
  createTextChannel(input: { name: string; parentId?: string | null; topic?: string }): Promise<{ id: string }>;
  createThread?(input: {
    name: string;
    parentChannelId: string;
    autoArchiveDuration?: number;
    reason?: string;
  }): Promise<{ id: string }>;
  findThreadByName?(input: {
    name: string;
    parentChannelId: string;
  }): Promise<{ id: string } | null>;
  ensureChannelAvailable?(id: string): Promise<boolean>;
  addThreadMember?(threadId: string, userId: string): Promise<void>;
  sendTextMessage?(
    channelId: string,
    content: string | DiscordMessagePayload,
    options?: { mentionRoleIds?: string[] },
  ): Promise<{ id?: string } | void>;
  editTextMessage?(channelId: string, messageId: string, content: string | DiscordMessagePayload): Promise<{ id?: string } | void>;
  deleteChannel?(id: string): Promise<void>;
  deleteCategory?(id: string): Promise<void>;
}

export interface SyncCodexSessionsInput {
  guild: DiscordGuildSurface;
  controlApi: Pick<ControlApiClient, "createCategoryMapping" | "createManagedChannel" | "linkCodexSession">;
  stateStore: DirectSyncStateStore;
  computerId: string;
  computerDisplayName: string;
  defaultWorkspaceRoot: string;
  sessions: DiscoveredCodexSession[];
  limit: number;
  sessionThreadParentChannelId?: string | null;
  mentionRoleIds?: string[];
  onProgress?: (progress: SyncCodexSessionsProgress) => Promise<void> | void;
}

export interface SyncCodexSessionsResult {
  createdCategories: number;
  existingCategories: number;
  createdChannels: number;
  existingChannels: number;
  skippedSessions: number;
}

export interface SyncCodexSessionsProgress extends SyncCodexSessionsResult {
  phase: "syncing" | "complete";
  processedSessions: number;
  totalSessions: number;
  filteredSessions: number;
  currentSessionName?: string;
}

function sanitizeName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[`"'’“”]/g, "")
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized.slice(0, 90) || "codex-session";
}

export function sanitizeDiscordThreadName(value: string, fallback = "Codex session"): string {
  const sanitized = value
    .trim()
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[`"'’“”]/g, "")
    .replace(/@/g, "[at]")
    .replace(/[<>#&]/g, "")
    .trim();

  return sanitized.slice(0, MAX_DISCORD_THREAD_NAME_LENGTH).trim() || fallback;
}

export function codexSessionDiscordThreadName(session: Pick<DiscoveredCodexSession, "id" | "threadName">): string {
  return sanitizeDiscordThreadName(session.threadName, `Codex session ${session.id.slice(0, 8)}`);
}

export function workspaceDisplayName(workspaceRoot: string): string {
  return path.basename(workspaceRoot) || workspaceRoot;
}

export function workspaceId(computerId: string, workspaceRoot: string): string {
  return `${computerId}:${workspaceRoot}`;
}

function sessionChannelName(session: DiscoveredCodexSession): string {
  return sanitizeName(session.threadName);
}

export function sessionTopic(session: DiscoveredCodexSession, workspaceRoot: string): string {
  return [
    `Codex session: ${session.id}`,
    `Workspace: ${workspaceRoot}`,
    `Updated: ${session.updatedAt}`,
  ].join("\n");
}

function truncateContextMessage(value: string): string {
  const limit = 1_900;

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - "\n\n... (일부만 표시)".length)}\n\n... (일부만 표시)`;
}

function formatSessionContextMessage(session: DiscoveredCodexSession): string | null {
  const messages = session.contextPreview?.filter((message) => message.text.trim().length > 0) ?? [];

  if (messages.length === 0) {
    return null;
  }

  const lines = [
    "**이전 Codex 대화 맥락**",
    `세션: ${session.threadName}`,
    `최근 업데이트: ${session.updatedAt}`,
    "",
    ...messages.map((message) => {
      const text = message.text.trim();
      return message.role === "user" ? `### ${text}` : text;
    }),
  ];

  return truncateContextMessage(lines.join("\n\n"));
}

async function postSessionContextIfNeeded(input: {
  guild: DiscordGuildSurface;
  session: DiscoveredCodexSession;
  channel: SyncedSessionChannelState;
  mentionRoleIds?: string[];
}): Promise<void> {
  if (input.channel.contextPostedAt) {
    return;
  }

  const content = formatSessionContextMessage(input.session);

  if (!content || !input.guild.sendTextMessage) {
    return;
  }

  try {
    const mentionRoleIds =
      input.channel.discordDeliveryMode === "thread"
        ? input.mentionRoleIds?.filter((roleId) => roleId.trim().length > 0)
        : [];

    if (mentionRoleIds && mentionRoleIds.length > 0) {
      await input.guild.sendTextMessage(input.channel.discordChannelId, content, { mentionRoleIds });
    } else {
      await input.guild.sendTextMessage(input.channel.discordChannelId, content);
    }
    input.channel.contextPostedAt = new Date().toISOString();
  } catch (error) {
    console.warn("discord-bot failed to post Codex session context", error);
  }
}

function markTranscriptBaseline(channel: SyncedSessionChannelState, session: DiscoveredCodexSession): void {
  const latestMessageKey = latestTranscriptMessageKey(session);

  if (!latestMessageKey) {
    return;
  }

  channel.lastTranscriptMessageKey = latestMessageKey;
  channel.lastTranscriptSyncedAt = new Date().toISOString();
}

async function ensureWorkspaceCategory(input: {
  guild: DiscordGuildSurface;
  controlApi: SyncCodexSessionsInput["controlApi"];
  state: DirectSyncState;
  computerId: string;
  workspaceRoot: string;
}): Promise<{ workspace: SyncedWorkspaceState; created: boolean }> {
  const existingWorkspace = input.state.workspaces.find(
    (workspace) => workspace.workspaceRoot === input.workspaceRoot,
  );

  if (existingWorkspace) {
    return { workspace: existingWorkspace, created: false };
  }

  const displayName = workspaceDisplayName(input.workspaceRoot);
  const category = await input.guild.createCategory({ name: displayName });
  const nextWorkspace = {
    workspaceRoot: input.workspaceRoot,
    workspaceDisplayName: displayName,
    discordCategoryId: category.id,
    computerId: input.computerId,
    workspaceId: workspaceId(input.computerId, input.workspaceRoot),
  };

  await input.controlApi.createCategoryMapping({
    id: `category:${category.id}`,
    discordCategoryId: category.id,
    computerId: input.computerId,
    workspaceId: nextWorkspace.workspaceId,
  });
  input.state.workspaces.push(nextWorkspace);

  return { workspace: nextWorkspace, created: true };
}

async function recreateWorkspaceCategory(input: {
  guild: DiscordGuildSurface;
  controlApi: SyncCodexSessionsInput["controlApi"];
  workspace: SyncedWorkspaceState;
}): Promise<SyncedWorkspaceState> {
  const category = await input.guild.createCategory({ name: input.workspace.workspaceDisplayName });
  input.workspace.discordCategoryId = category.id;

  await input.controlApi.createCategoryMapping({
    id: `category:${category.id}`,
    discordCategoryId: category.id,
    computerId: input.workspace.computerId,
    workspaceId: input.workspace.workspaceId,
  });

  return input.workspace;
}

async function createSessionChannel(input: {
  guild: DiscordGuildSurface;
  controlApi: SyncCodexSessionsInput["controlApi"];
  state: DirectSyncState;
  computerId: string;
  session: DiscoveredCodexSession;
  workspace: SyncedWorkspaceState;
  sessionThreadParentChannelId?: string | null;
}): Promise<SyncedSessionChannelState> {
  const channelName = sessionChannelName(input.session);
  const threadName = codexSessionDiscordThreadName(input.session);
  const threadParentChannelId = input.sessionThreadParentChannelId?.trim() || null;
  const shouldCreateThread = Boolean(threadParentChannelId && input.guild.createThread);
  const channel =
    shouldCreateThread && input.guild.createThread && threadParentChannelId
      ? await input.guild.createThread({
          name: threadName,
          parentChannelId: threadParentChannelId,
          autoArchiveDuration: 10_080,
          reason: sessionTopic(input.session, input.workspace.workspaceRoot),
        })
      : await input.guild.createTextChannel({
          name: channelName,
          parentId: input.workspace.discordCategoryId,
          topic: sessionTopic(input.session, input.workspace.workspaceRoot),
        });
  const nextChannel = {
    codexSessionId: input.session.id,
    threadName: input.session.threadName,
    updatedAt: input.session.updatedAt,
    cwd: input.session.cwdHint ?? input.workspace.workspaceRoot,
    workspaceRoot: input.workspace.workspaceRoot,
    workspaceDisplayName: input.workspace.workspaceDisplayName,
    discordCategoryId: input.workspace.discordCategoryId,
    discordChannelId: channel.id,
    discordParentChannelId: shouldCreateThread ? threadParentChannelId : input.workspace.discordCategoryId,
    discordDeliveryMode: shouldCreateThread ? "thread" : "channel",
    channelName,
    computerId: input.computerId,
    workspaceId: input.workspace.workspaceId,
  } satisfies SyncedSessionChannelState;
  const origin: SessionOrigin = "imported_native";

  await input.controlApi.createManagedChannel({
    id: `channel:${channel.id}`,
    discordChannelId: channel.id,
    computerId: input.computerId,
    workspaceId: input.workspace.workspaceId,
    channelMode: "session-linked",
  });
  await input.controlApi.linkCodexSession({
    discordChannelId: channel.id,
    id: `session-link:${channel.id}:${input.session.id}`,
    codexSessionId: input.session.id,
    origin,
    threadNameSnapshot: input.session.threadName,
  });
  input.state.sessionChannels.push(nextChannel);

  return nextChannel;
}

function isMissingCategoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("CHANNEL_PARENT_INVALID") || message.includes("Category does not exist");
}

export async function syncCodexSessionsToDiscord(
  input: SyncCodexSessionsInput,
): Promise<SyncCodexSessionsResult> {
  const state = await input.stateStore.read();
  const initialWorkspaceRoots = new Set(state.workspaces.map((workspace) => workspace.workspaceRoot));
  const bridgeArchivedSessionIds = new Set(state.archivedCodexSessionIds);
  const activeSessions = input.sessions.filter((session) => !bridgeArchivedSessionIds.has(session.id));
  // A fork transcript is discoverable before the Worker can return its new
  // session id. Do not let background sync claim it ahead of the pending
  // Discord fork thread.
  const reservedForkSessions = activeSessions.filter((session) =>
    hasPendingCodexForkReservation(state, session)
  );
  const selectedSessions = activeSessions
    .filter((session) => !hasPendingCodexForkReservation(state, session))
    .slice(0, input.limit);
  const filteredSessions = input.sessions.length - activeSessions.length;
  const result: SyncCodexSessionsResult = {
    createdCategories: 0,
    existingCategories: 0,
    createdChannels: 0,
    existingChannels: 0,
    skippedSessions:
      filteredSessions +
      reservedForkSessions.length +
      Math.max(0, activeSessions.length - reservedForkSessions.length - selectedSessions.length),
  };
  const emitProgress = async (progress: Pick<SyncCodexSessionsProgress, "phase" | "processedSessions" | "currentSessionName">) => {
    await input.onProgress?.({
      ...result,
      phase: progress.phase,
      processedSessions: progress.processedSessions,
      totalSessions: selectedSessions.length,
      filteredSessions,
      ...(progress.currentSessionName ? { currentSessionName: progress.currentSessionName } : {}),
    });
  };
  const countedExistingWorkspaceRoots = new Set<string>();
  const recreatedWorkspaceRoots = new Set<string>();
  const recreateWorkspaceTasks = new Map<string, Promise<SyncedWorkspaceState>>();
  let processedSessions = 0;
  const sessionTasks: Array<{
    session: DiscoveredCodexSession;
    workspace: SyncedWorkspaceState;
    categoryCreated: boolean;
    existingChannel: SyncedSessionChannelState | null;
  }> = [];

  async function recreateWorkspaceCategoryOnce(workspace: SyncedWorkspaceState): Promise<SyncedWorkspaceState> {
    const existingTask = recreateWorkspaceTasks.get(workspace.workspaceRoot);

    if (existingTask) {
      return existingTask;
    }

    const nextTask = (async () => {
      if (countedExistingWorkspaceRoots.has(workspace.workspaceRoot) && !recreatedWorkspaceRoots.has(workspace.workspaceRoot)) {
        result.existingCategories -= 1;
        result.createdCategories += 1;
        recreatedWorkspaceRoots.add(workspace.workspaceRoot);
      }

      return recreateWorkspaceCategory({
        guild: input.guild,
        controlApi: input.controlApi,
        workspace,
      });
    })();

    recreateWorkspaceTasks.set(workspace.workspaceRoot, nextTask);
    return nextTask;
  }

  async function processSessionTask(task: (typeof sessionTasks)[number]): Promise<void> {
    const shouldUseThread =
      Boolean(input.sessionThreadParentChannelId?.trim()) && Boolean(input.guild.createThread);
    const existingChannelCanBeReused =
      task.existingChannel &&
      (!shouldUseThread || task.existingChannel.discordDeliveryMode === "thread");

    if (existingChannelCanBeReused && task.existingChannel) {
      result.existingChannels += 1;
      await postSessionContextIfNeeded({
        guild: input.guild,
        session: task.session,
        channel: task.existingChannel,
        mentionRoleIds: input.mentionRoleIds,
      });
      markTranscriptBaseline(task.existingChannel, task.session);
      processedSessions += 1;
      await emitProgress({
        phase: "syncing",
        processedSessions,
        currentSessionName: task.session.threadName,
      });
      return;
    }

    let syncedChannel: SyncedSessionChannelState;

    if (task.existingChannel && shouldUseThread) {
      state.sessionChannels = state.sessionChannels.filter(
        (channel) => channel.discordChannelId !== task.existingChannel?.discordChannelId,
      );
    }

    try {
      syncedChannel = await createSessionChannel({
        guild: input.guild,
        controlApi: input.controlApi,
        state,
        computerId: input.computerId,
        session: task.session,
        workspace: task.workspace,
        sessionThreadParentChannelId: input.sessionThreadParentChannelId,
      });
    } catch (error) {
      if (task.categoryCreated || !isMissingCategoryError(error)) {
        throw error;
      }

      const recreatedWorkspace = await recreateWorkspaceCategoryOnce(task.workspace);
      syncedChannel = await createSessionChannel({
        guild: input.guild,
        controlApi: input.controlApi,
        state,
        computerId: input.computerId,
        session: task.session,
        workspace: recreatedWorkspace,
        sessionThreadParentChannelId: input.sessionThreadParentChannelId,
      });
    }

    await postSessionContextIfNeeded({
      guild: input.guild,
      session: task.session,
      channel: syncedChannel,
      mentionRoleIds: input.mentionRoleIds,
    });
    markTranscriptBaseline(syncedChannel, task.session);
    result.createdChannels += 1;
    processedSessions += 1;
    await emitProgress({
      phase: "syncing",
      processedSessions,
      currentSessionName: task.session.threadName,
    });
  }

  await emitProgress({ phase: "syncing", processedSessions: 0 });

  for (const session of selectedSessions) {
    const workspaceRoot = session.cwdHint ?? input.defaultWorkspaceRoot;
    const category = await ensureWorkspaceCategory({
      guild: input.guild,
      controlApi: input.controlApi,
      state,
      computerId: input.computerId,
      workspaceRoot,
    });

    if (category.created) {
      result.createdCategories += 1;
      initialWorkspaceRoots.delete(category.workspace.workspaceRoot);
    } else if (initialWorkspaceRoots.has(category.workspace.workspaceRoot)) {
      result.existingCategories += 1;
      countedExistingWorkspaceRoots.add(category.workspace.workspaceRoot);
      initialWorkspaceRoots.delete(category.workspace.workspaceRoot);
    }

    const existingChannel = state.sessionChannels.find((channel) => channel.codexSessionId === session.id);

    sessionTasks.push({
      session,
      workspace: category.workspace,
      categoryCreated: category.created,
      existingChannel: existingChannel ?? null,
    });
  }

  await mapWithConcurrency(sessionTasks, DISCORD_SYNC_CONCURRENCY, async (task) => processSessionTask(task));

  const selectedSessionIds = new Set(selectedSessions.map((session) => session.id.toLowerCase()));
  const selectedWorkspaceRoots = new Set(
    selectedSessions.map((session) => session.cwdHint ?? input.defaultWorkspaceRoot),
  );
  const syncedChannels = state.sessionChannels.filter(
    (channel) => channel.codexSessionId && selectedSessionIds.has(channel.codexSessionId.toLowerCase()),
  );
  const syncedWorkspaces = state.workspaces.filter(
    (workspace) => selectedWorkspaceRoots.has(workspace.workspaceRoot),
  );

  await input.stateStore.update((latestState) => ({
    ...latestState,
    workspaces: [
      ...latestState.workspaces.filter(
        (workspace) => !selectedWorkspaceRoots.has(workspace.workspaceRoot),
      ),
      ...syncedWorkspaces,
    ],
    sessionChannels: [
      ...latestState.sessionChannels.filter(
        (channel) =>
          !channel.codexSessionId ||
          !selectedSessionIds.has(channel.codexSessionId.toLowerCase()),
      ),
      ...syncedChannels,
    ],
  }));
  await emitProgress({ phase: "complete", processedSessions: selectedSessions.length });
  return result;
}
