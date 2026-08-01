import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCommandInvocation } from "./windowsCommand.js";

export interface RunCodexPromptInput {
  workspaceRoot: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  sessionId?: string | null;
  forkSession?: boolean;
  sessionName?: string | null;
  codexHome?: string;
  codexCommand?: string;
  onProgress?: (event: CodexRunnerProgressEvent) => Promise<void> | void;
  mode?: "prompt" | "review";
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null;
  controlKey?: string;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision> | CodexApprovalDecision;
  onUserInputRequest?: (request: CodexUserInputRequest) => Promise<CodexUserInputResponse> | CodexUserInputResponse;
}

export type CodexApprovalKind = "command" | "file-change" | "permissions" | "legacy-command" | "legacy-patch";
export type CodexApprovalChoice = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CodexApprovalRequest {
  kind: CodexApprovalKind;
  title: string;
  message: string;
  sessionId: string | null;
  cwd?: string | null;
  command?: string | null;
  reason?: string | null;
  details?: Array<{ name: string; value: string }>;
  rawParams?: unknown;
}

export interface CodexApprovalDecision {
  decision: CodexApprovalChoice;
}

export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[] | null;
}

export interface CodexUserInputRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
  autoResolutionMs: number | null;
}

export interface CodexUserInputAnswer {
  answers: string[];
}

export interface CodexUserInputResponse {
  answers: Record<string, CodexUserInputAnswer>;
}

export type CodexRunnerProgressEvent =
  | { type: "thread-started"; sessionId: string }
  | { type: "agent-message"; text: string }
  | { type: "operation-progress"; label: string; detail?: string; eventType: string }
  | { type: "codex-event"; eventType: string };

export type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface RunCodexPromptResult {
  status: "completed" | "failed";
  finalMessage: string;
  sessionId: string | null;
  stderr: string;
  exitCode: number | null;
  goalStatus?: CodexGoalStatus;
  errorCode?: string;
  signal?: string | null;
  timedOut?: boolean;
}

const DYNAMIC_TOOLS_UNSUPPORTED_ERROR_CODE = "CODEX_EXEC_DYNAMIC_TOOLS_UNSUPPORTED";
const DYNAMIC_TOOLS_UNSUPPORTED_PATTERN = /dynamic tool calls are not supported in exec mode/i;
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

interface RawCodexProgressItem {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  name?: unknown;
  arguments?: unknown;
  command?: unknown;
  content?: unknown;
  file_count?: unknown;
  files?: unknown;
  message?: unknown;
  output?: unknown;
  result?: unknown;
  summary?: unknown;
}

interface RawCodexProgressPayload {
  type?: unknown;
  role?: unknown;
  phase?: unknown;
  content?: unknown;
  message?: unknown;
  last_agent_message?: unknown;
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

function parseThreadId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };

      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // Codex may emit non-JSON warnings next to JSON events; ignore those lines.
    }
  }

  return null;
}

function parseCodexProgressLine(line: string): CodexRunnerProgressEvent | null {
  if (!line.startsWith("{")) {
    return null;
  }

  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      thread_id?: unknown;
      item?: RawCodexProgressItem;
      payload?: RawCodexProgressPayload;
    };

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return { type: "thread-started", sessionId: event.thread_id };
    }

    const payloadAgentMessage = parsePayloadAgentMessage(event);
    if (payloadAgentMessage) {
      return payloadAgentMessage;
    }

    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      return { type: "agent-message", text: event.item.text };
    }

    if (typeof event.type === "string") {
      const operationProgress = parseOperationProgress({
        type: event.type,
        item: event.item,
      });

      if (operationProgress) {
        return operationProgress;
      }

      return { type: "codex-event", eventType: event.type };
    }
  } catch {
    return null;
  }

  return null;
}

function parsePayloadAgentMessage(event: {
  type?: unknown;
  payload?: RawCodexProgressPayload;
}): CodexRunnerProgressEvent | null {
  const payload = event.payload;

  if (!payload) {
    return null;
  }

  if (
    event.type === "event_msg" &&
    payload.type === "agent_message" &&
    typeof payload.message === "string" &&
    payload.message.trim().length > 0
  ) {
    return { type: "agent-message", text: payload.message.trim() };
  }

  if (
    event.type === "event_msg" &&
    payload.type === "task_complete" &&
    typeof payload.last_agent_message === "string" &&
    payload.last_agent_message.trim().length > 0
  ) {
    return { type: "agent-message", text: payload.last_agent_message.trim() };
  }

  if (event.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
    const text = extractProgressContentText(payload.content);

    if (text.length > 0) {
      return { type: "agent-message", text };
    }
  }

  return null;
}

function extractProgressContentText(content: unknown): string {
  return extractTextValues(content).join("\n");
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

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function compactDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function itemName(item: RawCodexProgressItem): string {
  const name = typeof item.name === "string" ? item.name : "";
  const type = typeof item.type === "string" ? item.type : "";
  return name || type || "tool";
}

function itemCommand(item: RawCodexProgressItem): string | null {
  if (typeof item.command === "string" && item.command.trim().length > 0) {
    return compactDetail(item.command);
  }

  const parsedArguments = parseJsonObject(item.arguments);
  const command = parsedArguments?.cmd ?? parsedArguments?.command ?? parsedArguments?.query ?? parsedArguments?.prompt;

  return typeof command === "string" && command.trim().length > 0 ? compactDetail(command) : null;
}

function itemTextDetail(item: RawCodexProgressItem): string | null {
  const text = [
    ...extractTextValues(item.text),
    ...extractTextValues(item.summary),
    ...extractTextValues(item.content),
    ...extractTextValues(item.output),
    ...extractTextValues(item.result),
    ...extractTextValues(item.message),
  ]
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join(" · ");

  return text.trim().length > 0 ? compactDetail(text) : null;
}

function itemArgumentDetail(item: RawCodexProgressItem): string | null {
  const text = itemArgumentText(item);
  return text.trim().length > 0 ? compactDetail(text) : null;
}

function fileCountDetail(item: RawCodexProgressItem): string | null {
  if (typeof item.file_count === "number" && Number.isFinite(item.file_count)) {
    return `${item.file_count}개 파일`;
  }

  if (Array.isArray(item.files)) {
    return `${item.files.length}개 파일`;
  }

  return null;
}

function itemArgumentText(item: RawCodexProgressItem): string {
  const parts: string[] = [];

  if (typeof item.command === "string") {
    parts.push(item.command);
  }

  if (typeof item.arguments === "string") {
    const parsedArguments = parseJsonObject(item.arguments);
    let addedParsedArgument = false;

    for (const value of Object.values(parsedArguments ?? {})) {
      if (typeof value === "string") {
        parts.push(value);
        addedParsedArgument = true;
      }
    }

    if (!addedParsedArgument) {
      parts.push(item.arguments);
    }
  }

  return parts.join("\n");
}

function fileEditDetail(item: RawCodexProgressItem): string | null {
  const text = itemArgumentText(item);
  const fileMatches = [...text.matchAll(/\*\*\* (?:Add|Update|Delete) File:\s+(.+)/g)];
  const fileName = path.basename(fileMatches[0]?.[1]?.trim() ?? "");

  if (!fileName) {
    return null;
  }

  const additions = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++") && !line.startsWith("***")).length;
  const deletions = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

  return `편집함 ${fileName} +${additions} -${deletions}`;
}

function operationDetail(parts: Array<string | null>): string | undefined {
  const detail = parts.filter((part): part is string => Boolean(part && part.trim().length > 0)).join(" · ");
  return detail.length > 0 ? detail : undefined;
}

function parseOperationProgress(event: {
  type: string;
  item?: RawCodexProgressItem;
}): CodexRunnerProgressEvent | null {
  const normalizedType = event.type.replace(/_/g, ".");
  const item = event.item;

  if (normalizedType.includes("context.compaction") || normalizedType.includes("compact")) {
    return {
      type: "operation-progress",
      label: "컨텍스트 압축 중",
      detail: event.type,
      eventType: event.type,
    };
  }

  if (!item) {
    return null;
  }

  const name = itemName(item);
  const command = itemCommand(item);
  const searchable = `${name} ${command ?? ""}`.toLowerCase();
  const fileCount = fileCountDetail(item);

  if (normalizedType.startsWith("item.completed")) {
    if (
      searchable.includes("rg --files") ||
      searchable.includes("find ") ||
      searchable.includes("glob") ||
      searchable.includes("file_search")
    ) {
      return {
        type: "operation-progress",
        label: "탐색마침",
        detail: operationDetail([fileCount, command, name === "exec_command" ? null : name]),
        eventType: event.type,
      };
    }

    if (searchable.includes("apply_patch") || searchable.includes("write") || searchable.includes("edit")) {
      return {
        type: "operation-progress",
        label: "파일 수정 완료",
        detail: fileEditDetail(item) ?? operationDetail([command, name]),
        eventType: event.type,
      };
    }

    if (name === "exec_command" || searchable.includes("shell")) {
      return {
        type: "operation-progress",
        label: "명령 실행 완료",
        detail: operationDetail([command, itemTextDetail(item)]),
        eventType: event.type,
      };
    }

    return genericItemProgressEvent(event.type, item, "completed");
  }

  if (!normalizedType.startsWith("item.started")) {
    return null;
  }

  if (
    searchable.includes("image") ||
    searchable.includes("imagegen") ||
    searchable.includes("generate_image") ||
    searchable.includes("dall-e")
  ) {
    return {
      type: "operation-progress",
      label: "이미지 생성 중",
      detail: operationDetail([command, name]),
      eventType: event.type,
    };
  }

  if (
    searchable.includes("rg --files") ||
    searchable.includes("find ") ||
    searchable.includes("glob") ||
    searchable.includes("file_search")
  ) {
    return {
      type: "operation-progress",
      label: "파일 탐색 중",
      detail: operationDetail([fileCount, command, name === "exec_command" ? null : name]),
      eventType: event.type,
    };
  }

  if (searchable.includes("web_search") || searchable.includes("search_query")) {
    return {
      type: "operation-progress",
      label: "웹 검색 중",
      detail: operationDetail([command, name]),
      eventType: event.type,
    };
  }

  if (searchable.includes("apply_patch") || searchable.includes("write") || searchable.includes("edit")) {
    return {
      type: "operation-progress",
      label: "파일 수정 중",
      detail: fileEditDetail(item) ?? operationDetail([command, name]),
      eventType: event.type,
    };
  }

  if (name === "exec_command" || searchable.includes("shell")) {
    return {
      type: "operation-progress",
      label: "명령 실행 중",
      detail: operationDetail([command, name]),
      eventType: event.type,
    };
  }

  return genericItemProgressEvent(event.type, item, "started");
}

function genericItemProgressEvent(
  eventType: string,
  item: RawCodexProgressItem,
  phase: "started" | "completed",
): CodexRunnerProgressEvent {
  const name = itemName(item);
  const itemType = typeof item.type === "string" ? item.type : "";
  const normalizedName = `${name} ${itemType}`.toLowerCase().replace(/[_-]/g, ".");
  const command = itemCommand(item);
  const text = itemTextDetail(item);
  const argument = command ? null : itemArgumentDetail(item);
  const itemLabel = name === "tool" || name === "function_call" ? null : name;
  const detail = operationDetail([command, text, argument, itemLabel]);

  if (
    normalizedName.includes("reasoning") ||
    normalizedName.includes("thinking") ||
    normalizedName.includes("thought")
  ) {
    return {
      type: "operation-progress",
      label: phase === "completed" ? "생각 정리" : "생각 중",
      detail: operationDetail([text]),
      eventType,
    };
  }

  if (normalizedName.includes("function.call.output") || normalizedName.includes("tool.result")) {
    return {
      type: "operation-progress",
      label: "도구 결과 확인",
      detail,
      eventType,
    };
  }

  if (normalizedName.includes("function.call") || normalizedName.includes("tool")) {
    return {
      type: "operation-progress",
      label: phase === "completed" ? "도구 실행 완료" : "도구 실행 중",
      detail,
      eventType,
    };
  }

  if (normalizedName.includes("message") || normalizedName.includes("answer")) {
    return {
      type: "operation-progress",
      label: phase === "completed" ? "답변 작성 완료" : "답변 작성 중",
      detail,
      eventType,
    };
  }

  return {
    type: "operation-progress",
    label: phase === "completed" ? "작업 단계 완료" : "작업 단계 실행 중",
    detail,
    eventType,
  };
}

function modelArgs(input: RunCodexPromptInput): string[] {
  const model = input.model?.trim();
  return model ? ["-m", model] : [];
}

function reasoningEffortArgs(input: RunCodexPromptInput): string[] {
  const effort = input.reasoningEffort?.trim();
  return effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
}

function codexSandboxMode(): CodexSandboxMode {
  const configured = process.env.CODEX_DISCORD_CODEX_SANDBOX?.trim();

  return configured === "read-only" || configured === "workspace-write" || configured === "danger-full-access"
    ? configured
    : "danger-full-access";
}

function codexApprovalPolicy(): CodexApprovalPolicy {
  const configured = process.env.CODEX_DISCORD_CODEX_APPROVAL_POLICY?.trim();

  return configured === "untrusted" || configured === "never" || configured === "on-request"
    ? configured
    : "never";
}

function codexExecPermissionArgs(): string[] {
  if (process.env.CODEX_DISCORD_CODEX_BYPASS_APPROVALS_AND_SANDBOX === "1") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  return ["--sandbox", codexSandboxMode(), "-c", `approval_policy="${codexApprovalPolicy()}"`];
}

function createCodexArgs(input: RunCodexPromptInput, outputPath: string, cwd: string): string[] {
  if (input.mode === "review") {
    return [
      "exec",
      ...codexExecPermissionArgs(),
      "review",
      "--json",
      ...modelArgs(input),
      ...reasoningEffortArgs(input),
      "--output-last-message",
      outputPath,
      input.prompt,
    ];
  }

  if (input.sessionId) {
    return [
      "exec",
      ...codexExecPermissionArgs(),
      "resume",
      "--json",
      ...modelArgs(input),
      ...reasoningEffortArgs(input),
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      input.sessionId,
      input.prompt,
    ];
  }

  return [
    "exec",
    "--json",
    ...codexExecPermissionArgs(),
    ...modelArgs(input),
    ...reasoningEffortArgs(input),
    "--skip-git-repo-check",
    "--cd",
    cwd,
    "--output-last-message",
    outputPath,
    input.prompt,
  ];
}

function defaultCodexHome(): string {
  return path.join(os.homedir(), ".codex");
}

function resolveCodexCommand(input: { codexCommand?: string | null }): string {
  return input.codexCommand?.trim() || process.env.CODEX_DISCORD_CODEX_COMMAND?.trim() || "codex";
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

  if (error.code === "EACCES") {
    return {
      status: "failed",
      finalMessage: "",
      sessionId: null,
      stderr: `Codex CLI command is not executable: ${codexCommand}`,
      exitCode: null,
      errorCode: "CODEX_CLI_NOT_EXECUTABLE",
    };
  }

  return {
    status: "failed",
    finalMessage: "",
    sessionId: null,
    stderr: error.message,
    exitCode: null,
    errorCode: error.code ? `CODEX_CLI_SPAWN_${error.code}` : "CODEX_CLI_SPAWN_FAILED",
  };
}

function codexExecDynamicToolsUnsupportedMessage(sessionId: string): string {
  return [
    "Codex CLI가 이 세션을 exec mode로 이어받지 못했습니다.",
    `세션 ${sessionId}는 Codex Desktop/IDE에서 열린 dynamic tool 세션일 수 있어서, 현재 Discord 봇 방식(codex exec resume)으로는 같은 앱 화면에 이어 쓸 수 없습니다.`,
    "Desktop/IDE에서 직접 이어가거나, Discord에서 새 Codex 요청으로 이어가세요.",
  ].join("\n");
}

function isGeneratedImageFile(fileName: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(fileName);
}

async function generatedImageMarkdown(input: {
  codexHome?: string;
  sessionId: string | null;
}): Promise<string> {
  if (!input.sessionId) {
    return "";
  }

  const imageDir = path.join(input.codexHome ?? defaultCodexHome(), "generated_images", input.sessionId);
  let entries: import("node:fs").Dirent[];

  try {
    entries = await readdir(imageDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }

  const imagePaths = entries
    .filter((entry) => entry.isFile() && isGeneratedImageFile(entry.name))
    .map((entry) => path.join(imageDir, entry.name))
    .sort();

  return imagePaths
    .map((imagePath, index) => `![generated image ${index + 1}](${imagePath})`)
    .join("\n\n");
}

export async function runCodexPrompt(input: RunCodexPromptInput): Promise<RunCodexPromptResult> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-discord-run-"));
  const outputPath = path.join(tempRoot, `${randomBytes(8).toString("hex")}.txt`);
  const workspaceRoot = await ensureAsciiWorkspaceRoot(input.workspaceRoot);
  const originalWorkspaceRoot = path.resolve(input.workspaceRoot);
  const requestedCwd = path.resolve(input.cwd);
  const cwd =
    workspaceRoot === originalWorkspaceRoot
      ? requestedCwd
      : path.join(workspaceRoot, path.relative(originalWorkspaceRoot, requestedCwd));
  const args = createCodexArgs(input, outputPath, cwd);
  const codexCommand = resolveCodexCommand(input);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const progressTasks: Promise<void>[] = [];
  let stdoutLineBuffer = "";

  function queueProgressLine(line: string): void {
    const event = parseCodexProgressLine(line);

    if (!event || !input.onProgress) {
      return;
    }

    progressTasks.push(
      Promise.resolve(input.onProgress(event)).catch((error) => {
        console.error("codex runner progress callback failed", error);
      }),
    );
  }

  try {
    const invocation = buildCommandInvocation(codexCommand, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: {
        ...process.env,
        ...invocation.env,
        ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const result = await new Promise<{
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      spawnError?: NodeJS.ErrnoException;
    }>((resolve) => {
      let timedOut = false;
      const timeout =
        input.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, input.timeoutMs)
          : null;

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        stdoutLineBuffer += chunk.toString("utf8");

        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          queueProgressLine(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.once("error", (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({
          exitCode: null,
          signal: null,
          timedOut,
          spawnError: error as NodeJS.ErrnoException,
        });
      });
      child.once("close", (exitCode, signal) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (stdoutLineBuffer.trim().length > 0) {
          queueProgressLine(stdoutLineBuffer);
          stdoutLineBuffer = "";
        }
        resolve({ exitCode, signal, timedOut });
      });
    });
    await Promise.all(progressTasks);

    if (result.spawnError) {
      return spawnFailure(codexCommand, result.spawnError);
    }

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const sessionId = parseThreadId(stdout) ?? input.sessionId ?? null;
    const outputMessage = await readFile(outputPath, "utf8").catch(() => "");
    const generatedImagesMessage = outputMessage.trim().length > 0
      ? ""
      : await generatedImageMarkdown({
          codexHome: input.codexHome,
          sessionId,
        });
    const finalMessage = outputMessage.trim().length > 0 ? outputMessage : generatedImagesMessage;
    const completed = result.exitCode === 0 && finalMessage.trim().length > 0 && !result.timedOut;
    const dynamicToolsUnsupported =
      !completed &&
      Boolean(input.sessionId) &&
      DYNAMIC_TOOLS_UNSUPPORTED_PATTERN.test(stderr);

    return {
      status: completed ? "completed" : "failed",
      finalMessage: dynamicToolsUnsupported && input.sessionId
        ? codexExecDynamicToolsUnsupportedMessage(input.sessionId)
        : finalMessage.trimEnd(),
      sessionId,
      stderr,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(dynamicToolsUnsupported ? { errorCode: DYNAMIC_TOOLS_UNSUPPORTED_ERROR_CODE } : {}),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
