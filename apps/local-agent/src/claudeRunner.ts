import { spawn } from "node:child_process";

export type ClaudeRunnerProgressEvent =
  | { type: "thread-started"; sessionId: string }
  | { type: "agent-message"; text: string }
  | { type: "agent-thought"; text: string }
  | { type: "operation-progress"; label: string; detail?: string; eventType: string };

export interface RunClaudePromptInput {
  workspaceRoot: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  controlKey?: string | null;
  sessionId?: string | null;
  forkSession?: boolean;
  sessionName?: string | null;
  claudeCommand?: string | null;
  permissionMode?: string | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  settings?: string | null;
  persistentSession?: boolean | null;
  onProgress?: (event: ClaudeRunnerProgressEvent) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface RunClaudePromptResult {
  status: "completed" | "failed";
  finalMessage: string;
  sessionId: string | null;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
}

export interface ClaudeTurnControlResult {
  status: "accepted" | "no-active-turn" | "unsupported" | "failed";
  message: string;
  threadId?: string;
}

export interface ClaudeSessionIdleNotification {
  controlKey: string;
  sessionId: string | null;
  message: string;
  isError: boolean;
  at: string;
}

type ClaudeSessionIdleNotificationSink = (
  notification: ClaudeSessionIdleNotification,
) => Promise<void> | void;

interface ActiveClaudeTurn {
  send(content: string): Promise<ClaudeTurnControlResult>;
  interrupt(): ClaudeTurnControlResult;
}

const STDERR_TAIL_CHARS = 8_192;
const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;
const LONG_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000;
const AUTO_COMPACT_COOLDOWN_MS = 5 * 60_000;
const AUTO_COMPACT_TURN_TIMEOUT_MS = 10 * 60_000;
const activeClaudeTurns = new Map<string, ActiveClaudeTurn>();

export function claudeAutoCompactPercent(): number {
  const parsed = Number.parseInt(process.env.CODEX_DISCORD_CLAUDE_AUTO_COMPACT_PCT ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 95) : 60;
}

export function claudeContextWindowTokens(model: string | null | undefined): number {
  const override = Number.parseInt(process.env.CODEX_DISCORD_CLAUDE_CONTEXT_WINDOW ?? "", 10);

  if (Number.isFinite(override) && override > 0) {
    return override;
  }

  return model?.includes("[1m]")
    ? LONG_CLAUDE_CONTEXT_WINDOW_TOKENS
    : DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS;
}

export async function steerActiveClaudeTurn(
  controlKey: string,
  content: string,
): Promise<ClaudeTurnControlResult> {
  const activeTurn = activeClaudeTurns.get(controlKey);
  if (!activeTurn) {
    return {
      status: "no-active-turn",
      message: "No active Claude Code turn is available for steering.",
    };
  }

  return activeTurn.send(content);
}

export function interruptActiveClaudeTurn(
  controlKey: string,
): ClaudeTurnControlResult {
  const activeTurn = activeClaudeTurns.get(controlKey);
  if (!activeTurn) {
    return {
      status: "no-active-turn",
      message: "No active Claude Code turn is available to interrupt.",
    };
  }

  return activeTurn.interrupt();
}

function resolveClaudeCommand(input: { claudeCommand?: string | null }): string {
  return input.claudeCommand?.trim() || process.env.CODEX_DISCORD_CLAUDE_COMMAND?.trim() || "claude";
}

function resolvePermissionMode(input: { permissionMode?: string | null }): string | null {
  return input.permissionMode?.trim() || process.env.CODEX_DISCORD_CLAUDE_PERMISSION_MODE?.trim() || "bypassPermissions";
}

function resolveClaudeSettings(input: { settings?: string | null }): string | null {
  return input.settings?.trim() || process.env.CODEX_DISCORD_CLAUDE_SETTINGS?.trim() || null;
}

function claudeArgs(input: RunClaudePromptInput): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
  ];
  const permissionMode = resolvePermissionMode(input);
  const settings = resolveClaudeSettings(input);

  if (input.sessionId?.trim()) {
    args.push("--resume", input.sessionId.trim());
  }

  if (input.forkSession && input.sessionId?.trim()) {
    args.push("--fork-session");
  }

  if (input.sessionName?.trim()) {
    args.push("--name", input.sessionName.trim());
  }

  if (input.model?.trim()) {
    args.push("--model", input.model.trim());
  }

  if (input.effort?.trim()) {
    args.push("--effort", input.effort.trim());
  }

  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }

  if (settings) {
    args.push("--settings", settings);
  }

  return args;
}

function claudeUserMessage(content: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: content }],
    },
    parent_tool_use_id: null,
  })}\n`;
}

function spawnFailure(claudeCommand: string, error: NodeJS.ErrnoException): RunClaudePromptResult {
  if (error.code === "ENOENT") {
    return {
      status: "failed",
      finalMessage: "",
      sessionId: null,
      stderr: "Claude Code command was not found. Install Claude Code or set CODEX_DISCORD_CLAUDE_COMMAND.",
      exitCode: null,
      errorCode: "CLAUDE_CLI_NOT_FOUND",
    };
  }

  if (error.code === "EACCES") {
    return {
      status: "failed",
      finalMessage: "",
      sessionId: null,
      stderr: `Claude Code command is not executable: ${claudeCommand}`,
      exitCode: null,
      errorCode: "CLAUDE_CLI_NOT_EXECUTABLE",
    };
  }

  return {
    status: "failed",
    finalMessage: "",
    sessionId: null,
    stderr: error.message,
    exitCode: null,
    errorCode: error.code ? `CLAUDE_CLI_SPAWN_${error.code}` : "CLAUDE_CLI_SPAWN_FAILED",
  };
}

function compactDetail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const compact = value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 480) : undefined;
}

function structuredDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    return compactDetail(value);
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(value, (key, nestedValue) =>
      /token|secret|password|authorization|cookie|api.?key/i.test(key) ? "[redacted]" : nestedValue,
    );
    return serialized && serialized !== "{}" && serialized !== "[]" ? compactDetail(serialized) : undefined;
  } catch {
    return undefined;
  }
}

function textFromClaudeContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function thinkingFromClaudeContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      return record.type === "thinking" && typeof record.thinking === "string" ? record.thinking : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function toolProgressFromClaudeContent(content: unknown): ClaudeRunnerProgressEvent | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const toolUses = content.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "tool_use",
  );

  if (toolUses.length === 0) {
    return null;
  }

  const details = toolUses.map((toolUse) => {
    const name = compactDetail(toolUse.name) ?? "unknown tool";
    const toolInput = structuredDetail(toolUse.input);
    return toolInput ? `${name} · 입력: ${toolInput}` : name;
  });

  return {
    type: "operation-progress",
    label: "Claude 도구 실행 중",
    detail: compactDetail(details.join(" | ")),
    eventType: "tool_use",
  };
}

function toolResultProgressFromClaudeContent(content: unknown): ClaudeRunnerProgressEvent | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const toolResults = content.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "tool_result",
  );

  if (toolResults.length === 0) {
    return null;
  }

  const failed = toolResults.some((result) => result.is_error === true);
  const details = toolResults.flatMap((result) => {
    const resultDetail = structuredDetail(result.content);
    return resultDetail ? [resultDetail] : [];
  });

  return {
    type: "operation-progress",
    label: failed ? "Claude 도구 실행 실패" : "Claude 도구 실행 완료",
    detail: details.length > 0 ? compactDetail(details.join(" | ")) : undefined,
    eventType: "tool_result",
  };
}

function contextTokensFromClaudeUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const total =
    (typeof record.input_tokens === "number" ? record.input_tokens : 0) +
    (typeof record.cache_read_input_tokens === "number" ? record.cache_read_input_tokens : 0) +
    (typeof record.cache_creation_input_tokens === "number" ? record.cache_creation_input_tokens : 0);

  return total > 0 ? total : undefined;
}

function parseClaudeStreamLine(line: string): {
  sessionId?: string;
  finalMessage?: string;
  progressEvents?: ClaudeRunnerProgressEvent[];
  turnEnded?: boolean;
  isResult?: boolean;
  isError?: boolean;
  contextTokens?: number;
} | null {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;

  if (parsed.type === "system" && parsed.subtype === "init" && sessionId) {
    return {
      sessionId,
      progressEvents: [{ type: "thread-started", sessionId }],
    };
  }

  if (parsed.type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content;
    const text = textFromClaudeContent(content);
    const thinking = thinkingFromClaudeContent(content);
    const toolProgress = toolProgressFromClaudeContent(content);
    const stopReason = typeof message?.stop_reason === "string" ? message.stop_reason : null;
    const contextTokens = contextTokensFromClaudeUsage(message?.usage);

    const progressEvents: ClaudeRunnerProgressEvent[] = [
      ...(thinking ? [{ type: "agent-thought" as const, text: thinking }] : []),
      ...(toolProgress ? [toolProgress] : []),
      ...(text ? [{ type: "agent-message" as const, text }] : []),
    ];

    return {
      sessionId,
      ...(progressEvents.length > 0 ? { progressEvents } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(stopReason && stopReason !== "tool_use" && stopReason !== "pause_turn"
        ? { turnEnded: true }
        : {}),
    };
  }

  if (parsed.type === "user") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const toolResult = toolResultProgressFromClaudeContent(message?.content);
    return toolResult ? { sessionId, progressEvents: [toolResult] } : { sessionId };
  }

  if (parsed.type === "result") {
    const finalMessage =
      typeof parsed.result === "string" && parsed.result.trim().length > 0
        ? parsed.result.trim()
        : undefined;
    return {
      sessionId,
      finalMessage,
      isResult: true,
      isError: parsed.is_error === true || parsed.subtype === "error",
    };
  }

  if (parsed.type === "hook") {
    return {
      sessionId,
      progressEvents: [{
        type: "operation-progress",
        label: "Claude hook 실행 중",
        detail: structuredDetail(parsed.hook_event_name) ?? structuredDetail(parsed.hook_event),
        eventType: "hook",
      }],
    };
  }

  return { sessionId };
}

type ParsedClaudeStreamEvent = NonNullable<ReturnType<typeof parseClaudeStreamLine>>;

function claudeSessionMismatchMessage(expectedSessionId: string, receivedSessionId: string): string {
  return `Claude Code emitted session ${receivedSessionId} while this runner is bound to ${expectedSessionId}.`;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Persistent session pool
//
// One idle Claude Code process is kept per controlKey (Discord channel) so
// that in-session state survives between Discord turns: run_in_background
// tasks keep running, CronCreate/ScheduleWakeup jobs actually fire, and the
// turns they trigger while nobody is chatting are forwarded through the idle
// notification sink.
// ---------------------------------------------------------------------------

const persistentSessions = new Map<string, PersistentClaudeSession>();

let idleNotificationSink: ClaudeSessionIdleNotificationSink | null = null;

export function setClaudeSessionIdleNotificationSink(
  sink: ClaudeSessionIdleNotificationSink | null,
): void {
  idleNotificationSink = sink;
}

export function claudePersistentSessionCount(): number {
  return persistentSessions.size;
}

export async function disposeClaudePersistentSessions(reason = "shutdown"): Promise<void> {
  const sessions = [...persistentSessions.values()];
  persistentSessions.clear();
  await Promise.allSettled(sessions.map((session) => session.dispose(reason)));
}

function persistentSessionsEnabled(input: RunClaudePromptInput): boolean {
  if (!input.controlKey?.trim()) {
    return false;
  }

  if (typeof input.persistentSession === "boolean") {
    return input.persistentSession;
  }

  const flag = process.env.CODEX_DISCORD_CLAUDE_PERSISTENT?.trim().toLowerCase() ?? "";
  return !["0", "false", "off", "no"].includes(flag);
}

function persistentSessionSignature(input: RunClaudePromptInput): string {
  return JSON.stringify([
    resolveClaudeCommand(input),
    input.cwd,
    resolvePermissionMode(input) ?? "",
    input.model?.trim() ?? "",
    input.effort ?? "",
    input.sessionName?.trim() ?? "",
    resolveClaudeSettings(input) ?? "",
  ]);
}

async function enforcePersistentSessionLimit(preserveKey: string): Promise<void> {
  const maxSessions = Math.max(1, positiveIntegerEnv("CODEX_DISCORD_CLAUDE_MAX_SESSIONS", 4));

  while (persistentSessions.size > maxSessions) {
    let victim: PersistentClaudeSession | null = null;

    for (const session of persistentSessions.values()) {
      if (session.controlKey === preserveKey || session.isBusy()) {
        continue;
      }
      if (!victim || session.lastUsedAt < victim.lastUsedAt) {
        victim = session;
      }
    }

    if (!victim) {
      break;
    }

    await victim.dispose("evicted");
  }
}

interface PersistentTurnState {
  input: RunClaudePromptInput;
  reusedSession: boolean;
  settled: boolean;
  interrupted: boolean;
  acceptingInput: boolean;
  lastAssistantMessage: string;
  finalMessage: string;
  resultWasError: boolean;
  progressTasks: Promise<void>[];
  timeout: NodeJS.Timeout | null;
  forceKillTimeout: NodeJS.Timeout | null;
  registryEntry: ActiveClaudeTurn | null;
  onAbort: () => void;
  resolve: (result: RunClaudePromptResult) => void;
}

class PersistentClaudeSession {
  readonly controlKey: string;
  readonly signature: string;
  sessionId: string | null;
  lastUsedAt = Date.now();
  disposed = false;
  exited = false;

  private readonly child: ReturnType<typeof spawn>;
  private readonly claudeCommand: string;
  private readonly baseInput: RunClaudePromptInput;
  private readonly model: string | null;
  private spawnFailureResult: RunClaudePromptResult | null = null;
  private lineBuffer = "";
  private stderrTail = "";
  private activeTurn: PersistentTurnState | null = null;
  private turnChain: Promise<void> = Promise.resolve();
  private idleAssistantText = "";
  private idleTtlTimer: NodeJS.Timeout | null = null;
  private disposeKillTimer: NodeJS.Timeout | null = null;
  private exitWaiters: Array<() => void> = [];
  private lastContextTokens: number | null = null;
  private autoCompactRunning = false;
  private lastAutoCompactAt = 0;

  constructor(input: RunClaudePromptInput, controlKey: string, signature: string) {
    this.controlKey = controlKey;
    this.signature = signature;
    this.sessionId = input.forkSession ? null : input.sessionId?.trim() || null;
    this.claudeCommand = resolveClaudeCommand(input);
    this.baseInput = { ...input, onProgress: undefined, signal: undefined };
    this.model = input.model?.trim() || null;
    this.child = spawn(this.claudeCommand, claudeArgs(input), {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("error", (error) => {
      this.spawnFailureResult = spawnFailure(this.claudeCommand, error as NodeJS.ErrnoException);
      this.exited = true;
      this.disposed = true;
      this.removeFromPool();
      this.cancelIdleTtl();
      const turn = this.activeTurn;
      if (turn) {
        this.settleTurn(turn, this.spawnFailureResult);
      }
      this.flushExitWaiters();
    });

    this.child.stdin?.on("error", () => {
      // Write failures surface through the per-write callbacks; this handler
      // only prevents an unhandled EPIPE from crashing the host process.
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.lineBuffer += chunk.toString("utf8");
      const lines = this.lineBuffer.split(/\r?\n/);
      this.lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          this.handleLine(line);
        }
      }
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_CHARS);
    });

    this.child.once("close", (code) => {
      this.exited = true;
      if (this.lineBuffer.trim()) {
        const remainder = this.lineBuffer.trim();
        this.lineBuffer = "";
        this.handleLine(remainder);
      }
      this.removeFromPool();
      this.cancelIdleTtl();
      if (this.disposeKillTimer) {
        clearTimeout(this.disposeKillTimer);
        this.disposeKillTimer = null;
      }

      const turn = this.activeTurn;
      if (turn) {
        if (turn.interrupted) {
          this.settleTurn(turn, this.interruptedResult(turn));
        } else {
          this.settleTurn(turn, {
            status: "failed",
            finalMessage: turn.finalMessage || turn.lastAssistantMessage,
            sessionId: this.sessionId,
            stderr: this.stderrTail.trim(),
            exitCode: code,
            errorCode: turn.reusedSession ? "CLAUDE_SESSION_LOST" : "CLAUDE_CLI_FAILED",
          });
        }
      }

      this.flushExitWaiters();
    });
  }

  isBusy(): boolean {
    return this.activeTurn !== null;
  }

  submitTurn(input: RunClaudePromptInput, reusedSession: boolean): Promise<RunClaudePromptResult> {
    this.lastUsedAt = Date.now();
    this.cancelIdleTtl();
    const run = this.turnChain.then(() => this.executeTurn(input, reusedSession));
    this.turnChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async dispose(reason: string): Promise<void> {
    this.disposed = true;
    this.cancelIdleTtl();
    this.removeFromPool();

    const turn = this.activeTurn;
    if (turn && !turn.settled) {
      turn.interrupted = true;
      this.settleTurn(turn, this.interruptedResult(turn));
    }

    if (this.exited) {
      return;
    }

    try {
      this.child.stdin?.end();
    } catch {
      // The pipe may already be gone; escalation below still applies.
    }

    if (!this.disposeKillTimer) {
      this.disposeKillTimer = setTimeout(() => {
        this.killChild("SIGTERM");
      }, 1_500);
      this.disposeKillTimer.unref();
    }

    void reason;
    await this.waitForExit(8_000);
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.killChild("SIGKILL");
        resolve();
      }, timeoutMs);
      timer.unref();
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private flushExitWaiters(): void {
    for (const waiter of this.exitWaiters.splice(0)) {
      waiter();
    }
  }

  private executeTurn(input: RunClaudePromptInput, reusedSession: boolean): Promise<RunClaudePromptResult> {
    return new Promise((resolve) => {
      if (input.signal?.aborted) {
        resolve({
          status: "failed",
          finalMessage: "",
          sessionId: this.sessionId,
          stderr: "Claude Code prompt was interrupted.",
          exitCode: null,
          errorCode: "CLAUDE_PROMPT_INTERRUPTED",
        });
        return;
      }

      if (this.spawnFailureResult) {
        resolve(this.spawnFailureResult);
        return;
      }

      if (this.disposed || this.exited) {
        resolve({
          status: "failed",
          finalMessage: "",
          sessionId: this.sessionId,
          stderr: "Claude Code session is no longer available.",
          exitCode: null,
          errorCode: reusedSession ? "CLAUDE_SESSION_LOST" : "CLAUDE_CLI_FAILED",
        });
        return;
      }

      const turn: PersistentTurnState = {
        input,
        reusedSession,
        settled: false,
        interrupted: false,
        acceptingInput: true,
        lastAssistantMessage: "",
        finalMessage: "",
        resultWasError: false,
        progressTasks: [],
        timeout: null,
        forceKillTimeout: null,
        registryEntry: null,
        onAbort: () => {},
        resolve,
      };

      this.activeTurn = turn;
      turn.onAbort = () => {
        this.interruptTurn(turn);
      };
      input.signal?.addEventListener("abort", turn.onAbort, { once: true });

      const registryEntry: ActiveClaudeTurn = {
        send: async (content) => {
          try {
            await this.writeTurnInput(content);
            return {
              status: "accepted",
              message: "Claude Code steering was accepted.",
              ...(this.sessionId ? { threadId: this.sessionId } : {}),
            };
          } catch (error) {
            return {
              status: "failed",
              message: error instanceof Error ? error.message : "Claude Code steering failed.",
            };
          }
        },
        interrupt: () => {
          this.interruptTurn(turn);
          return {
            status: "accepted",
            message: "Claude Code interrupt requested.",
            ...(this.sessionId ? { threadId: this.sessionId } : {}),
          };
        },
      };
      turn.registryEntry = registryEntry;
      activeClaudeTurns.set(this.controlKey, registryEntry);

      if (input.timeoutMs > 0) {
        turn.timeout = setTimeout(() => {
          this.disposed = true;
          this.removeFromPool();
          this.killChild("SIGTERM");
          turn.forceKillTimeout = setTimeout(() => {
            this.killChild("SIGKILL");
          }, 5_000);
          turn.forceKillTimeout.unref();
          this.settleTurn(turn, {
            status: "failed",
            finalMessage: "",
            sessionId: this.sessionId,
            stderr: "Claude Code prompt timed out.",
            exitCode: null,
            errorCode: "CLAUDE_PROMPT_TIMEOUT",
          });
        }, input.timeoutMs);
      }

      void this.writeTurnInput(input.prompt).catch((error) => {
        const message = error instanceof Error ? error.message : "Claude Code input failed.";
        this.disposed = true;
        this.removeFromPool();
        this.killChild("SIGTERM");
        this.settleTurn(turn, {
          status: "failed",
          finalMessage: turn.lastAssistantMessage,
          sessionId: this.sessionId,
          stderr: message,
          exitCode: null,
          errorCode: reusedSession ? "CLAUDE_SESSION_LOST" : "CLAUDE_CLI_FAILED",
        });
      });
    });
  }

  private writeTurnInput(content: string): Promise<void> {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return Promise.reject(new Error("Claude Code steering content is empty."));
    }

    const turn = this.activeTurn;
    if (
      !turn ||
      turn.settled ||
      turn.interrupted ||
      !turn.acceptingInput ||
      this.exited ||
      !this.child.stdin ||
      this.child.stdin.destroyed ||
      !this.child.stdin.writable
    ) {
      return Promise.reject(new Error("Claude Code input stream is no longer writable."));
    }

    return new Promise<void>((writeResolve, writeReject) => {
      this.child.stdin?.write(claudeUserMessage(normalizedContent), (error) => {
        if (error) {
          writeReject(error);
          return;
        }
        writeResolve();
      });
    });
  }

  private interruptTurn(turn: PersistentTurnState): void {
    if (turn.settled || turn.interrupted) {
      return;
    }

    turn.interrupted = true;
    this.disposed = true;
    this.removeFromPool();
    this.killChild("SIGTERM");
    turn.forceKillTimeout = setTimeout(() => {
      this.killChild("SIGKILL");
    }, 5_000);
    turn.forceKillTimeout.unref();
  }

  private interruptedResult(turn: PersistentTurnState): RunClaudePromptResult {
    return {
      status: "failed",
      finalMessage: turn.lastAssistantMessage,
      sessionId: this.sessionId,
      stderr: "Claude Code prompt was interrupted.",
      exitCode: null,
      errorCode: "CLAUDE_PROMPT_INTERRUPTED",
    };
  }

  private settleTurn(turn: PersistentTurnState, result: RunClaudePromptResult): void {
    if (turn.settled) {
      return;
    }

    turn.settled = true;
    if (turn.timeout) {
      clearTimeout(turn.timeout);
      turn.timeout = null;
    }
    turn.input.signal?.removeEventListener("abort", turn.onAbort);
    if (turn.registryEntry && activeClaudeTurns.get(this.controlKey) === turn.registryEntry) {
      activeClaudeTurns.delete(this.controlKey);
    }
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    this.lastUsedAt = Date.now();
    if (!this.disposed && !this.exited) {
      this.scheduleIdleTtl();
      this.maybeStartAutoCompact();
    }

    void Promise.allSettled(turn.progressTasks).then(() => turn.resolve(result));
  }

  private maybeStartAutoCompact(): void {
    if (this.autoCompactRunning || this.disposed || this.exited) {
      return;
    }

    const percent = claudeAutoCompactPercent();

    if (percent <= 0 || !this.lastContextTokens) {
      return;
    }

    const windowTokens = claudeContextWindowTokens(this.model);
    const thresholdTokens = Math.floor((windowTokens * percent) / 100);

    if (this.lastContextTokens < thresholdTokens) {
      return;
    }

    if (Date.now() - this.lastAutoCompactAt < AUTO_COMPACT_COOLDOWN_MS) {
      return;
    }

    this.autoCompactRunning = true;
    this.lastAutoCompactAt = Date.now();
    void this.runAutoCompactTurn(this.lastContextTokens, windowTokens, percent);
  }

  private async runAutoCompactTurn(
    beforeTokens: number,
    windowTokens: number,
    percent: number,
  ): Promise<void> {
    try {
      const result = await this.submitTurn(
        {
          ...this.baseInput,
          prompt: "/compact",
          timeoutMs: AUTO_COMPACT_TURN_TIMEOUT_MS,
        },
        true,
      );

      const usageSummary = `${Math.round(beforeTokens / 1_000)}k/${Math.round(windowTokens / 1_000)}k 토큰`;
      const compacted = result.status === "completed" && !/not enough/i.test(result.finalMessage);
      const message = compacted
        ? `🧹 컨텍스트 자동 압축 완료 — 사용량이 ${usageSummary}(${percent}% 초과)에 도달해 대화를 압축했습니다. 대화는 그대로 이어집니다.`
        : `⚠️ 컨텍스트 자동 압축 시도(${usageSummary})가 완료되지 않았습니다: ${
            result.finalMessage || result.stderr || result.errorCode || "알 수 없는 응답"
          }`;

      this.emitAutoCompactNotification(message);
    } catch (error) {
      console.warn("claude auto-compact turn failed", error);
    } finally {
      this.autoCompactRunning = false;
    }
  }

  private emitAutoCompactNotification(message: string): void {
    if (!idleNotificationSink) {
      return;
    }

    const notification: ClaudeSessionIdleNotification = {
      controlKey: this.controlKey,
      sessionId: this.sessionId,
      message,
      isError: false,
      at: new Date().toISOString(),
    };

    try {
      void Promise.resolve(idleNotificationSink(notification)).catch((error) => {
        console.warn("claude auto-compact notification failed", error);
      });
    } catch (error) {
      console.warn("claude auto-compact notification failed", error);
    }
  }

  private handleLine(line: string): void {
    const event = parseClaudeStreamLine(line);

    if (!event) {
      return;
    }

    if (this.disposed) {
      return;
    }

    if (event.sessionId && !this.acceptSessionId(event.sessionId)) {
      return;
    }

    if (event.contextTokens !== undefined) {
      this.lastContextTokens = event.contextTokens;
    }

    const turn = this.activeTurn;
    if (!turn) {
      this.handleIdleEvent(event);
      return;
    }

    if (event.finalMessage) {
      turn.finalMessage = event.finalMessage;
    }

    if (event.turnEnded || event.isResult) {
      // Claude may emit end_turn shortly before its result record. Input
      // written in that gap belongs to the next turn, not the active one. By
      // closing steering here, the bot can safely queue the message as the
      // next durable turn instead of reporting a false steering success.
      turn.acceptingInput = false;
    }

    if (event.isResult) {
      turn.resultWasError = event.isError === true;
    }

    for (const progress of event.progressEvents ?? []) {
      if (progress.type === "agent-message") {
        turn.lastAssistantMessage = progress.text;
      }

      if (turn.input.onProgress) {
        turn.progressTasks.push(Promise.resolve(turn.input.onProgress(progress)));
      }
    }

    if (event.isResult) {
      const failed = turn.resultWasError;
      this.settleTurn(turn, {
        status: failed ? "failed" : "completed",
        finalMessage: turn.finalMessage || turn.lastAssistantMessage,
        sessionId: this.sessionId,
        stderr: failed ? this.stderrTail.trim() : "",
        exitCode: null,
        ...(failed ? { errorCode: "CLAUDE_CLI_FAILED" } : {}),
      });
    }
  }

  private handleIdleEvent(event: ParsedClaudeStreamEvent): void {
    for (const progress of event.progressEvents ?? []) {
      if (progress.type === "agent-message") {
        this.idleAssistantText = progress.text;
      }
    }

    if (!event.isResult) {
      return;
    }

    const message = (event.finalMessage || this.idleAssistantText || "").trim();
    this.idleAssistantText = "";

    if (!message || !idleNotificationSink) {
      return;
    }

    const notification: ClaudeSessionIdleNotification = {
      controlKey: this.controlKey,
      sessionId: this.sessionId,
      message,
      isError: event.isError === true,
      at: new Date().toISOString(),
    };

    try {
      void Promise.resolve(idleNotificationSink(notification)).catch((error) => {
        console.warn("claude idle notification sink failed", error);
      });
    } catch (error) {
      console.warn("claude idle notification sink failed", error);
    }
  }

  private acceptSessionId(candidateSessionId: string): boolean {
    const normalizedCandidate = candidateSessionId.trim();

    if (!normalizedCandidate) {
      return true;
    }

    if (!this.sessionId) {
      this.sessionId = normalizedCandidate;
      return true;
    }

    if (this.sessionId.toLowerCase() === normalizedCandidate.toLowerCase()) {
      return true;
    }

    const message = claudeSessionMismatchMessage(this.sessionId, normalizedCandidate);
    const turn = this.activeTurn;
    this.disposed = true;
    this.removeFromPool();
    this.killChild("SIGTERM");

    if (turn && !turn.settled) {
      turn.forceKillTimeout = setTimeout(() => {
        this.killChild("SIGKILL");
      }, 5_000);
      turn.forceKillTimeout.unref();
      this.settleTurn(turn, {
        status: "failed",
        finalMessage: "",
        sessionId: this.sessionId,
        stderr: message,
        exitCode: null,
        errorCode: "CLAUDE_SESSION_MISMATCH",
      });
    } else {
      console.warn(message);
      void this.dispose("session-mismatch").catch(() => undefined);
    }

    return false;
  }

  private scheduleIdleTtl(): void {
    this.cancelIdleTtl();
    const ttlMs = positiveIntegerEnv("CODEX_DISCORD_CLAUDE_SESSION_TTL_MS", 0);
    if (ttlMs <= 0) {
      return;
    }

    this.idleTtlTimer = setTimeout(() => {
      void this.dispose("idle-ttl");
    }, ttlMs);
    this.idleTtlTimer.unref();
  }

  private cancelIdleTtl(): void {
    if (this.idleTtlTimer) {
      clearTimeout(this.idleTtlTimer);
      this.idleTtlTimer = null;
    }
  }

  private removeFromPool(): void {
    if (persistentSessions.get(this.controlKey) === this) {
      persistentSessions.delete(this.controlKey);
    }
  }

  private killChild(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

async function runViaPersistentSession(input: RunClaudePromptInput): Promise<RunClaudePromptResult> {
  const controlKey = input.controlKey?.trim() ?? "";
  const signature = persistentSessionSignature(input);
  const requestedSessionId = input.sessionId?.trim() || null;
  const existing = persistentSessions.get(controlKey);

  if (existing) {
    const reusable =
      !existing.disposed &&
      !existing.exited &&
      !input.forkSession &&
      requestedSessionId !== null &&
      existing.sessionId === requestedSessionId &&
      existing.signature === signature;

    if (reusable) {
      const result = await existing.submitTurn(input, true);
      if (result.errorCode !== "CLAUDE_SESSION_LOST") {
        return result;
      }
      // The pooled process died between turns (host restart, crash, TTL race).
      // Fall through and resume the same conversation in a fresh process.
    } else {
      await existing.dispose("superseded").catch(() => undefined);
    }
  }

  if (input.signal?.aborted) {
    return {
      status: "failed",
      finalMessage: "",
      sessionId: requestedSessionId,
      stderr: "Claude Code prompt was interrupted.",
      exitCode: null,
      errorCode: "CLAUDE_PROMPT_INTERRUPTED",
    };
  }

  const session = new PersistentClaudeSession(input, controlKey, signature);
  persistentSessions.set(controlKey, session);
  const turn = session.submitTurn(input, false);
  void enforcePersistentSessionLimit(controlKey).catch(() => undefined);
  return turn;
}

async function runClaudePromptOnce(input: RunClaudePromptInput): Promise<RunClaudePromptResult> {
  const claudeCommand = resolveClaudeCommand(input);
  const args = claudeArgs(input);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const progressTasks: Promise<void>[] = [];
  let lineBuffer = "";
  let sessionId: string | null = input.forkSession ? null : input.sessionId ?? null;
  let sessionMismatch: string | null = null;
  let lastAssistantMessage = "";
  let finalMessage = "";
  let resultWasError = false;
  let resultSeen = false;
  let turnEnded = false;

  const interruptedResult = (): RunClaudePromptResult => ({
    status: "failed",
    finalMessage: lastAssistantMessage,
    sessionId,
    stderr: "Claude Code prompt was interrupted.",
    exitCode: null,
    errorCode: "CLAUDE_PROMPT_INTERRUPTED",
  });

  if (input.signal?.aborted) {
    return interruptedResult();
  }

  function handleLine(line: string): void {
    const event = parseClaudeStreamLine(line);

    if (!event) {
      return;
    }

    if (event.sessionId) {
      if (sessionId && sessionId.toLowerCase() !== event.sessionId.toLowerCase()) {
        sessionMismatch ??= claudeSessionMismatchMessage(sessionId, event.sessionId);
        return;
      }
      sessionId = sessionId ?? event.sessionId;
    }

    if (event.finalMessage) {
      finalMessage = event.finalMessage;
    }

    if (event.isResult) {
      resultSeen = true;
      resultWasError = event.isError === true;
    }
    if (event.turnEnded) {
      turnEnded = true;
    }

    for (const progress of event.progressEvents ?? []) {
      if (progress.type === "agent-message") {
        lastAssistantMessage = progress.text;
      }

      if (input.onProgress) {
        progressTasks.push(Promise.resolve(input.onProgress(progress)));
      }
    }
  }

  return new Promise<RunClaudePromptResult>((resolve) => {
    const child = spawn(claudeCommand, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let interrupted = false;
    let stdinEnded = false;
    let stdinFailure = "";
    let timeout: NodeJS.Timeout | null = null;
    let forceKillTimeout: NodeJS.Timeout | null = null;

    const onAbort = () => {
      if (settled || interrupted) {
        return;
      }
      interrupted = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
      forceKillTimeout.unref();
    };

    function writeInput(content: string): Promise<void> {
      const normalizedContent = content.trim();
      if (!normalizedContent) {
        return Promise.reject(new Error("Claude Code steering content is empty."));
      }
      if (settled || interrupted || stdinEnded || child.stdin.destroyed || !child.stdin.writable) {
        return Promise.reject(new Error("Claude Code input stream is no longer writable."));
      }

      return new Promise<void>((writeResolve, writeReject) => {
        child.stdin.write(claudeUserMessage(normalizedContent), (error) => {
          if (error) {
            writeReject(error);
            return;
          }
          writeResolve();
        });
      });
    }

    function endInputAfterTurn(): void {
      if ((!turnEnded && !resultSeen) || stdinEnded || child.stdin.destroyed) {
        return;
      }
      stdinEnded = true;
      child.stdin.end();
    }

    const controlKey = input.controlKey?.trim() || null;
    const activeTurn: ActiveClaudeTurn = {
      async send(content) {
        try {
          await writeInput(content);
          return {
            status: "accepted",
            message: "Claude Code steering was accepted.",
            ...(sessionId ? { threadId: sessionId } : {}),
          };
        } catch (error) {
          return {
            status: "failed",
            message: error instanceof Error ? error.message : "Claude Code steering failed.",
          };
        }
      },
      interrupt() {
        onAbort();
        return {
          status: "accepted",
          message: "Claude Code interrupt requested.",
          ...(sessionId ? { threadId: sessionId } : {}),
        };
      },
    };
    if (controlKey) {
      activeClaudeTurns.set(controlKey, activeTurn);
    }

    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
    }

    function settle(result: RunClaudePromptResult): void {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      input.signal?.removeEventListener("abort", onAbort);
      if (controlKey && activeClaudeTurns.get(controlKey) === activeTurn) {
        activeClaudeTurns.delete(controlKey);
      }

      void Promise.allSettled(progressTasks).then(() => resolve(result));
    }

    child.once("error", (error) => {
      settle(interrupted
        ? interruptedResult()
        : spawnFailure(claudeCommand, error as NodeJS.ErrnoException));
    });

    child.stdin.on("error", (error) => {
      if (!settled && !resultSeen && !interrupted) {
        stdinFailure = error.message;
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim()) {
          handleLine(line);
          if (sessionMismatch) {
            child.kill("SIGTERM");
            break;
          }
          endInputAfterTurn();
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    void writeInput(input.prompt).catch((error) => {
      stdinFailure = error instanceof Error ? error.message : "Claude Code input failed.";
      child.kill("SIGTERM");
    });

    if (input.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        settle({
          status: "failed",
          finalMessage: "",
          sessionId,
          stderr: "Claude Code prompt timed out.",
          exitCode: null,
          errorCode: "CLAUDE_PROMPT_TIMEOUT",
        });
      }, input.timeoutMs);
    }

    child.once("close", (code) => {
      if (lineBuffer.trim()) {
        handleLine(lineBuffer.trim());
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (sessionMismatch) {
        settle({
          status: "failed",
          finalMessage: "",
          sessionId,
          stderr: sessionMismatch,
          exitCode: code,
          errorCode: "CLAUDE_SESSION_MISMATCH",
        });
        return;
      }
      if (interrupted) {
        settle(interruptedResult());
        return;
      }
      const completed = code === 0 && !resultWasError;
      const outputFinalMessage = finalMessage || lastAssistantMessage;

      settle({
        status: completed ? "completed" : "failed",
        finalMessage: outputFinalMessage,
        sessionId,
        stderr: stderr || stdinFailure || (completed ? "" : rawStdout),
        exitCode: code,
        ...(completed ? {} : { errorCode: "CLAUDE_CLI_FAILED" }),
      });
    });
  });
}

export async function runClaudePrompt(input: RunClaudePromptInput): Promise<RunClaudePromptResult> {
  if (persistentSessionsEnabled(input)) {
    return runViaPersistentSession(input);
  }

  return runClaudePromptOnce(input);
}
