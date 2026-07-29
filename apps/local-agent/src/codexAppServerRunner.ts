import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readlink, rm, stat, symlink, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type {
  CodexApprovalChoice,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexRunnerProgressEvent,
  CodexUserInputQuestion,
  CodexUserInputRequest,
  CodexUserInputResponse,
  CodexGoalStatus,
  RunCodexPromptInput,
  RunCodexPromptResult,
} from "./codexRunner.js";

interface RunCodexAppServerPromptInput extends RunCodexPromptInput {
  appServerSocketPath?: string;
  appServerUrl?: string;
}

export interface CodexSessionIdleNotification {
  controlKey: string;
  sessionId: string | null;
  message: string;
  isError: boolean;
  at: string;
}

type CodexSessionIdleNotificationSink = (
  notification: CodexSessionIdleNotification,
) => Promise<void> | void;

interface AppServerTransport {
  listenUrl: string;
  clientUrl: string;
  readiness:
    | { kind: "unix"; socketPath: string }
    | { kind: "tcp"; host: string; port: number }
    | null;
  tempRoot: string | null;
  managed: boolean;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface JsonRpcNotification {
  method?: unknown;
  params?: unknown;
  id?: unknown;
}

interface ThreadStartResponse {
  thread?: {
    id?: unknown;
  };
  newThread?: {
    id?: unknown;
  };
}

interface TurnCompletedParams {
  turn?: {
    status?: unknown;
    error?: {
      message?: unknown;
      additionalDetails?: unknown;
    } | null;
  };
}

interface TurnStartResponse {
  turn?: {
    id?: unknown;
  };
}

interface ItemNotificationParams {
  item?: {
    id?: unknown;
    type?: unknown;
    text?: unknown;
    content?: unknown;
    output?: unknown;
    phase?: unknown;
    result?: unknown;
    summary?: unknown;
    command?: unknown;
    cwd?: unknown;
    aggregatedOutput?: unknown;
    exitCode?: unknown;
    durationMs?: unknown;
    changes?: unknown;
    server?: unknown;
    tool?: unknown;
    arguments?: unknown;
    error?: unknown;
    namespace?: unknown;
    contentItems?: unknown;
    success?: unknown;
    query?: unknown;
    status?: unknown;
  };
  delta?: unknown;
  itemId?: unknown;
}

const APP_SERVER_ERROR_CODE = "CODEX_APP_SERVER_FAILED";
const APP_SERVER_UNSUPPORTED_REVIEW_CODE = "CODEX_APP_SERVER_REVIEW_UNSUPPORTED";
const APP_SERVER_CLIENT_NAME = "ai-agent-discord-connector";
const APP_SERVER_APPROVAL_POLICY = "never";
const APP_SERVER_APPROVALS_REVIEWER = "user";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexAppServerTurnControlResult {
  status: "accepted" | "no-active-turn" | "failed";
  message: string;
  threadId?: string;
  turnId?: string;
}

interface ActiveCodexAppServerTurn {
  threadId: string;
  turnId: string;
  request(method: string, params: unknown): Promise<unknown>;
}

const activeTurnsByControlKey = new Map<string, ActiveCodexAppServerTurn>();

function isActiveTurnMismatch(error: unknown): boolean {
  return error instanceof Error &&
    /expected active turn id\b.*\bfound\b/i.test(error.message);
}

function inProgressTurnId(response: unknown, expectedThreadId: string): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }

  const thread = (response as {
    thread?: {
      id?: unknown;
      turns?: unknown;
    };
  }).thread;

  if (
    !thread ||
    (typeof thread.id === "string" && thread.id !== expectedThreadId) ||
    !Array.isArray(thread.turns)
  ) {
    return null;
  }

  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (
      typeof turn === "object" &&
      turn !== null &&
      (turn as { status?: unknown }).status === "inProgress" &&
      typeof (turn as { id?: unknown }).id === "string"
    ) {
      return (turn as { id: string }).id;
    }
  }

  return null;
}

function codexGoalStatus(value: unknown): CodexGoalStatus | null {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
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

export async function steerActiveCodexAppServerTurn(
  controlKey: string,
  content: string,
): Promise<CodexAppServerTurnControlResult> {
  const activeTurn = activeTurnsByControlKey.get(controlKey);

  if (!activeTurn) {
    return {
      status: "no-active-turn",
      message: "현재 이 Discord 채널에서 실행 중인 Codex turn이 없습니다.",
    };
  }

  const prompt = content.trim();

  if (!prompt) {
    return { status: "failed", message: "Steering 지시가 비어 있습니다." };
  }

  const steer = (turnId: string) =>
    activeTurn.request("turn/steer", {
      threadId: activeTurn.threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });

  try {
    await steer(activeTurn.turnId);
    return {
      status: "accepted",
      message: "현재 Codex turn에 추가 지시를 전달했습니다.",
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    };
  } catch (error) {
    if (isActiveTurnMismatch(error)) {
      try {
        const threadResult = await activeTurn.request("thread/read", {
          threadId: activeTurn.threadId,
          includeTurns: true,
        });
        const refreshedTurnId = inProgressTurnId(threadResult, activeTurn.threadId);

        if (refreshedTurnId && refreshedTurnId !== activeTurn.turnId) {
          await steer(refreshedTurnId);
          activeTurn.turnId = refreshedTurnId;
          return {
            status: "accepted",
            message: "현재 Codex turn을 다시 확인한 뒤 추가 지시를 전달했습니다.",
            threadId: activeTurn.threadId,
            turnId: refreshedTurnId,
          };
        }
      } catch (retryError) {
        error = retryError;
      }
    }

    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Codex steering 요청에 실패했습니다.",
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    };
  }
}

export async function interruptActiveCodexAppServerTurn(
  controlKey: string,
): Promise<CodexAppServerTurnControlResult> {
  const activeTurn = activeTurnsByControlKey.get(controlKey);

  if (!activeTurn) {
    return {
      status: "no-active-turn",
      message: "현재 이 Discord 채널에서 실행 중인 Codex turn이 없습니다.",
    };
  }

  const interrupt = (turnId: string) =>
    activeTurn.request("turn/interrupt", {
      threadId: activeTurn.threadId,
      turnId,
    });

  try {
    await interrupt(activeTurn.turnId);
    return {
      status: "accepted",
      message: "현재 Codex turn에 중단 요청을 전달했습니다.",
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    };
  } catch (error) {
    if (isActiveTurnMismatch(error)) {
      try {
        const threadResult = await activeTurn.request("thread/read", {
          threadId: activeTurn.threadId,
          includeTurns: true,
        });
        const refreshedTurnId = inProgressTurnId(threadResult, activeTurn.threadId);

        if (refreshedTurnId && refreshedTurnId !== activeTurn.turnId) {
          await interrupt(refreshedTurnId);
          activeTurn.turnId = refreshedTurnId;
          return {
            status: "accepted",
            message: "현재 Codex turn을 다시 확인한 뒤 중단 요청을 전달했습니다.",
            threadId: activeTurn.threadId,
            turnId: refreshedTurnId,
          };
        }
      } catch (retryError) {
        error = retryError;
      }
    }

    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Codex 중단 요청에 실패했습니다.",
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    };
  }
}

function isAscii(value: string): boolean {
  return /^[\x00-\x7F]*$/.test(value);
}

function workspaceAliasName(workspaceRoot: string): string {
  return Buffer.from(workspaceRoot).toString("hex").slice(0, 48);
}

async function ensureAsciiWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);

  if (process.platform === "win32" || isAscii(resolvedWorkspaceRoot)) {
    return resolvedWorkspaceRoot;
  }

  const aliasRoot = path.join(os.tmpdir(), "codex-discord-workspaces");
  const aliasPath = path.join(aliasRoot, workspaceAliasName(resolvedWorkspaceRoot));
  await mkdir(aliasRoot, { recursive: true });

  try {
    if ((await readlink(aliasPath)) === resolvedWorkspaceRoot) {
      return aliasPath;
    }

    await unlink(aliasPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  await symlink(resolvedWorkspaceRoot, aliasPath, "dir");
  return aliasPath;
}

function appServerSocketUrl(socketPath: string): string {
  return `ws+unix://${socketPath}:/`;
}

function appServerListenUrl(socketPath: string): string {
  return `unix://${socketPath}`;
}

export function defaultAppServerTransportKind(
  platform: NodeJS.Platform = process.platform,
): "unix" | "tcp" {
  return platform === "win32" ? "tcp" : "unix";
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Could not allocate a loopback port for Codex app-server.");
    }

    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function prepareAppServerTransport(
  input: RunCodexAppServerPromptInput,
): Promise<AppServerTransport> {
  if (input.appServerUrl) {
    return {
      listenUrl: input.appServerUrl,
      clientUrl: input.appServerUrl,
      readiness: null,
      tempRoot: null,
      managed: false,
    };
  }

  if (input.appServerSocketPath) {
    return {
      listenUrl: appServerListenUrl(input.appServerSocketPath),
      clientUrl: appServerSocketUrl(input.appServerSocketPath),
      readiness: null,
      tempRoot: null,
      managed: false,
    };
  }

  if (defaultAppServerTransportKind() === "tcp") {
    const host = "127.0.0.1";
    const port = await reserveLoopbackPort();
    const url = `ws://${host}:${port}`;

    return {
      listenUrl: url,
      clientUrl: url,
      readiness: { kind: "tcp", host, port },
      tempRoot: null,
      managed: true,
    };
  }

  const tempRoot = await mkdtemp(path.join(os.homedir(), ".codex-discord-appserver-"));
  const socketPath = path.join(tempRoot, "app.sock");

  return {
    listenUrl: appServerListenUrl(socketPath),
    clientUrl: appServerSocketUrl(socketPath),
    readiness: { kind: "unix", socketPath },
    tempRoot,
    managed: true,
  };
}

function compactDetail(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 480);
}

function structuredDetail(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim().length > 0 ? compactDetail(value) : null;
  }

  try {
    const serialized = JSON.stringify(value, (key, nestedValue) =>
      /token|secret|password|authorization|cookie|api.?key/i.test(key) ? "[redacted]" : nestedValue,
    );
    return serialized && serialized !== "{}" && serialized !== "[]" ? compactDetail(serialized) : null;
  } catch {
    return null;
  }
}

function fileChangeDetail(changes: unknown): string | null {
  if (!Array.isArray(changes)) {
    return null;
  }

  const descriptions = changes.slice(0, 6).flatMap((change) => {
    if (typeof change !== "object" || change === null) {
      return [];
    }

    const record = change as Record<string, unknown>;
    const filePath = typeof record.path === "string" ? record.path : "unknown file";
    const kind = typeof record.kind === "string" ? record.kind : "update";
    const diff = typeof record.diff === "string" ? record.diff : "";
    const additions = diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = diff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return [`${kind} ${filePath} (+${additions} -${deletions})`];
  });

  if (changes.length > 6) {
    descriptions.push(`외 ${changes.length - 6}개 파일`);
  }

  return descriptions.length > 0 ? compactDetail(descriptions.join(" · ")) : null;
}

function extractTextValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextValues(item));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  return ["text", "summary_text", "message", "content", "output", "result"]
    .flatMap((key) => extractTextValues(record[key]))
    .filter((text) => text.length > 0);
}

function itemProgressDetail(item: ItemNotificationParams["item"]): string | undefined {
  if (!item) {
    return undefined;
  }

  const type = typeof item.type === "string" ? item.type : "";

  if (type === "reasoning") {
    const summary = extractTextValues(item.summary).join(" ");
    return summary.trim().length > 0 ? compactDetail(summary) : undefined;
  }

  if (type === "commandExecution") {
    const parts = [
      typeof item.command === "string" ? `명령: ${item.command}` : null,
      typeof item.cwd === "string" ? `위치: ${item.cwd}` : null,
      typeof item.exitCode === "number" ? `종료 코드: ${item.exitCode}` : null,
      typeof item.durationMs === "number" ? `소요: ${item.durationMs}ms` : null,
      structuredDetail(item.aggregatedOutput) ? `출력: ${structuredDetail(item.aggregatedOutput)}` : null,
      ...extractTextValues(item.text).map((text) => `명령: ${text}`),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? compactDetail([...new Set(parts)].join(" · ")) : undefined;
  }

  if (type === "fileChange") {
    return fileChangeDetail(item.changes) ?? undefined;
  }

  if (type === "mcpToolCall") {
    const toolName = [item.server, item.tool].filter((value): value is string => typeof value === "string").join("/");
    const errorMessage =
      typeof item.error === "object" && item.error !== null && typeof (item.error as { message?: unknown }).message === "string"
        ? (item.error as { message: string }).message
        : null;
    return [
      toolName ? `도구: ${toolName}` : null,
      structuredDetail(item.arguments) ? `입력: ${structuredDetail(item.arguments)}` : null,
      errorMessage ? `오류: ${errorMessage}` : null,
      structuredDetail(item.result) ? `결과: ${structuredDetail(item.result)}` : null,
    ].filter((part): part is string => Boolean(part)).join(" · ") || undefined;
  }

  if (type === "dynamicToolCall") {
    const toolName = [item.namespace, item.tool].filter((value): value is string => typeof value === "string").join("/");
    return [
      toolName ? `도구: ${toolName}` : null,
      structuredDetail(item.arguments) ? `입력: ${structuredDetail(item.arguments)}` : null,
      structuredDetail(item.contentItems) ? `결과: ${structuredDetail(item.contentItems)}` : null,
      typeof item.success === "boolean" ? `성공: ${item.success}` : null,
    ].filter((part): part is string => Boolean(part)).join(" · ") || undefined;
  }

  if (type === "webSearch") {
    return typeof item.query === "string" && item.query.trim().length > 0
      ? compactDetail(`검색어: ${item.query}`)
      : undefined;
  }

  if (type === "plan") {
    const planText = extractTextValues(item.text).join(" ");
    return planText.trim().length > 0 ? compactDetail(planText) : undefined;
  }

  const text = [
    ...extractTextValues(item.text),
    ...extractTextValues(item.summary),
    ...extractTextValues(item.content),
    ...extractTextValues(item.output),
    ...extractTextValues(item.result),
  ]
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join(" · ");

  return text.trim().length > 0 ? compactDetail(text) : undefined;
}

function itemProgressEvent(
  params: ItemNotificationParams,
  phase: "started" | "completed",
): CodexRunnerProgressEvent | null {
  const item = params.item;
  const type = typeof item?.type === "string" ? item.type : "";
  const normalizedType = type.toLowerCase().replace(/[_-]/g, ".");
  const detail = itemProgressDetail(item);

  if (type === "agentMessage") {
    return phase === "started"
      ? {
          type: "operation-progress",
          label: "답변 작성 중",
          detail,
          eventType: "item/started",
        }
      : null;
  }

  if (type === "commandExecution") {
    return {
      type: "operation-progress",
      label: phase === "completed" ? "명령 실행 완료" : "명령 실행 중",
      detail,
      eventType: phase === "completed" ? "item/completed" : "item/started",
    };
  }

  if (type === "fileChange") {
    return {
      type: "operation-progress",
      label: phase === "completed" ? "파일 수정 완료" : "파일 수정 중",
      detail,
      eventType: phase === "completed" ? "item/completed" : "item/started",
    };
  }

  if (
    normalizedType.includes("reasoning") ||
    normalizedType.includes("thinking") ||
    normalizedType.includes("thought")
  ) {
    return {
      type: "operation-progress",
      label: phase === "completed" ? "생각 정리" : "생각 중",
      detail,
      eventType: phase === "completed" ? "item/completed" : "item/started",
    };
  }

  if (!type && !detail) {
    return null;
  }

  return {
    type: "operation-progress",
    label: phase === "completed" ? "작업 단계 완료" : "작업 단계 실행 중",
    detail: detail ?? type,
    eventType: phase === "completed" ? "item/completed" : "item/started",
  };
}

function spawnFailure(codexCommand: string, error: NodeJS.ErrnoException): RunCodexPromptResult {
  if (error.code === "ENOENT") {
    return {
      status: "failed",
      finalMessage: "",
      sessionId: null,
      stderr: "Codex CLI command was not found. Install Codex CLI or configure codexCommand.",
      exitCode: null,
      errorCode: "CODEX_CLI_NOT_FOUND",
    };
  }

  return {
    status: "failed",
    finalMessage: "",
    sessionId: null,
    stderr: error.message,
    exitCode: null,
    errorCode: error.code ? `CODEX_APP_SERVER_SPAWN_${error.code}` : "CODEX_APP_SERVER_SPAWN_FAILED",
  };
}

function resolveCodexCommand(input: { codexCommand?: string | null }): string {
  return input.codexCommand?.trim() || process.env.CODEX_DISCORD_CODEX_COMMAND?.trim() || "codex";
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    try {
      const stats = await stat(socketPath);

      if (stats.isSocket()) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Codex app-server socket: ${socketPath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Codex app-server WebSocket: ws://${host}:${port}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForAppServer(
  readiness: AppServerTransport["readiness"],
  timeoutMs: number,
): Promise<void> {
  if (!readiness) {
    return;
  }

  if (readiness.kind === "unix") {
    await waitForSocket(readiness.socketPath, timeoutMs);
    return;
  }

  await waitForTcp(readiness.host, readiness.port, timeoutMs);
}

async function startAppServer(input: RunCodexAppServerPromptInput, transport: AppServerTransport): Promise<{
  child: ChildProcess | null;
  spawnFailure?: RunCodexPromptResult;
  stderrChunks: Buffer[];
}> {
  if (!transport.managed) {
    return { child: null, stderrChunks: [] };
  }

  const codexCommand = resolveCodexCommand(input);
  const stderrChunks: Buffer[] = [];
  const child = spawn(codexCommand, ["app-server", "--listen", transport.listenUrl], {
    env: {
      ...process.env,
      ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const appendServerLog = (chunk: Buffer) => {
    stderrChunks.push(chunk);
    if (stderrChunks.length > 256) {
      stderrChunks.splice(0, stderrChunks.length - 256);
    }
  };
  child.stdout.on("data", appendServerLog);
  child.stderr.on("data", appendServerLog);

  const spawnError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    child.once("error", (error) => resolve(error as NodeJS.ErrnoException));
    child.once("spawn", () => resolve(null));
  });

  if (spawnError) {
    return {
      child: null,
      stderrChunks,
      spawnFailure: spawnFailure(codexCommand, spawnError),
    };
  }

  return { child, stderrChunks };
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));

    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
    }
  });
}

export async function terminateManagedAppServer(
  child: ChildProcess | null,
  gracefulTimeoutMs = 500,
  forceTimeoutMs = 1_000,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  if (await waitForChildExit(child, gracefulTimeoutMs)) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }

  await waitForChildExit(child, forceTimeoutMs);
}

// ---------------------------------------------------------------------------
// Persistent managed app-server pool
//
// One `codex app-server` process is kept per (codex command, CODEX_HOME) and
// shared by every prompt instead of booting and killing a server per Discord
// message. The server multiplexes threads, so concurrent jobs simply open
// their own WebSocket connections against the same process.
// ---------------------------------------------------------------------------

interface PersistentCodexAppServer {
  key: string;
  child: ChildProcess;
  clientUrl: string;
  tempRoot: string | null;
  stderrChunks: Buffer[];
  exited: boolean;
}

const persistentCodexAppServers = new Map<string, PersistentCodexAppServer>();

function persistentCodexAppServerEnabled(input: RunCodexAppServerPromptInput): boolean {
  if (input.appServerUrl || input.appServerSocketPath) {
    return false;
  }

  const flag = process.env.CODEX_DISCORD_CODEX_APP_SERVER_PERSISTENT?.trim().toLowerCase() ?? "";
  return !["0", "false", "off", "no"].includes(flag);
}

function persistentCodexAppServerKey(input: RunCodexAppServerPromptInput): string {
  return JSON.stringify([resolveCodexCommand(input), input.codexHome?.trim() ?? ""]);
}

async function disposePersistentCodexAppServer(server: PersistentCodexAppServer): Promise<void> {
  if (persistentCodexAppServers.get(server.key) === server) {
    persistentCodexAppServers.delete(server.key);
  }
  await terminateManagedAppServer(server.child);
  if (server.tempRoot) {
    await rm(server.tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function disposeCodexPersistentAppServers(): Promise<void> {
  const servers = [...persistentCodexAppServers.values()];
  persistentCodexAppServers.clear();
  await Promise.allSettled(servers.map((server) => disposePersistentCodexAppServer(server)));
}

export function codexPersistentAppServerCount(): number {
  return persistentCodexAppServers.size;
}

async function acquirePersistentCodexAppServer(input: RunCodexAppServerPromptInput): Promise<
  | { server: PersistentCodexAppServer; reused: boolean }
  | { failure: RunCodexPromptResult }
> {
  const key = persistentCodexAppServerKey(input);
  const existing = persistentCodexAppServers.get(key);

  if (existing && !existing.exited) {
    return { server: existing, reused: true };
  }

  const transport = await prepareAppServerTransport(input);
  const started = await startAppServer(input, transport);

  if (started.spawnFailure || !started.child) {
    if (transport.tempRoot) {
      await rm(transport.tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      failure: started.spawnFailure ?? appServerFailure({
        message: "Codex app-server could not be started.",
        sessionId: input.sessionId ?? null,
        stderr: Buffer.concat(started.stderrChunks).toString("utf8"),
      }),
    };
  }

  const server: PersistentCodexAppServer = {
    key,
    child: started.child,
    clientUrl: transport.clientUrl,
    tempRoot: transport.tempRoot,
    stderrChunks: started.stderrChunks,
    exited: false,
  };

  started.child.once("exit", () => {
    server.exited = true;
    if (persistentCodexAppServers.get(key) === server) {
      persistentCodexAppServers.delete(key);
    }
    if (server.tempRoot) {
      void rm(server.tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  persistentCodexAppServers.set(key, server);

  try {
    await waitForAppServer(
      transport.readiness,
      input.timeoutMs > 0 ? Math.min(input.timeoutMs, 10_000) : 10_000,
    );
  } catch (error) {
    await disposePersistentCodexAppServer(server);
    return {
      failure: appServerFailure({
        message: error instanceof Error ? error.message : "Codex app-server did not become ready.",
        sessionId: input.sessionId ?? null,
        stderr: Buffer.concat(started.stderrChunks).toString("utf8"),
      }),
    };
  }

  return { server, reused: false };
}

// ---------------------------------------------------------------------------
// Automatic context compaction
//
// The app-server streams thread/tokenUsage/updated notifications with the
// model context window. Once a turn finishes above the configured threshold,
// a detached task asks the persistent server to compact the thread natively
// (thread/compact/start) so the next turn starts from a condensed context.
// ---------------------------------------------------------------------------

const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 258_000;
const CODEX_AUTO_COMPACT_COOLDOWN_MS = 5 * 60_000;
const CODEX_AUTO_COMPACT_TIMEOUT_MS = 5 * 60_000;
const codexAutoCompactLastRunByThread = new Map<string, number>();
const codexAutoCompactInFlightThreads = new Set<string>();
let codexIdleNotificationSink: CodexSessionIdleNotificationSink | null = null;

export interface CodexThreadTokenUsage {
  contextTokens: number;
  windowTokens: number | null;
}

export function codexAutoCompactPercent(): number {
  const parsed = Number.parseInt(process.env.CODEX_DISCORD_CODEX_AUTO_COMPACT_PCT ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 95) : 60;
}

export function setCodexSessionIdleNotificationSink(
  sink: CodexSessionIdleNotificationSink | null,
): void {
  codexIdleNotificationSink = sink;
}

function codexContextWindowTokens(windowTokens: number | null): number {
  if (windowTokens && windowTokens > 0) {
    return windowTokens;
  }

  const override = Number.parseInt(process.env.CODEX_DISCORD_CODEX_CONTEXT_WINDOW ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS;
}

function threadTokenUsageFromNotification(params: Record<string, unknown>): CodexThreadTokenUsage | null {
  const tokenUsage = params.tokenUsage as
    | {
        last?: { inputTokens?: unknown; cachedInputTokens?: unknown };
        modelContextWindow?: unknown;
      }
    | undefined;
  const last = tokenUsage?.last;
  // Codex reports cached input as a subset of inputTokens.
  const contextTokens = typeof last?.inputTokens === "number" ? last.inputTokens : 0;

  if (contextTokens <= 0) {
    return null;
  }

  return {
    contextTokens,
    windowTokens:
      typeof tokenUsage?.modelContextWindow === "number" && tokenUsage.modelContextWindow > 0
        ? tokenUsage.modelContextWindow
        : null,
  };
}

function maybeStartDetachedCodexCompaction(input: {
  serverUrl: string;
  threadId: string | null;
  cwd: string;
  promptInput: RunCodexAppServerPromptInput;
  usage: CodexThreadTokenUsage | null;
}): void {
  const percent = codexAutoCompactPercent();

  if (percent <= 0 || !input.threadId || !input.usage) {
    return;
  }

  const windowTokens = codexContextWindowTokens(input.usage.windowTokens);

  if (input.usage.contextTokens < Math.floor((windowTokens * percent) / 100)) {
    return;
  }

  if (codexAutoCompactInFlightThreads.has(input.threadId)) {
    return;
  }

  const lastRunAt = codexAutoCompactLastRunByThread.get(input.threadId) ?? 0;

  if (Date.now() - lastRunAt < CODEX_AUTO_COMPACT_COOLDOWN_MS) {
    return;
  }

  const threadId = input.threadId;
  const usageSummary = `${Math.round(input.usage.contextTokens / 1_000)}k/${Math.round(windowTokens / 1_000)}k 토큰`;
  codexAutoCompactInFlightThreads.add(threadId);
  codexAutoCompactLastRunByThread.set(threadId, Date.now());

  void runDetachedCodexCompaction({
    serverUrl: input.serverUrl,
    threadId,
    cwd: input.cwd,
    promptInput: input.promptInput,
  })
    .then(() => {
      emitCodexAutoCompactNotification({
        promptInput: input.promptInput,
        threadId,
        message: `🧹 컨텍스트 자동 압축 완료 — 사용량이 ${usageSummary}(${percent}% 초과)에 도달해 대화를 압축했습니다. 대화는 그대로 이어집니다.`,
        isError: false,
      });
    })
    .catch((error) => {
      console.warn(`codex auto-compact failed for thread ${threadId}`, error);
      emitCodexAutoCompactNotification({
        promptInput: input.promptInput,
        threadId,
        message: `⚠️ 컨텍스트 자동 압축 시도(${usageSummary})가 완료되지 않았습니다: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      });
    })
    .finally(() => {
      codexAutoCompactInFlightThreads.delete(threadId);
    });
}

function emitCodexAutoCompactNotification(input: {
  promptInput: RunCodexAppServerPromptInput;
  threadId: string;
  message: string;
  isError: boolean;
}): void {
  const controlKey = input.promptInput.controlKey?.trim();

  if (!controlKey || !codexIdleNotificationSink) {
    return;
  }

  try {
    void Promise.resolve(codexIdleNotificationSink({
      controlKey,
      sessionId: input.threadId,
      message: input.message,
      isError: input.isError,
      at: new Date().toISOString(),
    })).catch((error) => {
      console.warn("codex auto-compact notification failed", error);
    });
  } catch (error) {
    console.warn("codex auto-compact notification failed", error);
  }
}

async function runDetachedCodexCompaction(input: {
  serverUrl: string;
  threadId: string;
  cwd: string;
  promptInput: RunCodexAppServerPromptInput;
}): Promise<void> {
  const socket = new WebSocket(input.serverUrl, { perMessageDeflate: false });
  let nextRequestId = 1;
  const pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  const cleanup = () => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex compaction socket closed."));
    }
    pendingRequests.clear();
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextRequestId++;
    socket.send(JSON.stringify({ method, id, params }));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response: ${method}`));
      }, 60_000);
      pendingRequests.set(id, { resolve, reject, timer });
    });
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const overallTimer = setTimeout(() => {
      finish(new Error("Codex compaction timed out."));
    }, CODEX_AUTO_COMPACT_TIMEOUT_MS);
    overallTimer.unref();

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(overallTimer);
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => finish(new Error("Codex compaction socket closed before completion.")));

    socket.on("message", (raw) => {
      let message: { id?: number; method?: string; error?: { message?: string }; result?: unknown };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }

      if (typeof message.id === "number" && !message.method) {
        const pending = pendingRequests.get(message.id);
        if (pending) {
          pendingRequests.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      if (message.method === "thread/compacted" || message.method === "turn/completed") {
        finish();
      }
    });

    socket.on("open", () => {
      void (async () => {
        try {
          await request("initialize", {
            clientInfo: {
              name: APP_SERVER_CLIENT_NAME,
              title: "AI Agent Discord Connector",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true, requestAttestation: false },
          });
          socket.send(JSON.stringify({ method: "initialized" }));
          await request("thread/resume", {
            threadId: input.threadId,
            cwd: input.cwd,
            runtimeWorkspaceRoots: [input.cwd],
            approvalPolicy: approvalPolicy(),
            approvalsReviewer: APP_SERVER_APPROVALS_REVIEWER,
            sandbox: sandboxMode(),
            model: model(input.promptInput),
          });
          await request("thread/compact/start", { threadId: input.threadId });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  });
}

function isLikelyAppServerConnectionFailure(result: RunCodexPromptResult): boolean {
  if (result.status !== "failed") {
    return false;
  }

  const text = `${result.finalMessage} ${result.stderr}`;
  return /ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|socket hang up|Unexpected server response|closed before the connection/i.test(text);
}

function appServerFailure(input: {
  message: string;
  sessionId: string | null;
  stderr: string;
  timedOut?: boolean;
}): RunCodexPromptResult {
  return {
    status: "failed",
    finalMessage: input.message,
    sessionId: input.sessionId,
    stderr: input.stderr,
    exitCode: null,
    errorCode: APP_SERVER_ERROR_CODE,
    timedOut: input.timedOut,
  };
}

function jsonRpcErrorMessage(error: { code?: unknown; message?: unknown }): string {
  const code = typeof error.code === "number" || typeof error.code === "string" ? `${error.code}: ` : "";
  const message = typeof error.message === "string" ? error.message : "Unknown JSON-RPC error";
  return `${code}${message}`;
}

function reasoningEffort(input: RunCodexAppServerPromptInput): string | null {
  return input.reasoningEffort?.trim() || null;
}

function model(input: RunCodexAppServerPromptInput): string | null {
  return input.model?.trim() || null;
}

function sandboxMode(): CodexSandboxMode {
  const configured = process.env.CODEX_DISCORD_CODEX_SANDBOX?.trim();

  return configured === "read-only" || configured === "workspace-write" || configured === "danger-full-access"
    ? configured
    : "danger-full-access";
}

function turnSandboxPolicy(cwd: string) {
  const mode = sandboxMode();

  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (mode === "read-only") {
    return {
      type: "readOnly",
      networkAccess: true,
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function approvalPolicy(): "untrusted" | "on-request" | "never" {
  const configured = process.env.CODEX_DISCORD_CODEX_APPROVAL_POLICY?.trim();

  return configured === "untrusted" || configured === "never" || configured === "on-request"
    ? configured
    : APP_SERVER_APPROVAL_POLICY;
}

function threadIdFromResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }

  const typed = response as ThreadStartResponse;
  const threadId = typed.thread?.id ?? typed.newThread?.id;

  return typeof threadId === "string" ? threadId : null;
}

function turnIdFromResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }

  const turnId = (response as TurnStartResponse).turn?.id;
  return typeof turnId === "string" ? turnId : null;
}

function objectParam(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(" ");
  }

  return null;
}

function notificationThreadId(
  method: string,
  params: Record<string, unknown>,
): string | null {
  const directThreadId = stringParam(params, "threadId");

  if (directThreadId) {
    return directThreadId;
  }

  if (method === "thread/started") {
    return stringParam(objectParam(params.thread), "id");
  }

  if (method.startsWith("thread/goal/")) {
    return stringParam(objectParam(params.goal), "threadId");
  }

  return null;
}

function jsonDetail(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function optionalDetail(name: string, value: unknown): { name: string; value: string } | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return { name, value: typeof value === "string" ? value : jsonDetail(value) };
}

function approvalRequestFromServerRequest(
  method: string,
  params: Record<string, unknown>,
  sessionId: string | null,
): CodexApprovalRequest | null {
  if (method === "item/commandExecution/requestApproval") {
    return {
      kind: "command",
      title: "명령 실행 권한 요청",
      message: "Codex가 추가 확인이 필요한 명령을 실행하려고 합니다.",
      sessionId,
      cwd: stringParam(params, "cwd"),
      command: stringParam(params, "command"),
      reason: stringParam(params, "reason"),
      details: [
        optionalDetail("Network", params.networkApprovalContext),
        optionalDetail("Proposed exec policy", params.proposedExecpolicyAmendment),
        optionalDetail("Proposed network policy", params.proposedNetworkPolicyAmendments),
      ].filter((detail): detail is { name: string; value: string } => Boolean(detail)),
      rawParams: params,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "file-change",
      title: "파일 변경 권한 요청",
      message: "Codex가 현재 권한으로는 바로 쓸 수 없는 위치의 파일 변경을 요청했습니다.",
      sessionId,
      cwd: stringParam(params, "grantRoot"),
      reason: stringParam(params, "reason"),
      details: [optionalDetail("Grant root", params.grantRoot)].filter(
        (detail): detail is { name: string; value: string } => Boolean(detail),
      ),
      rawParams: params,
    };
  }

  if (method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      title: "추가 권한 요청",
      message: "Codex가 이 작업을 계속하기 위해 추가 권한을 요청했습니다.",
      sessionId,
      cwd: stringParam(params, "cwd"),
      reason: stringParam(params, "reason"),
      details: [optionalDetail("Requested permissions", params.permissions)].filter(
        (detail): detail is { name: string; value: string } => Boolean(detail),
      ),
      rawParams: params,
    };
  }

  if (method === "execCommandApproval") {
    return {
      kind: "legacy-command",
      title: "명령 실행 권한 요청",
      message: "Codex가 추가 확인이 필요한 명령을 실행하려고 합니다.",
      sessionId,
      cwd: stringParam(params, "cwd"),
      command: stringParam(params, "command"),
      reason: stringParam(params, "reason"),
      details: [optionalDetail("Parsed command", params.parsedCmd)].filter(
        (detail): detail is { name: string; value: string } => Boolean(detail),
      ),
      rawParams: params,
    };
  }

  if (method === "applyPatchApproval") {
    return {
      kind: "legacy-patch",
      title: "패치 적용 권한 요청",
      message: "Codex가 파일 패치를 적용하기 전에 확인을 요청했습니다.",
      sessionId,
      cwd: null,
      details: [optionalDetail("File changes", params.fileChanges)].filter(
        (detail): detail is { name: string; value: string } => Boolean(detail),
      ),
      rawParams: params,
    };
  }

  return null;
}

function legacyApprovalDecision(choice: CodexApprovalChoice) {
  switch (choice) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "cancel":
      return "abort";
    case "decline":
    default:
      return "denied";
  }
}

function permissionGrantResponse(params: Record<string, unknown>, decision: CodexApprovalDecision) {
  const requested = objectParam(params.permissions);
  const accepted = decision.decision === "accept" || decision.decision === "acceptForSession";

  if (!accepted) {
    return {
      permissions: {},
      scope: "turn",
    };
  }

  return {
    permissions: {
      ...(requested.network === null || requested.network === undefined ? {} : { network: requested.network }),
      ...(requested.fileSystem === null || requested.fileSystem === undefined ? {} : { fileSystem: requested.fileSystem }),
    },
    scope: decision.decision === "acceptForSession" ? "session" : "turn",
  };
}

function approvalResponseForServerRequest(
  method: string,
  params: Record<string, unknown>,
  decision: CodexApprovalDecision,
) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: legacyApprovalDecision(decision.decision) };
  }

  if (method === "item/permissions/requestApproval") {
    return permissionGrantResponse(params, decision);
  }

  return { decision: decision.decision };
}

function userInputQuestion(value: unknown): CodexUserInputQuestion | null {
  const question = objectParam(value);
  const id = stringParam(question, "id");
  const header = stringParam(question, "header");
  const prompt = stringParam(question, "question");

  if (!id || !header || !prompt) {
    return null;
  }

  const rawOptions = Array.isArray(question.options) ? question.options : null;
  const options = rawOptions
    ?.map((option) => {
      const normalized = objectParam(option);
      const label = stringParam(normalized, "label");
      const description = stringParam(normalized, "description");
      return label && description ? { label, description } : null;
    })
    .filter((option): option is { label: string; description: string } => Boolean(option)) ?? null;

  return {
    id,
    header,
    question: prompt,
    isOther: question.isOther === true,
    isSecret: question.isSecret === true,
    options,
  };
}

function userInputRequestFromServerRequest(
  method: string,
  params: Record<string, unknown>,
): CodexUserInputRequest | null {
  if (method !== "item/tool/requestUserInput") {
    return null;
  }

  const threadId = stringParam(params, "threadId");
  const turnId = stringParam(params, "turnId");
  const itemId = stringParam(params, "itemId");
  const questions = Array.isArray(params.questions)
    ? params.questions.map(userInputQuestion).filter((question): question is CodexUserInputQuestion => Boolean(question))
    : [];

  if (!threadId || !turnId || !itemId || questions.length === 0) {
    return null;
  }

  return {
    threadId,
    turnId,
    itemId,
    questions,
    autoResolutionMs:
      typeof params.autoResolutionMs === "number" && Number.isFinite(params.autoResolutionMs)
        ? Math.max(0, params.autoResolutionMs)
        : null,
  };
}

export async function runCodexAppServerPrompt(
  input: RunCodexAppServerPromptInput,
): Promise<RunCodexPromptResult> {
  if (input.mode === "review") {
    return {
      status: "failed",
      finalMessage: "Codex app-server runner does not support review mode yet.",
      sessionId: null,
      stderr: "",
      exitCode: null,
      errorCode: APP_SERVER_UNSUPPORTED_REVIEW_CODE,
    };
  }

  const workspaceRoot = await ensureAsciiWorkspaceRoot(input.workspaceRoot);
  const originalWorkspaceRoot = path.resolve(input.workspaceRoot);
  const requestedCwd = path.resolve(input.cwd);
  const cwd =
    workspaceRoot === originalWorkspaceRoot
      ? requestedCwd
      : path.join(workspaceRoot, path.relative(originalWorkspaceRoot, requestedCwd));

  if (persistentCodexAppServerEnabled(input)) {
    let allowStaleRetry = true;

    for (;;) {
      const acquired = await acquirePersistentCodexAppServer(input);

      if ("failure" in acquired) {
        return acquired.failure;
      }

      let latestTokenUsage: CodexThreadTokenUsage | null = null;
      const result = await runPromptAgainstAppServer({
        input,
        serverUrl: acquired.server.clientUrl,
        cwd,
        stderrChunks: acquired.server.stderrChunks,
        onThreadTokenUsage: (usage) => {
          latestTokenUsage = usage;
        },
      }).catch((error) => appServerFailure({
        message: error instanceof Error ? error.message : "Codex app-server prompt failed",
        sessionId: input.sessionId ?? null,
        stderr: Buffer.concat(acquired.server.stderrChunks).toString("utf8"),
      }));

      if (acquired.reused && allowStaleRetry && isLikelyAppServerConnectionFailure(result)) {
        // The pooled server died or went unreachable between prompts; replace
        // it once and retry against a fresh process.
        allowStaleRetry = false;
        await disposePersistentCodexAppServer(acquired.server);
        continue;
      }

      maybeStartDetachedCodexCompaction({
        serverUrl: acquired.server.clientUrl,
        threadId: result.sessionId,
        cwd,
        promptInput: input,
        usage: latestTokenUsage,
      });

      return result;
    }
  }

  const transport = await prepareAppServerTransport(input);
  const server = await startAppServer(input, transport);

  if (server.spawnFailure) {
    return server.spawnFailure;
  }

  try {
    if (transport.managed) {
      await waitForAppServer(
        transport.readiness,
        input.timeoutMs > 0 ? Math.min(input.timeoutMs, 10_000) : 10_000,
      );
    }

    return await runPromptAgainstAppServer({
      input,
      serverUrl: transport.clientUrl,
      cwd,
      stderrChunks: server.stderrChunks,
    });
  } catch (error) {
    return appServerFailure({
      message: error instanceof Error ? error.message : "Codex app-server prompt failed",
      sessionId: input.sessionId ?? null,
      stderr: Buffer.concat(server.stderrChunks).toString("utf8"),
    });
  } finally {
    await terminateManagedAppServer(server.child);

    if (transport.tempRoot) {
      await rm(transport.tempRoot, { recursive: true, force: true });
    }
  }
}

async function runPromptAgainstAppServer(input: {
  input: RunCodexAppServerPromptInput;
  serverUrl: string;
  cwd: string;
  stderrChunks: Buffer[];
  onThreadTokenUsage?: (usage: CodexThreadTokenUsage) => void;
}): Promise<RunCodexPromptResult> {
  const socket = new WebSocket(input.serverUrl, { perMessageDeflate: false });
  let nextRequestId = 1;
  let sessionId = input.input.sessionId ?? null;
  let autoCompactAnnounced = false;
  let completed = false;
  let turnFinished = false;
  let activeTurnId: string | null = null;
  let finalMessage = "";
  let goalStatus: CodexGoalStatus | null = null;
  const announcedSessionIds = new Set<string>();
  const agentMessageTextById = new Map<string, string>();
  const agentMessageOrder: string[] = [];
  const reasoningSummaryById = new Map<string, string>();
  const commandOutputById = new Map<string, string>();
  let notificationQueue = Promise.resolve();
  const pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  function stderr(): string {
    return Buffer.concat(input.stderrChunks).toString("utf8");
  }

  async function emitProgress(event: CodexRunnerProgressEvent): Promise<void> {
    try {
      await Promise.resolve(input.input.onProgress?.(event));
    } catch (error) {
      console.error("failed to deliver Codex app-server progress", error);
    }
  }

  function clearActiveTurn(): void {
    const controlKey = input.input.controlKey?.trim();

    if (!controlKey) {
      return;
    }

    const activeTurn = activeTurnsByControlKey.get(controlKey);
    if (activeTurn?.request === request) {
      activeTurnsByControlKey.delete(controlKey);
    }
  }

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId++;
    socket.send(JSON.stringify({ method, id, params }));

    return new Promise((resolve, reject) => {
      const requestTimeoutMs = input.input.timeoutMs > 0 ? Math.min(input.input.timeoutMs, 60_000) : 60_000;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response: ${method}`));
      }, requestTimeoutMs);

      pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  function notification(method: string, params?: unknown): void {
    socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }));
  }

  function handleAgentDelta(params: ItemNotificationParams): void {
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    const delta = typeof params.delta === "string" ? params.delta : "";

    if (!itemId || !delta) {
      return;
    }

    if (!agentMessageTextById.has(itemId)) {
      agentMessageOrder.push(itemId);
      agentMessageTextById.set(itemId, "");
    }

    agentMessageTextById.set(itemId, `${agentMessageTextById.get(itemId) ?? ""}${delta}`);
  }

  function appendItemDelta(target: Map<string, string>, params: Record<string, unknown>, limit = 4_000): void {
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    const delta = typeof params.delta === "string" ? params.delta : "";

    if (!itemId || !delta) {
      return;
    }

    target.set(itemId, `${target.get(itemId) ?? ""}${delta}`.slice(-limit));
  }

  function enrichedItemParams(params: ItemNotificationParams): ItemNotificationParams {
    const item = params.item;
    const itemId = typeof item?.id === "string" ? item.id : null;

    if (!item || !itemId) {
      return params;
    }

    const reasoningSummary = reasoningSummaryById.get(itemId)?.trim();
    const commandOutput = commandOutputById.get(itemId)?.trim();

    return {
      ...params,
      item: {
        ...item,
        ...(reasoningSummary && extractTextValues(item.summary).length === 0
          ? { summary: [reasoningSummary] }
          : {}),
        ...(commandOutput && !structuredDetail(item.aggregatedOutput)
          ? { aggregatedOutput: commandOutput }
          : {}),
      },
    };
  }

  async function emitThreadStarted(threadId: string): Promise<void> {
    sessionId = threadId;

    if (announcedSessionIds.has(threadId)) {
      return;
    }

    announcedSessionIds.add(threadId);
    await emitProgress({ type: "thread-started", sessionId: threadId });
  }

  async function handleItemCompleted(params: ItemNotificationParams): Promise<void> {
    const item = params.item;

    if (item?.type !== "agentMessage" || typeof item.id !== "string") {
      return;
    }

    const text = typeof item.text === "string" ? item.text : agentMessageTextById.get(item.id) ?? "";

    if (!agentMessageTextById.has(item.id)) {
      agentMessageOrder.push(item.id);
    }

    agentMessageTextById.set(item.id, text);

    if (text.trim().length > 0) {
      await emitProgress({ type: "agent-message", text });
    }
  }

  function handleTurnCompleted(params: TurnCompletedParams): void {
    turnFinished = true;
    clearActiveTurn();
    completed = params.turn?.status === "completed";
    finalMessage = agentMessageTextById.get(agentMessageOrder.at(-1) ?? "") ?? "";

    if (!completed && params.turn?.error) {
      const detail = typeof params.turn.error.additionalDetails === "string"
        ? `\n${params.turn.error.additionalDetails}`
        : "";
      finalMessage = `${String(params.turn.error.message ?? "Codex app-server turn failed")}${detail}`;
    }

    socket.close();
  }

  async function handleNotification(message: JsonRpcNotification): Promise<void> {
    const method = typeof message.method === "string" ? message.method : "";
    const params = typeof message.params === "object" && message.params !== null
      ? (message.params as Record<string, unknown>)
      : {};
    const notifiedThreadId = notificationThreadId(method, params);

    // A persistent app-server multiplexes every Discord session. Its
    // notifications can be observed by more than one WebSocket client, so
    // never let another client's thread mutate or complete this prompt.
    // `thread/started` is intentionally redundant: the matching RPC response
    // below is the authoritative source for the opened/resumed thread ID.
    if (method === "thread/started") {
      return;
    }

    if (!sessionId || !notifiedThreadId || notifiedThreadId !== sessionId) {
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = threadTokenUsageFromNotification(params);

      if (usage) {
        input.onThreadTokenUsage?.(usage);
        const percent = codexAutoCompactPercent();
        const windowTokens = codexContextWindowTokens(usage.windowTokens);

        if (
          percent > 0 &&
          !autoCompactAnnounced &&
          usage.contextTokens >= Math.floor((windowTokens * percent) / 100)
        ) {
          autoCompactAnnounced = true;
          await emitProgress({
            type: "operation-progress",
            label: "컨텍스트 자동 압축 예정",
            detail: `사용량 ${Math.round(usage.contextTokens / 1_000)}k/${Math.round(windowTokens / 1_000)}k 토큰 (${percent}% 초과) — 이 턴이 끝나면 압축합니다`,
            eventType: method,
          });
        }
      }
      return;
    }

    if (method === "thread/goal/updated") {
      const goal = objectParam(params.goal);
      goalStatus = codexGoalStatus(goal.status);
      return;
    }

    if (method === "thread/goal/cleared") {
      goalStatus = null;
      return;
    }

    if (method === "item/started") {
      const progress = itemProgressEvent(params as ItemNotificationParams, "started");

      if (progress) {
        await emitProgress(progress);
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      handleAgentDelta(params as ItemNotificationParams);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      appendItemDelta(reasoningSummaryById, params);
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      appendItemDelta(commandOutputById, params);
      return;
    }

    if (method === "item/mcpToolCall/progress" && typeof params.message === "string") {
      await emitProgress({
        type: "operation-progress",
        label: "도구 진행 중",
        detail: compactDetail(params.message),
        eventType: method,
      });
      return;
    }

    if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
      const plan = params.plan.flatMap((step, index) => {
        if (typeof step !== "object" || step === null || typeof (step as { step?: unknown }).step !== "string") {
          return [];
        }
        const record = step as { step: string; status?: unknown };
        return [`${index + 1}. ${record.step} (${String(record.status ?? "pending")})`];
      });
      await emitProgress({
        type: "operation-progress",
        label: "계획 업데이트",
        detail: compactDetail(plan.join(" · ")),
        eventType: method,
      });
      return;
    }

    if (method === "item/fileChange/patchUpdated") {
      const detail = fileChangeDetail(params.changes);
      if (detail) {
        await emitProgress({
          type: "operation-progress",
          label: "파일 수정 중",
          detail,
          eventType: method,
        });
      }
      return;
    }

    if (method === "item/completed") {
      const enrichedParams = enrichedItemParams(params as ItemNotificationParams);
      const progress = itemProgressEvent(enrichedParams, "completed");

      if (progress) {
        await emitProgress(progress);
      }
      await handleItemCompleted(enrichedParams);

      const itemId = typeof enrichedParams.item?.id === "string" ? enrichedParams.item.id : null;
      if (itemId) {
        reasoningSummaryById.delete(itemId);
        commandOutputById.delete(itemId);
      }
      return;
    }

    if (method === "turn/completed") {
      handleTurnCompleted(params as TurnCompletedParams);
    }
  }

  async function respondServerRequest(message: JsonRpcNotification): Promise<void> {
    if (typeof message.id !== "number" && typeof message.id !== "string") {
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    const params = objectParam(message.params);
    const requestThreadId = stringParam(params, "threadId");

    if (requestThreadId && requestThreadId !== sessionId) {
      return;
    }

    const approvalRequest = approvalRequestFromServerRequest(method, params, sessionId);

    if (approvalRequest) {
      const decision =
        (await Promise.resolve(input.input.onApprovalRequest?.(approvalRequest))) ?? { decision: "decline" };

      socket.send(
        JSON.stringify({
          id: message.id,
          result: approvalResponseForServerRequest(method, params, decision),
        }),
      );
      return;
    }

    const userInputRequest = userInputRequestFromServerRequest(method, params);

    if (userInputRequest) {
      const response: CodexUserInputResponse =
        (await Promise.resolve(input.input.onUserInputRequest?.(userInputRequest))) ?? { answers: {} };
      socket.send(JSON.stringify({ id: message.id, result: response }));
      return;
    }

    socket.send(
      JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: "AI Agent Discord Connector app-server runner does not support this server request yet.",
        },
      }),
    );
  }

  const result = await new Promise<RunCodexPromptResult>((resolve) => {
    const timeout =
      input.input.timeoutMs > 0
        ? setTimeout(() => {
            resolve(
              appServerFailure({
                message: "Codex app-server prompt timed out.",
                sessionId,
                stderr: stderr(),
                timedOut: true,
              }),
            );
            socket.close();
          }, input.input.timeoutMs)
        : null;

    socket.on("open", () => {
      void (async () => {
        try {
          await request("initialize", {
            clientInfo: {
              name: APP_SERVER_CLIENT_NAME,
              title: "AI Agent Discord Connector",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true, requestAttestation: false },
          });
          notification("initialized");

          const currentApprovalPolicy = approvalPolicy();
          const currentSandboxMode = sandboxMode();
          const threadResult =
            input.input.sessionId && input.input.forkSession
              ? await request("thread/fork", {
                  threadId: input.input.sessionId,
                  cwd: input.cwd,
                  runtimeWorkspaceRoots: [input.cwd],
                  approvalPolicy: currentApprovalPolicy,
                  approvalsReviewer: APP_SERVER_APPROVALS_REVIEWER,
                  sandbox: currentSandboxMode,
                  model: model(input.input),
                })
              : input.input.sessionId
                ? await request("thread/resume", {
                    threadId: input.input.sessionId,
                    cwd: input.cwd,
                    runtimeWorkspaceRoots: [input.cwd],
                    approvalPolicy: currentApprovalPolicy,
                    approvalsReviewer: APP_SERVER_APPROVALS_REVIEWER,
                    sandbox: currentSandboxMode,
                    model: model(input.input),
                  })
                : await request("thread/start", {
                    cwd: input.cwd,
                    runtimeWorkspaceRoots: [input.cwd],
                    approvalPolicy: currentApprovalPolicy,
                    approvalsReviewer: APP_SERVER_APPROVALS_REVIEWER,
                    sandbox: currentSandboxMode,
                    threadSource: "codex-discord",
                    model: model(input.input),
                  });
          const openedThreadId = threadIdFromResponse(threadResult);

          if (openedThreadId) {
            await emitThreadStarted(openedThreadId);

            const requestedSessionName = input.input.sessionName?.trim();
            if (input.input.forkSession && requestedSessionName) {
              await request("thread/name/set", {
                threadId: openedThreadId,
                name: requestedSessionName,
              });
            }
          } else if (input.input.sessionId && input.input.forkSession) {
            throw new Error("Codex app-server thread/fork did not return a forked thread ID.");
          }

          const turnResult = await request("turn/start", {
            threadId: sessionId,
            input: [{ type: "text", text: input.input.prompt, text_elements: [] }],
            cwd: input.cwd,
            runtimeWorkspaceRoots: [input.cwd],
            approvalPolicy: currentApprovalPolicy,
            approvalsReviewer: APP_SERVER_APPROVALS_REVIEWER,
            sandboxPolicy: turnSandboxPolicy(input.cwd),
            model: model(input.input),
            effort: reasoningEffort(input.input),
          });
          activeTurnId = turnIdFromResponse(turnResult);

          const controlKey = input.input.controlKey?.trim();
          if (controlKey && sessionId && activeTurnId && !turnFinished) {
            activeTurnsByControlKey.set(controlKey, {
              threadId: sessionId,
              turnId: activeTurnId,
              request,
            });
          }
        } catch (error) {
          if (timeout) {
            clearTimeout(timeout);
          }
          socket.close();
          resolve(
            appServerFailure({
              message: error instanceof Error ? error.message : "Codex app-server prompt failed",
              sessionId,
              stderr: stderr(),
            }),
          );
        }
      })();
    });

    socket.on("message", (raw) => {
      let message: JsonRpcResponse & JsonRpcNotification;

      try {
        message = JSON.parse(raw.toString()) as JsonRpcResponse & JsonRpcNotification;
      } catch {
        return;
      }

      if (typeof message.id === "number" && pendingRequests.has(message.id)) {
        const pending = pendingRequests.get(message.id);

        if (!pending) {
          return;
        }

        pendingRequests.delete(message.id);
        clearTimeout(pending.timer);

        if (message.error) {
          pending.reject(new Error(jsonRpcErrorMessage(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (typeof message.id !== "undefined") {
        void respondServerRequest(message).catch((error) => {
          console.error("failed to handle Codex app-server request", error);
        });
        return;
      }

      notificationQueue = notificationQueue
        .then(() => handleNotification(message))
        .catch((error) => {
          console.error("failed to handle Codex app-server notification", error);
        });
    });

    socket.on("error", (error) => {
      clearActiveTurn();
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(
        appServerFailure({
          message: error.message,
          sessionId,
          stderr: stderr(),
        }),
      );
    });

    socket.on("close", () => {
      void notificationQueue.finally(() => {
        clearActiveTurn();
        if (timeout) {
          clearTimeout(timeout);
        }

        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
        }
        pendingRequests.clear();

        resolve({
          status: completed && finalMessage.trim().length > 0 ? "completed" : "failed",
          finalMessage: finalMessage.trimEnd(),
          sessionId,
          stderr: stderr(),
          exitCode: completed ? 0 : null,
          ...(goalStatus ? { goalStatus } : {}),
        });
      });
    });
  });

  return result;
}
