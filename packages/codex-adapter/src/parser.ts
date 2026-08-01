import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { querySqliteText } from "./sqlite.js";

const SQLITE_SEPARATOR = "\u001f";

export interface CodexSessionIndexEntry {
  id: string;
  threadName: string;
  updatedAt: string;
}

export interface CodexSessionMeta {
  id: string;
  cwd: string;
}

export interface DiscoveredCodexSession extends CodexSessionIndexEntry {
  cwdHint: string | null;
  goalStatus?: CodexSessionGoalStatus;
  contextPreview?: CodexSessionContextMessage[];
  realtimeEvents?: CodexSessionRealtimeEvent[];
}

export type CodexSessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface DiscoverCodexSessionsOptions {
  activeOnly?: boolean;
  includeArchived?: boolean;
  includeSubAgents?: boolean;
  includeExecSessions?: boolean;
  includeSessionIds?: string[];
  includeContextPreview?: boolean;
  includeRealtimeEvents?: boolean;
  contextMessageLimit?: number;
  contextMessageMaxChars?: number;
  realtimeEventLimit?: number;
}

export interface CodexSessionContextMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CodexSessionRealtimeEvent {
  key: string;
  kind: "user" | "assistant" | "status";
  text: string;
  phase?: "commentary" | "final_answer";
}

interface CodexThreadState {
  archived: boolean;
  source: string | null;
  isSubAgent: boolean;
}

type SessionDetails = {
  cwdHint: string | null;
  contextPreview?: CodexSessionContextMessage[];
  realtimeEvents?: CodexSessionRealtimeEvent[];
};

interface CachedSessionDetails {
  mtimeMs: number;
  size: number;
  details: SessionDetails;
}

interface CachedThreadStates {
  mtimeMs: number;
  size: number;
  states: Map<string, CodexThreadState>;
}

interface CachedGoalStatuses {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  statuses: Map<string, CodexSessionGoalStatus>;
}

interface CachedSessionIndex {
  mtimeMs: number;
  size: number;
  entries: CodexSessionIndexEntry[];
}

interface DirectoryEntrySnapshot {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface CachedDirectoryEntries {
  mtimeMs: number;
  size: number;
  entries: DirectoryEntrySnapshot[];
}

const MAX_SESSION_DETAILS_CACHE_ENTRIES = 512;
const SESSION_DETAIL_HEAD_BYTES = 64 * 1024;
const SESSION_DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const sessionDetailsCache = new Map<string, CachedSessionDetails>();
const sessionFilePathCache = new Map<string, string>();
const sessionIndexCache = new Map<string, CachedSessionIndex>();
const threadStatesCache = new Map<string, CachedThreadStates>();
const goalStatusesCache = new Map<string, CachedGoalStatuses>();
const directoryEntriesCache = new Map<string, CachedDirectoryEntries>();

export function parseSessionIndexLine(line: string): CodexSessionIndexEntry {
  const parsed = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };

  if (!parsed.id || !parsed.thread_name || !parsed.updated_at) {
    throw new Error("Invalid Codex session index line");
  }

  return {
    id: parsed.id,
    threadName: parsed.thread_name,
    updatedAt: parsed.updated_at,
  };
}

export function parseSessionMetaLine(line: string): CodexSessionMeta | null {
  let parsed: {
    type?: string;
    payload?: { id?: string; cwd?: string };
  };

  try {
    parsed = JSON.parse(line) as {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
  } catch {
    return null;
  }

  if (parsed.type !== "session_meta" || !parsed.payload?.id || !parsed.payload.cwd) {
    return null;
  }

  return {
    id: parsed.payload.id,
    cwd: parsed.payload.cwd,
  };
}

async function readSessionIndexEntries(indexPath: string): Promise<CodexSessionIndexEntry[] | null> {
  const stats = await statIfExists(indexPath);

  if (!stats) {
    sessionIndexCache.delete(indexPath);
    return null;
  }

  const cached = sessionIndexCache.get(indexPath);

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.entries;
  }

  const indexText = await readTextIfExists(indexPath);

  if (indexText === null) {
    sessionIndexCache.delete(indexPath);
    return null;
  }

  const entries: CodexSessionIndexEntry[] = [];

  for (const line of indexText.split("\n").filter(Boolean)) {
    try {
      entries.push(parseSessionIndexLine(line));
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  sessionIndexCache.set(indexPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    entries,
  });

  return entries;
}

export async function discoverCodexSessions(
  codexHome: string,
  options: DiscoverCodexSessionsOptions = {},
): Promise<DiscoveredCodexSession[]> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const indexEntries = await readSessionIndexEntries(indexPath);

  if (indexEntries === null && (!options.includeSessionIds || options.includeSessionIds.length === 0)) {
    return [];
  }

  const sessionsRoot = path.join(codexHome, "sessions");
  const [archivedSessionIds, threadStates, goalStatuses] = await Promise.all([
    buildArchivedSessionIds(path.join(codexHome, "archived_sessions")),
    readCodexThreadStates(codexHome),
    readCodexGoalStatuses(codexHome),
  ]);
  const entries = indexEntries ?? [];

  const visibleEntries = entries.filter((entry) =>
    shouldIncludeSession(entry.id, {
      archivedSessionIds,
      threadState: threadStates.get(entry.id) ?? null,
      threadStateAvailable: threadStates.size > 0,
      options,
    }),
  );
  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const sessionFilesById = await findSessionFilesByIds(sessionsRoot, visibleEntries.map((entry) => entry.id));
  const explicitEntries: CodexSessionIndexEntry[] = [];

  for (const sessionId of options.includeSessionIds ?? []) {
    if (visibleIds.has(sessionId) || archivedSessionIds.has(sessionId)) {
      continue;
    }

    const sessionFile = sessionFilesById.get(sessionId) ?? await findSessionFileById(sessionsRoot, sessionId);

    if (!sessionFile) {
      continue;
    }

    sessionFilesById.set(sessionId, sessionFile);
    explicitEntries.push(await fallbackSessionIndexEntry(sessionFile, sessionId));
    visibleIds.add(sessionId);
  }

  return Promise.all(
    [...visibleEntries, ...explicitEntries].map(async (entry) => {
      const details = await findSessionDetails(sessionFilesById, entry.id, options);
      return {
        ...entry,
        cwdHint: details.cwdHint,
        ...(goalStatuses.get(entry.id) ? { goalStatus: goalStatuses.get(entry.id) } : {}),
        ...(details.contextPreview ? { contextPreview: details.contextPreview } : {}),
        ...(details.realtimeEvents ? { realtimeEvents: details.realtimeEvents } : {}),
      };
    }),
  );
}

async function fallbackSessionIndexEntry(sessionFile: string, sessionId: string): Promise<CodexSessionIndexEntry> {
  const text = (await readTextIfExists(sessionFile)) ?? "";
  const timestamps = text
    .split("\n")
    .map((line) => parseLineTimestamp(line))
    .filter((timestamp): timestamp is string => timestamp !== null);
  const contextPreview = parseSessionContextPreview(text, {
    messageLimit: 1,
    messageMaxChars: 80,
  });
  const firstMessage = contextPreview[0]?.text.split("\n")[0]?.trim();

  return {
    id: sessionId,
    threadName: firstMessage || `Codex session ${sessionId.slice(0, 8)}`,
    updatedAt: timestamps.at(-1) ?? new Date(0).toISOString(),
  };
}

function parseLineTimestamp(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    return typeof parsed.timestamp === "string" && parsed.timestamp.length > 0 ? parsed.timestamp : null;
  } catch {
    return null;
  }
}

function shouldIncludeSession(
  sessionId: string,
  input: {
    archivedSessionIds: Set<string>;
    threadState: CodexThreadState | null;
    threadStateAvailable: boolean;
    options: DiscoverCodexSessionsOptions;
  },
): boolean {
  if (input.options.activeOnly) {
    if (input.archivedSessionIds.has(sessionId) || !input.threadState) {
      return false;
    }

    return isActiveThreadState(input.threadState);
  }

  if (!input.options.includeArchived && input.archivedSessionIds.has(sessionId)) {
    return false;
  }

  if (!input.threadState) {
    if (input.threadStateAvailable) {
      return false;
    }

    return true;
  }

  if (!input.options.includeArchived && input.threadState.archived) {
    return false;
  }

  if (!input.options.includeSubAgents && input.threadState.isSubAgent) {
    return false;
  }

  if (!input.options.includeExecSessions && isNonInteractiveThreadSource(input.threadState.source)) {
    return false;
  }

  return true;
}

function isActiveThreadState(threadState: CodexThreadState): boolean {
  return (
    !threadState.archived &&
    !threadState.isSubAgent &&
    !isNonInteractiveThreadSource(threadState.source)
  );
}

function isNonInteractiveThreadSource(source: string | null): boolean {
  return source === "exec" || source === "cli";
}

async function findSessionDetails(
  sessionFilesById: Map<string, string>,
  sessionId: string,
  options: DiscoverCodexSessionsOptions,
): Promise<SessionDetails> {
  const sessionFile = sessionFilesById.get(sessionId);

  if (!sessionFile) {
    return { cwdHint: null };
  }

  const stats = await statIfExists(sessionFile);

  if (!stats) {
    return { cwdHint: null };
  }

  const cacheKey = sessionDetailsCacheKey(sessionFile, options);
  const cached = sessionDetailsCache.get(cacheKey);

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.details;
  }

  if (cached && stats.size > cached.size) {
    const appendedText = await readTextSliceIfExists(sessionFile, cached.size, stats.size - cached.size);

    if (appendedText !== null) {
      const details = mergeSessionDetails(
        cached.details,
        parseSessionDetailsText(sessionId, appendedText, options),
        options,
      );

      rememberSessionDetails(cacheKey, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        details,
      });

      return details;
    }
  }

  const details = await readSessionDetailsFromFile(sessionFile, sessionId, stats.size, options);

  if (details === null) {
    sessionDetailsCache.delete(cacheKey);
    return { cwdHint: null };
  }

  rememberSessionDetails(cacheKey, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    details,
  });

  return details;
}

async function readSessionDetailsFromFile(
  sessionFile: string,
  sessionId: string,
  size: number,
  options: DiscoverCodexSessionsOptions,
): Promise<SessionDetails | null> {
  if (size <= SESSION_DETAIL_HEAD_BYTES + SESSION_DETAIL_TAIL_BYTES) {
    const text = await readTextIfExists(sessionFile);
    return text === null ? null : parseSessionDetailsText(sessionId, text, options);
  }

  const tailStart = Math.max(0, size - SESSION_DETAIL_TAIL_BYTES);
  const [headText, rawTailText] = await Promise.all([
    readTextSliceIfExists(sessionFile, 0, Math.min(size, SESSION_DETAIL_HEAD_BYTES)),
    readTextSliceIfExists(sessionFile, tailStart, size - tailStart),
  ]);

  if (headText === null || rawTailText === null) {
    return null;
  }

  const tailText = tailStart > 0 ? dropLeadingPartialLine(rawTailText) : rawTailText;
  const tailDetails = parseSessionDetailsText(sessionId, tailText, options);

  return {
    ...tailDetails,
    cwdHint: tailDetails.cwdHint ?? parseSessionCwdHint(sessionId, headText),
  };
}

function parseSessionDetailsText(
  sessionId: string,
  text: string,
  options: DiscoverCodexSessionsOptions,
): SessionDetails {
  return {
    cwdHint: parseSessionCwdHint(sessionId, text),
    ...(options.includeContextPreview
      ? {
          contextPreview: parseSessionContextPreview(text, {
            messageLimit: contextMessageLimit(options),
            messageMaxChars: contextMessageMaxChars(options),
          }),
        }
      : {}),
    ...(options.includeRealtimeEvents
      ? {
          realtimeEvents: parseSessionRealtimeEvents(text, {
            eventLimit: realtimeEventLimit(options),
            messageMaxChars: contextMessageMaxChars(options),
          }),
        }
      : {}),
  };
}

function parseSessionCwdHint(sessionId: string, text: string): string | null {
  for (const line of text.split("\n").filter(Boolean)) {
    const meta = parseSessionMetaLine(line);
    if (meta?.id === sessionId) {
      return meta.cwd;
    }
  }

  return null;
}

function dropLeadingPartialLine(text: string): string {
  const firstNewlineIndex = text.indexOf("\n");

  return firstNewlineIndex >= 0 ? text.slice(firstNewlineIndex + 1) : "";
}

function mergeSessionDetails(
  previous: SessionDetails,
  appended: SessionDetails,
  options: DiscoverCodexSessionsOptions,
): SessionDetails {
  return {
    cwdHint: appended.cwdHint ?? previous.cwdHint,
    ...(options.includeContextPreview
      ? {
          contextPreview: [
            ...(previous.contextPreview ?? []),
            ...(appended.contextPreview ?? []),
          ].slice(-contextMessageLimit(options)),
        }
      : {}),
    ...(options.includeRealtimeEvents
      ? {
          realtimeEvents: [
            ...(previous.realtimeEvents ?? []),
            ...(appended.realtimeEvents ?? []),
          ].slice(-realtimeEventLimit(options)),
        }
      : {}),
  };
}

function contextMessageLimit(options: DiscoverCodexSessionsOptions): number {
  return Math.max(1, options.contextMessageLimit ?? 6);
}

function contextMessageMaxChars(options: DiscoverCodexSessionsOptions): number {
  return options.contextMessageMaxChars ?? 1_000;
}

function realtimeEventLimit(options: DiscoverCodexSessionsOptions): number {
  return Math.max(1, options.realtimeEventLimit ?? 30);
}

function sessionDetailsCacheKey(sessionFile: string, options: DiscoverCodexSessionsOptions): string {
  return [
    sessionFile,
    options.includeContextPreview ? "context" : "no-context",
    options.includeRealtimeEvents ? "realtime" : "no-realtime",
    options.contextMessageLimit ?? 6,
    options.contextMessageMaxChars ?? 1_000,
    options.realtimeEventLimit ?? 30,
  ].join("\0");
}

function rememberSessionDetails(cacheKey: string, value: CachedSessionDetails) {
  if (!sessionDetailsCache.has(cacheKey) && sessionDetailsCache.size >= MAX_SESSION_DETAILS_CACHE_ENTRIES) {
    const firstKey = sessionDetailsCache.keys().next().value;

    if (firstKey) {
      sessionDetailsCache.delete(firstKey);
    }
  }

  sessionDetailsCache.set(cacheKey, value);
}

async function findSessionFilesByIds(root: string, sessionIds: string[]): Promise<Map<string, string>> {
  const filesById = new Map<string, string>();
  const uniqueSessionIds = [...new Set(sessionIds)];

  await Promise.all(
    uniqueSessionIds.map(async (sessionId) => {
      const sessionFile = await findSessionFileById(root, sessionId);

      if (sessionFile) {
        filesById.set(sessionId, sessionFile);
      }
    }),
  );

  return filesById;
}

async function findSessionFileById(root: string, sessionId: string): Promise<string | null> {
  const cacheKey = sessionFilePathCacheKey(root, sessionId);
  const cachedPath = sessionFilePathCache.get(cacheKey);

  if (cachedPath) {
    const cachedStats = await statIfExists(cachedPath);

    if (cachedStats?.isFile) {
      return cachedPath;
    }

    sessionFilePathCache.delete(cacheKey);
  }

  for (const directory of candidateSessionDirectories(root, sessionId)) {
    const sessionFile = await findSessionFileInDirectory(directory, sessionId);

    if (sessionFile) {
      sessionFilePathCache.set(cacheKey, sessionFile);
      return sessionFile;
    }
  }

  const sessionFilesById = await buildSessionFileIndex(root);
  const sessionFile = sessionFilesById.get(sessionId) ?? null;

  if (sessionFile) {
    sessionFilePathCache.set(cacheKey, sessionFile);
  }

  return sessionFile;
}

function sessionFilePathCacheKey(root: string, sessionId: string): string {
  return `${root}\0${sessionId}`;
}

async function findSessionFileInDirectory(directory: string, sessionId: string): Promise<string | null> {
  const entries = await listDirectoryEntries(directory);
  const sessionFileName = entries
    .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .find((name) => name.endsWith(`-${sessionId}.jsonl`));

  return sessionFileName ? path.join(directory, sessionFileName) : null;
}

function candidateSessionDirectories(root: string, sessionId: string): string[] {
  const timestampMs = uuidV7TimestampMs(sessionId);

  if (timestampMs === null) {
    return [];
  }

  const oneDayMs = 24 * 60 * 60 * 1_000;
  const dateParts: string[] = [];

  for (const dayOffset of [-1, 0, 1]) {
    const date = new Date(timestampMs + dayOffset * oneDayMs);
    dateParts.push(formatLocalDatePath(date), formatUtcDatePath(date));
  }

  return [...new Set(dateParts)].map((datePath) => path.join(root, datePath));
}

function uuidV7TimestampMs(sessionId: string): number | null {
  const normalized = sessionId.replace(/-/g, "").toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    return null;
  }

  const timestampMs = Number.parseInt(normalized.slice(0, 12), 16);

  return Number.isSafeInteger(timestampMs) ? timestampMs : null;
}

function formatLocalDatePath(date: Date): string {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join(path.sep);
}

function formatUtcDatePath(date: Date): string {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join(path.sep);
}

async function buildSessionFileIndex(root: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const files = await listJsonlFiles(root);

  for (const file of files) {
    const match = path.basename(file).match(/^.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (match) {
      index.set(match[1], file);
      sessionFilePathCache.set(sessionFilePathCacheKey(root, match[1]), file);
    }
  }

  return index;
}

async function buildArchivedSessionIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const files = await listJsonlFiles(root);

  for (const file of files) {
    const match = path.basename(file).match(/^.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (match) {
      ids.add(match[1]);
    }
  }

  return ids;
}

async function readCodexThreadStates(codexHome: string): Promise<Map<string, CodexThreadState>> {
  const databasePath = await findCodexStateDatabase(codexHome);

  if (!databasePath) {
    return new Map();
  }

  const stats = await statIfExists(databasePath);

  if (!stats) {
    return new Map();
  }

  const cached = threadStatesCache.get(databasePath);

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.states;
  }

  try {
    const stdout = await querySqliteText(
      databasePath,
      [
        `select 'thread' || char(31) || id || char(31) || archived || char(31) || source from threads;`,
        `select 'edge' || char(31) || child_thread_id from thread_spawn_edges;`,
      ].join("\n"),
    );

    const states = parseCodexThreadStateRows(stdout);

    threadStatesCache.set(databasePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      states,
    });

    return states;
  } catch {
    return new Map();
  }
}

async function readCodexGoalStatuses(codexHome: string): Promise<Map<string, CodexSessionGoalStatus>> {
  const databasePath = await findCodexVersionedDatabase(codexHome, "goals");

  if (!databasePath) {
    return new Map();
  }

  const [stats, walStats] = await Promise.all([
    statIfExists(databasePath),
    statIfExists(`${databasePath}-wal`),
  ]);

  if (!stats) {
    return new Map();
  }

  const cached = goalStatusesCache.get(databasePath);
  const walMtimeMs = walStats?.mtimeMs ?? 0;
  const walSize = walStats?.size ?? 0;

  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size &&
    cached.walMtimeMs === walMtimeMs &&
    cached.walSize === walSize
  ) {
    return cached.statuses;
  }

  try {
    const stdout = await querySqliteText(
      databasePath,
      `select thread_id || char(31) || status from thread_goals;`,
    );
    const statuses = parseCodexGoalStatusRows(stdout);

    goalStatusesCache.set(databasePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      walMtimeMs,
      walSize,
      statuses,
    });

    return statuses;
  } catch {
    return new Map();
  }
}

function parseCodexGoalStatusRows(stdout: string): Map<string, CodexSessionGoalStatus> {
  const statuses = new Map<string, CodexSessionGoalStatus>();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [threadId, rawStatus] = line.split(SQLITE_SEPARATOR);
    const status = normalizeCodexGoalStatus(rawStatus);

    if (threadId && status) {
      statuses.set(threadId, status);
    }
  }

  return statuses;
}

function normalizeCodexGoalStatus(value: string | undefined): CodexSessionGoalStatus | null {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usage_limited":
      return "usageLimited";
    case "budget_limited":
      return "budgetLimited";
    default:
      return null;
  }
}

function parseCodexThreadStateRows(stdout: string): Map<string, CodexThreadState> {
  const states = new Map<string, CodexThreadState>();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split(SQLITE_SEPARATOR);
    const rowType = fields[0];

    if (rowType === "thread") {
      const [, id, archived, source = ""] = fields;
      if (!id) {
        continue;
      }

      states.set(id, {
        archived: archived === "1",
        source,
        isSubAgent: source.trimStart().startsWith('{"subagent"'),
      });
      continue;
    }

    if (rowType === "edge") {
      const childThreadId = fields[1];
      if (!childThreadId) {
        continue;
      }

      const previous = states.get(childThreadId);
      states.set(childThreadId, {
        archived: previous?.archived ?? false,
        source: previous?.source ?? null,
        isSubAgent: true,
      });
    }
  }

  return states;
}

function parseSessionContextPreview(
  text: string,
  options: { messageLimit: number; messageMaxChars: number },
): CodexSessionContextMessage[] {
  const messages: CodexSessionContextMessage[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    const message = parseContextMessageLine(line, options.messageMaxChars);

    if (message) {
      messages.push(message);
    }
  }

  return messages.slice(-Math.max(1, options.messageLimit));
}

function parseSessionRealtimeEvents(
  text: string,
  options: { eventLimit: number; messageMaxChars: number },
): CodexSessionRealtimeEvent[] {
  const events: CodexSessionRealtimeEvent[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    const event = parseRealtimeEventLine(line, options.messageMaxChars);

    if (event) {
      events.push(event);
    }
  }

  return events.slice(-Math.max(1, options.eventLimit));
}

function parseContextMessageLine(line: string, messageMaxChars: number): CodexSessionContextMessage | null {
  let parsed: {
    type?: string;
    payload?: {
      type?: string;
      role?: string;
      phase?: string;
      content?: unknown;
    };
  };

  try {
    parsed = JSON.parse(line) as {
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        phase?: string;
        content?: unknown;
      };
    };
  } catch {
    return null;
  }

  if (parsed.type !== "response_item" || parsed.payload?.type !== "message") {
    return null;
  }

  if (parsed.payload.role === "assistant" && parsed.payload.phase !== "final_answer") {
    return null;
  }

  if (parsed.payload.role !== "user" && parsed.payload.role !== "assistant") {
    return null;
  }

  const rawText = extractContentText(parsed.payload.content);
  const text =
    parsed.payload.role === "user"
      ? normalizeUserContextText(rawText)
      : normalizeContextText(rawText);

  if (!text) {
    return null;
  }

  return {
    role: parsed.payload.role,
    text: truncateContextText(text, messageMaxChars),
  };
}

function parseRealtimeEventLine(line: string, messageMaxChars: number): CodexSessionRealtimeEvent | null {
  let parsed:
    | {
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          phase?: string;
          content?: unknown;
          name?: string;
          arguments?: unknown;
        };
      }
    | undefined;

  try {
    parsed = JSON.parse(line) as {
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        phase?: string;
        content?: unknown;
        name?: string;
        arguments?: unknown;
      };
    };
  } catch {
    return null;
  }

  if (!parsed || !parsed.type || !parsed.payload) {
    return null;
  }

  if (parsed.type === "response_item" && parsed.payload.type === "message") {
    if (parsed.payload.role === "user") {
      const text = normalizeUserContextText(extractContentText(parsed.payload.content));

      return text
        ? {
            key: hashSessionEventLine(line),
            kind: "user",
            text: truncateContextText(text, messageMaxChars),
          }
        : null;
    }

    if (parsed.payload.role === "assistant") {
      const text = normalizeContextText(extractContentText(parsed.payload.content));
      const phase = parsed.payload.phase === "commentary" || parsed.payload.phase === "final_answer"
        ? parsed.payload.phase
        : null;

      return text
        ? {
            key: hashSessionEventLine(line),
            kind: "assistant",
            text: truncateContextText(text, messageMaxChars),
            ...(phase ? { phase } : {}),
          }
        : null;
    }
  }

  if (
    parsed.type === "response_item" &&
    (parsed.payload.type === "function_call" || parsed.payload.type === "custom_tool_call")
  ) {
    const statusText = parseRealtimeStatusText({
      name: parsed.payload.name ?? "",
      arguments: parsed.payload.arguments,
    });

    return statusText
      ? {
          key: hashSessionEventLine(line),
          kind: "status",
          text: truncateContextText(statusText, messageMaxChars),
        }
      : null;
  }

  if (parsed.type === "event_msg" && parsed.payload.type === "task_started") {
    return {
      key: hashSessionEventLine(line),
      kind: "status",
      text: "작업 시작",
    };
  }

  if (parsed.type === "event_msg" && parsed.payload.type === "task_complete") {
    return {
      key: hashSessionEventLine(line),
      kind: "status",
      text: "작업 완료",
    };
  }

  return null;
}

function hashSessionEventLine(line: string): string {
  return createHash("sha1").update(line).digest("hex");
}

function parseRealtimeStatusText(input: { name: string; arguments: unknown }): string | null {
  const name = input.name.trim();
  const args = parseToolArguments(input.arguments);
  const searchable = `${name} ${args.command ?? ""}`.toLowerCase();

  if (
    searchable.includes("image") ||
    searchable.includes("imagegen") ||
    searchable.includes("generate_image") ||
    searchable.includes("dall-e")
  ) {
    return formatRealtimeStatus("이미지 생성 중", [args.command, name]);
  }

  if (
    searchable.includes("rg --files") ||
    searchable.includes("find ") ||
    searchable.includes("glob") ||
    searchable.includes("file_search")
  ) {
    return formatRealtimeStatus("파일 탐색 중", [args.command]);
  }

  if (searchable.includes("web_search") || searchable.includes("search_query")) {
    return formatRealtimeStatus("웹 검색 중", [args.command, name]);
  }

  if (searchable.includes("apply_patch") || searchable.includes("write") || searchable.includes("edit")) {
    return formatRealtimeStatus("파일 수정 중", [args.command, name]);
  }

  if (name === "exec_command" || searchable.includes("shell")) {
    return formatRealtimeStatus("명령 실행 중", [args.command, name === "exec_command" ? null : name]);
  }

  return name ? formatRealtimeStatus("도구 실행 중", [name, args.command]) : null;
}

function parseToolArguments(value: unknown): { command: string | null } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { command: null };
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const command = parsed.cmd ?? parsed.command ?? parsed.query ?? parsed.prompt;
    return {
      command: typeof command === "string" && command.trim().length > 0 ? normalizeRealtimeDetail(command) : null,
    };
  } catch {
    return { command: null };
  }
}

function normalizeRealtimeDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function formatRealtimeStatus(label: string, parts: Array<string | null>): string {
  const detail = parts.filter((part): part is string => Boolean(part && part.trim().length > 0)).join(" · ");
  return detail.length > 0 ? `${label} · ${detail}` : label;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (typeof item === "object" && item !== null && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeUserContextText(value: string): string {
  const requestMarker = "## My request for Codex:";
  const markerIndex = value.indexOf(requestMarker);
  const requestText = markerIndex >= 0 ? value.slice(markerIndex + requestMarker.length) : value;
  const normalized = normalizeContextText(requestText);

  if (
    normalized.startsWith("# AGENTS.md instructions") ||
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<permissions instructions>")
  ) {
    return "";
  }

  return normalized;
}

function normalizeContextText(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function truncateContextText(value: string, maxChars: number): string {
  const limit = Math.max(120, maxChars);

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 16).trimEnd()}\n... (truncated)`;
}

async function findCodexStateDatabase(codexHome: string): Promise<string | null> {
  return findCodexVersionedDatabase(codexHome, "state");
}

async function findCodexVersionedDatabase(codexHome: string, prefix: string): Promise<string | null> {
  let entries: import("node:fs").Dirent[];

  try {
    entries = await fs.readdir(codexHome, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(new RegExp(`^${prefix}_(\\d+)\\.sqlite$`));
      return match
        ? {
            version: Number.parseInt(match[1], 10),
            filePath: path.join(codexHome, entry.name),
          }
        : null;
    })
    .filter((candidate): candidate is { version: number; filePath: string } => candidate !== null)
    .sort((a, b) => b.version - a.version);

  return candidates[0]?.filePath ?? null;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await listDirectoryEntries(root);

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory) {
        return listJsonlFiles(fullPath);
      }

      return entry.isFile && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    }),
  );

  return nested.flat();
}

async function listDirectoryEntries(root: string): Promise<DirectoryEntrySnapshot[]> {
  const stats = await statIfExists(root);

  if (!stats?.isDirectory) {
    directoryEntriesCache.delete(root);
    return [];
  }

  const cached = directoryEntriesCache.get(root);

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.entries;
  }

  let entries: import("node:fs").Dirent[];

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      directoryEntriesCache.delete(root);
      return [];
    }

    throw error;
  }

  const snapshots = entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
  }));

  directoryEntriesCache.set(root, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    entries: snapshots,
  });

  return snapshots;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    throw error;
  }
}

async function readTextSliceIfExists(filePath: string, start: number, length: number): Promise<string | null> {
  let handle: fs.FileHandle | null = null;

  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    throw error;
  } finally {
    await handle?.close();
  }
}

async function statIfExists(filePath: string): Promise<{
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
} | null> {
  try {
    const stats = await fs.stat(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    };
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    throw error;
  }
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
