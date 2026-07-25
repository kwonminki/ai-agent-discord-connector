import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ControlApiClient } from "./controlApiClient.js";
import {
  sanitizeDiscordThreadName,
  workspaceDisplayName,
  workspaceId,
  type DiscordGuildSurface,
} from "./codexSessionSync.js";
import type { DirectSyncState, DirectSyncStateStore, SyncedSessionChannelState } from "./directState.js";

const MAX_CHANNEL_NAME_LENGTH = 90;
const MAX_SESSION_CACHE_ENTRIES = 1_000;

export type ClaudeCodeSessionActivityKind =
  | "assistant_text"
  | "assistant_tool_use"
  | "assistant_other"
  | "tool_result"
  | "user"
  | "attachment"
  | "other";

export interface DiscoveredClaudeCodeSession {
  id: string;
  cwd: string;
  entrypoint: string | null;
  firstUserMessage: string | null;
  latestAssistantMessage: string | null;
  latestAssistantMessageKey: string | null;
  latestActivityKind: ClaudeCodeSessionActivityKind | null;
  updatedAt: string;
  filePath: string;
}

export interface DiscoverClaudeCodeSessionsInput {
  claudeHome?: string;
  projectsRoot?: string;
  updatedAfter?: Date | null;
  excludeSessionIds?: Iterable<string>;
}

export interface SyncClaudeCodeSessionsInput {
  guild: Pick<DiscordGuildSurface, "createThread" | "sendTextMessage">;
  controlApi: Pick<ControlApiClient, "createManagedChannel">;
  stateStore: DirectSyncStateStore;
  computerId: string;
  computerDisplayName: string;
  parentChannelId: string;
  mentionRoleIds?: string[];
  claudeHome?: string;
  lookbackMs: number;
  limit: number;
  now?: Date;
  sessions?: DiscoveredClaudeCodeSession[];
}

export interface SyncClaudeCodeSessionsResult {
  checkedSessions: number;
  createdThreads: number;
  skippedExisting: number;
  skippedOld: number;
  skippedEntrypoint: number;
  skippedUnavailable: boolean;
}

interface ParsedClaudeRecord {
  cwd?: unknown;
  entrypoint?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
  sessionId?: unknown;
  timestamp?: unknown;
  type?: unknown;
}

interface CachedClaudeCodeSession {
  mtimeMs: number;
  size: number;
  lineCount: number;
  endsWithNewline: boolean;
  session: DiscoveredClaudeCodeSession | null;
}

interface ParsedClaudeSessionText {
  session: DiscoveredClaudeCodeSession | null;
  lineCount: number;
  endsWithNewline: boolean;
}

const claudeSessionCache = new Map<string, CachedClaudeCodeSession>();

function defaultClaudeProjectsRoot(claudeHome = path.join(os.homedir(), ".claude")): string {
  return path.join(claudeHome, "projects");
}

function sanitizeChannelName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[`"'’“”]/g, "")
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized.slice(0, MAX_CHANNEL_NAME_LENGTH) || "claude-code-session";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }

      return null;
    })
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n")
    .trim();

  return text || null;
}

function newerIsoTimestamp(current: string | null, next: unknown): string | null {
  const nextText = asString(next);

  if (!nextText) {
    return current;
  }

  const nextTime = Date.parse(nextText);

  if (!Number.isFinite(nextTime)) {
    return current;
  }

  if (!current || nextTime > Date.parse(current)) {
    return new Date(nextTime).toISOString();
  }

  return current;
}

function contentHasPartType(content: unknown, partType: string): boolean {
  return Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === partType,
    );
}

function claudeRecordActivityKind(record: ParsedClaudeRecord): ClaudeCodeSessionActivityKind {
  const role = asString(record.message?.role);
  const type = asString(record.type);

  if (type === "attachment") {
    return "attachment";
  }

  if (role === "assistant" || type === "assistant") {
    if (textFromContent(record.message?.content)) {
      return "assistant_text";
    }

    if (contentHasPartType(record.message?.content, "tool_use")) {
      return "assistant_tool_use";
    }

    return "assistant_other";
  }

  if (role === "user" || type === "user") {
    return contentHasPartType(record.message?.content, "tool_result") ? "tool_result" : "user";
  }

  return "other";
}

async function readTextSliceIfExists(filePath: string, position: number, length: number): Promise<string | null> {
  const handle = await open(filePath, "r").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (!handle) {
    return null;
  }

  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseClaudeCodeSessionText(input: {
  filePath: string;
  fallbackUpdatedAt: string;
  text: string;
  startLineIndex?: number;
  previous?: DiscoveredClaudeCodeSession | null;
}): ParsedClaudeSessionText {
  const fallbackId = path.basename(input.filePath, ".jsonl");
  let sessionId: string | null = input.previous?.id ?? fallbackId ?? null;
  let cwd: string | null = input.previous?.cwd ?? null;
  let entrypoint: string | null = input.previous?.entrypoint ?? null;
  let firstUserMessage: string | null = input.previous?.firstUserMessage ?? null;
  let latestAssistantMessage: string | null = input.previous?.latestAssistantMessage ?? null;
  let latestAssistantMessageKey: string | null = input.previous?.latestAssistantMessageKey ?? null;
  let latestActivityKind: ClaudeCodeSessionActivityKind | null = input.previous?.latestActivityKind ?? null;
  let updatedAt: string | null = input.previous?.updatedAt ?? null;
  const lines = input.text.split(/\r?\n/);
  const lineCount = lines.length - (input.text.endsWith("\n") ? 1 : 0);
  const startLineIndex = input.startLineIndex ?? 0;

  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }

    let record: ParsedClaudeRecord;
    try {
      record = JSON.parse(line) as ParsedClaudeRecord;
    } catch {
      continue;
    }

    sessionId = asString(record.sessionId) ?? sessionId;
    cwd = asString(record.cwd) ?? cwd;
    entrypoint = asString(record.entrypoint) ?? entrypoint;
    const previousUpdatedAt = updatedAt;
    updatedAt = newerIsoTimestamp(updatedAt, record.timestamp);

    if (updatedAt && (updatedAt !== previousUpdatedAt || asString(record.timestamp) === updatedAt)) {
      latestActivityKind = claudeRecordActivityKind(record);
    }

    const role = asString(record.message?.role);
    const type = asString(record.type);
    if (!firstUserMessage && (role === "user" || type === "user")) {
      firstUserMessage = textFromContent(record.message?.content);
    }

    if (role === "assistant" || type === "assistant") {
      const assistantMessage = textFromContent(record.message?.content);

      if (assistantMessage) {
        latestAssistantMessage = assistantMessage;
        const absoluteLineIndex = startLineIndex + lineIndex;
        latestAssistantMessageKey = `${sessionId}:${asString(record.timestamp) ?? absoluteLineIndex}:${absoluteLineIndex}`;
      }
    }
  }

  if (!sessionId || !cwd) {
    return {
      session: null,
      lineCount,
      endsWithNewline: input.text.endsWith("\n"),
    };
  }

  return {
    session: {
      id: sessionId,
      cwd,
      entrypoint,
      firstUserMessage,
      latestAssistantMessage,
      latestAssistantMessageKey,
      latestActivityKind,
      updatedAt: updatedAt ?? input.fallbackUpdatedAt,
      filePath: input.filePath,
    },
    lineCount,
    endsWithNewline: input.text.endsWith("\n"),
  };
}

function rememberClaudeSession(filePath: string, value: CachedClaudeCodeSession): void {
  if (!claudeSessionCache.has(filePath) && claudeSessionCache.size >= MAX_SESSION_CACHE_ENTRIES) {
    const firstKey = claudeSessionCache.keys().next().value;

    if (firstKey) {
      claudeSessionCache.delete(firstKey);
    }
  }

  claudeSessionCache.set(filePath, value);
}

async function parseClaudeCodeSessionFile(input: {
  filePath: string;
  mtimeMs: number;
  size: number;
  fallbackUpdatedAt: string;
}): Promise<DiscoveredClaudeCodeSession | null> {
  const cached = claudeSessionCache.get(input.filePath);

  if (cached && cached.mtimeMs === input.mtimeMs && cached.size === input.size) {
    return cached.session;
  }

  if (cached && cached.endsWithNewline && input.size > cached.size) {
    const appendedText = await readTextSliceIfExists(input.filePath, cached.size, input.size - cached.size);

    if (appendedText !== null) {
      const parsed = parseClaudeCodeSessionText({
        filePath: input.filePath,
        fallbackUpdatedAt: input.fallbackUpdatedAt,
        text: appendedText,
        startLineIndex: cached.lineCount,
        previous: cached.session,
      });
      const nextLineCount = cached.lineCount + parsed.lineCount;

      rememberClaudeSession(input.filePath, {
        mtimeMs: input.mtimeMs,
        size: input.size,
        lineCount: nextLineCount,
        endsWithNewline: parsed.endsWithNewline,
        session: parsed.session,
      });

      return parsed.session;
    }
  }

  const raw = await readFile(input.filePath, "utf8");
  const parsed = parseClaudeCodeSessionText({
    filePath: input.filePath,
    fallbackUpdatedAt: input.fallbackUpdatedAt,
    text: raw,
  });

  rememberClaudeSession(input.filePath, {
    mtimeMs: input.mtimeMs,
    size: input.size,
    lineCount: parsed.lineCount,
    endsWithNewline: parsed.endsWithNewline,
    session: parsed.session,
  });

  return parsed.session;
}

export async function discoverClaudeCodeSessions(
  input: DiscoverClaudeCodeSessionsInput = {},
): Promise<DiscoveredClaudeCodeSession[]> {
  const projectsRoot = input.projectsRoot ?? defaultClaudeProjectsRoot(input.claudeHome);
  const updatedAfterTime = input.updatedAfter ? input.updatedAfter.getTime() : null;
  const excludedSessionIds = new Set(
    [...(input.excludeSessionIds ?? [])].map((sessionId) => sessionId.trim()).filter(Boolean),
  );
  const projectDirs = await readdir(projectsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  });
  const sessions: DiscoveredClaudeCodeSession[] = [];

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = path.join(projectsRoot, projectDir.name);
    const files = await readdir(projectPath, { withFileTypes: true }).catch(() => []);

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) {
        continue;
      }

      const fileSessionId = path.basename(file.name, ".jsonl");
      if (excludedSessionIds.has(fileSessionId)) {
        continue;
      }

      const filePath = path.join(projectPath, file.name);
      const fileStats = await stat(filePath);

      if (updatedAfterTime !== null && fileStats.mtimeMs < updatedAfterTime) {
        continue;
      }

      const session = await parseClaudeCodeSessionFile({
        filePath,
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
        fallbackUpdatedAt: fileStats.mtime.toISOString(),
      });

      if (session) {
        sessions.push(session);
      }
    }
  }

  return sessions.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function isExternallyStartedClaudeCodeSession(session: Pick<DiscoveredClaudeCodeSession, "entrypoint">): boolean {
  const entrypoint = session.entrypoint?.trim().toLowerCase();

  return Boolean(entrypoint && entrypoint !== "sdk-cli");
}

function claudeThreadName(session: DiscoveredClaudeCodeSession): string {
  const title = session.firstUserMessage?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();

  return sanitizeDiscordThreadName(title ?? `Claude Code ${path.basename(session.cwd)}`, `Claude Code ${session.id.slice(0, 8)}`);
}

function claudeSessionTopic(session: DiscoveredClaudeCodeSession): string {
  return [
    `Claude Code session: ${session.id}`,
    `Workspace: ${session.cwd}`,
    session.entrypoint ? `Entrypoint: ${session.entrypoint}` : null,
    `Updated: ${session.updatedAt}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function claudeSessionContextMessage(input: {
  session: DiscoveredClaudeCodeSession;
  computerDisplayName: string;
  threadName: string;
}): string {
  return [
    "**Claude Code 세션 연결됨**",
    `세션: \`${input.threadName.replace(/`/g, "'")}\``,
    `위치: \`${input.session.cwd.replace(/`/g, "'")}\``,
    `업데이트: \`${input.session.updatedAt.replace(/`/g, "'")}\``,
    `Claude session: \`${input.session.id.replace(/`/g, "'")}\``,
    input.session.entrypoint ? `Entrypoint: \`${input.session.entrypoint.replace(/`/g, "'")}\`` : null,
    "",
    `이 스레드에 메시지를 보내면 ${input.computerDisplayName}의 같은 Claude Code 세션으로 이어집니다.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function knownClaudeSessionIds(state: DirectSyncState): Set<string> {
  return new Set(
    state.sessionChannels
      .map((channel) => channel.claudeSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId?.trim()))
      .map((sessionId) => sessionId.trim()),
  );
}

export async function syncClaudeCodeSessionsToDiscord(
  input: SyncClaudeCodeSessionsInput,
): Promise<SyncClaudeCodeSessionsResult> {
  const result: SyncClaudeCodeSessionsResult = {
    checkedSessions: 0,
    createdThreads: 0,
    skippedExisting: 0,
    skippedOld: 0,
    skippedEntrypoint: 0,
    skippedUnavailable: false,
  };

  if (!input.guild.createThread) {
    return { ...result, skippedUnavailable: true };
  }

  const now = input.now ?? new Date();
  const lookbackMs = Math.max(0, input.lookbackMs);
  const updatedAfter = lookbackMs > 0 ? new Date(now.getTime() - lookbackMs) : null;
  const state = await input.stateStore.read();
  const existingClaudeSessionIds = knownClaudeSessionIds(state);
  const discoveredSessions =
    input.sessions ??
    (await discoverClaudeCodeSessions({
      claudeHome: input.claudeHome,
      updatedAfter,
      excludeSessionIds: existingClaudeSessionIds,
    }));
  const selectedSessions = discoveredSessions
    .filter((session) => {
      result.checkedSessions += 1;

      if (updatedAfter && Date.parse(session.updatedAt) < updatedAfter.getTime()) {
        result.skippedOld += 1;
        return false;
      }

      if (!isExternallyStartedClaudeCodeSession(session)) {
        result.skippedEntrypoint += 1;
        return false;
      }

      if (existingClaudeSessionIds.has(session.id)) {
        result.skippedExisting += 1;
        return false;
      }

      return true;
    })
    .slice(0, Math.max(0, input.limit));

  if (selectedSessions.length === 0) {
    return result;
  }

  for (const session of selectedSessions) {
    const created = await createClaudeSessionThreadForSession(input, session);
    state.sessionChannels.push(created.channel);
    existingClaudeSessionIds.add(session.id);
    result.createdThreads += 1;
  }

  return result;
}

interface CreateClaudeSessionThreadInput {
  guild: Pick<DiscordGuildSurface, "createThread" | "sendTextMessage">;
  controlApi: Pick<ControlApiClient, "createManagedChannel">;
  stateStore: DirectSyncStateStore;
  computerId: string;
  computerDisplayName: string;
  parentChannelId: string;
  mentionRoleIds?: string[];
}

async function createClaudeSessionThreadForSession(
  input: CreateClaudeSessionThreadInput,
  session: DiscoveredClaudeCodeSession,
): Promise<{ channelId: string; threadName: string; channel: SyncedSessionChannelState }> {
  if (!input.guild.createThread) {
    throw new Error("Discord thread creation is not available for this bot mode.");
  }

  const threadName = claudeThreadName(session);
  const thread = await input.guild.createThread({
    name: threadName,
    parentChannelId: input.parentChannelId,
    autoArchiveDuration: 10_080,
    reason: claudeSessionTopic(session),
  });
  const sessionWorkspaceId = workspaceId(input.computerId, session.cwd);
  const channel: SyncedSessionChannelState = {
    codexSessionId: null,
    claudeSessionId: session.id,
    threadName,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    workspaceRoot: session.cwd,
    workspaceDisplayName: workspaceDisplayName(session.cwd),
    discordCategoryId: null,
    discordChannelId: thread.id,
    discordParentChannelId: input.parentChannelId,
    discordDeliveryMode: "thread",
    channelMode: "claude-code",
    channelName: sanitizeChannelName(threadName),
    computerId: input.computerId,
    workspaceId: sessionWorkspaceId,
    contextPostedAt: new Date().toISOString(),
  };

  await input.controlApi.createManagedChannel({
    id: `channel:${thread.id}`,
    discordChannelId: thread.id,
    computerId: input.computerId,
    workspaceId: sessionWorkspaceId,
    channelMode: "claude-code",
  });

  await input.stateStore.update((latestState) => ({
    ...latestState,
    sessionChannels: latestState.sessionChannels.some(
      (candidate) => candidate.discordChannelId === channel.discordChannelId,
    )
      ? latestState.sessionChannels
      : [...latestState.sessionChannels, channel],
  }));

  if (input.guild.sendTextMessage) {
    const mentionRoleIds = input.mentionRoleIds?.filter((roleId) => roleId.trim().length > 0);
    await input.guild.sendTextMessage(
      thread.id,
      claudeSessionContextMessage({
        session,
        computerDisplayName: input.computerDisplayName,
        threadName,
      }),
      mentionRoleIds && mentionRoleIds.length > 0 ? { mentionRoleIds } : undefined,
    );
  }

  return { channelId: thread.id, threadName, channel };
}

export async function listResumableClaudeSessions(
  input: { claudeHome?: string; limit?: number } = {},
): Promise<DiscoveredClaudeCodeSession[]> {
  const sessions = await discoverClaudeCodeSessions({ claudeHome: input.claudeHome });

  return sessions
    .filter((session) => Boolean(session.firstUserMessage?.trim()))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, input.limit ?? 25));
}

export type ResumeClaudeCodeSessionResult =
  | { status: "created"; channelId: string; threadName: string }
  | { status: "already-linked"; channelId: string }
  | { status: "not-found" };

export async function resumeClaudeCodeSessionThread(
  input: CreateClaudeSessionThreadInput & {
    guild: Pick<DiscordGuildSurface, "createThread" | "sendTextMessage" | "ensureChannelAvailable">;
    claudeHome?: string;
    sessionId: string;
  },
): Promise<ResumeClaudeCodeSessionResult> {
  const sessionId = input.sessionId.trim();
  const sessions = await discoverClaudeCodeSessions({ claudeHome: input.claudeHome });
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null;

  if (!session) {
    return { status: "not-found" };
  }

  const state = await input.stateStore.read();
  const linkedChannels = state.sessionChannels.filter(
    (channel) => channel.claudeSessionId?.trim() === sessionId,
  );

  for (const linked of linkedChannels) {
    const available = input.guild.ensureChannelAvailable
      ? await input.guild.ensureChannelAvailable(linked.discordChannelId).catch(() => false)
      : true;

    if (available) {
      return { status: "already-linked", channelId: linked.discordChannelId };
    }
  }

  if (linkedChannels.length > 0) {
    // Every recorded thread for this session is gone from Discord; drop the
    // stale links so the fresh thread becomes the session's only mapping.
    await input.stateStore.update((latestState) => ({
      ...latestState,
      sessionChannels: latestState.sessionChannels.filter(
        (channel) => channel.claudeSessionId?.trim() !== sessionId,
      ),
    }));
  }

  const created = await createClaudeSessionThreadForSession(input, session);
  return { status: "created", channelId: created.channelId, threadName: created.threadName };
}
