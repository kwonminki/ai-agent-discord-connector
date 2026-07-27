import {
  authorizeCommand,
  localizeConnectorText,
  parseDiscordMessageCommand,
  type ChannelMode,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";
import { codexDiscordHowToUsePrompt } from "./codexUsagePrompt.js";
import type { AgentEffort, AgentKind } from "./agentSettings.js";
import type { TranscriptSyncMode } from "./directState.js";
import type { ScheduleCommandRequest } from "./scheduler.js";

export interface RouteDiscordMessageInput {
  channelMode: ChannelMode;
  agentMain?: AgentKind | null;
  content: string;
  userRoleIds: string[];
  allowedRoleIds: string[];
  locale?: ConnectorLocale;
}

export type RoutedDiscordMessage =
  | { type: "execute-command"; command: string; confirmedDangerous: boolean }
  | { type: "codex-chat"; content: string }
  | { type: "codex-continue-session"; sessionId: string; content: string }
  | { type: "claude-chat"; content: string }
  | { type: "fork-session"; name: string }
  | { type: "queue-status" }
  | { type: "queue-prompt"; content: string }
  | { type: "queue-clear" }
  | { type: "codex-steer"; content: string }
  | { type: "codex-interrupt" }
  | {
      type: "admin-new-chat";
      name: string | null;
      cwd: string | null;
      useCategory: boolean;
      initialPrompt: string | null;
    }
  | { type: "admin-sync"; limit: number }
  | { type: "admin-sync-select"; limit: number }
  | { type: "admin-sync-selected"; sessionIds: string[] }
  | { type: "claude-resume-list" }
  | { type: "claude-resume"; sessionId: string }
  | { type: "admin-sync-status" }
  | { type: "admin-sync-mode"; mode: TranscriptSyncMode }
  | { type: "codex-run-mode"; mode: "default" | "fast" | "task" }
  | { type: "agent-model"; model: string | null }
  | { type: "agent-effort"; effort: AgentEffort | "default" }
  | { type: "agent-settings" }
  | { type: "codex-review"; prompt: string }
  | { type: "bot-reload"; mode: "commands" | "restart"; confirmed: boolean; force: boolean }
  | { type: "admin-clear-messages"; mode: "all" | "count"; count?: number; confirmed: boolean }
  | { type: "admin-sync-delete"; mode: "all" | "channels" | "session"; sessionId?: string | null; confirmed: boolean }
  | { type: "archive-session"; sessionId: string | null; confirmed: boolean }
  | { type: "schedule-command"; request: ScheduleCommandRequest }
  | { type: "channel-status" }
  | { type: "maintenance-panel" }
  | { type: "bot-help" }
  | { type: "blocked-command"; reason: string; guidance: string }
  | { type: "denied"; reason: string };

function parseExplicitConfirmation(command: string): { command: string; confirmedDangerous: boolean } {
  const trimmedCommand = command.trim();

  if (!trimmedCommand.startsWith("confirm ")) {
    return { command: trimmedCommand, confirmedDangerous: false };
  }

  return {
    command: trimmedCommand.slice("confirm ".length).trim(),
    confirmedDangerous: true,
  };
}

function parseComponentShellCommand(content: string): { command: string; confirmedDangerous: boolean } | null {
  if (!content.startsWith("__cdc_exec ")) {
    return null;
  }

  return parseExplicitConfirmation(content.slice("__cdc_exec ".length).trim());
}

function parseInternalCodexReview(
  content: string,
  locale: ConnectorLocale = "ko",
): { prompt: string } | null {
  if (!content.startsWith("__cdc_codex_review")) {
    return null;
  }

  const prompt = content.slice("__cdc_codex_review".length).trim();
  return { prompt: prompt || localizeConnectorText("현재 변경사항을 리뷰해줘.", locale) };
}

function parseCodexReviewCommand(
  content: string,
  locale: ConnectorLocale = "ko",
): { prompt: string } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:codex\s+)?review(?:\s+(.+))?$/i);

  if (!match) {
    return null;
  }

  return {
    prompt: match[1]?.trim() || localizeConnectorText("현재 변경사항을 리뷰해줘.", locale),
  };
}

function parseCodexShortcut(
  content: string,
  locale: ConnectorLocale = "ko",
): { content: string } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const compact = normalized.match(/^compact(?:\s+(.+))?$/i);

  if (compact) {
    const prompt = compact[1]?.trim();
    const generatedPrompt = prompt
      ? `지금까지의 작업 맥락을 압축 요약해줘. ${prompt}`
      : "지금까지의 작업 맥락을 압축 요약해줘.";
    return {
      content: localizeConnectorText(generatedPrompt, locale),
    };
  }

  if (/^fix-tests$/i.test(normalized)) {
    return {
      content: localizeConnectorText(
        "테스트를 실행하고 실패 원인을 분석한 뒤 수정해줘. 수정 후 테스트를 다시 실행해줘",
        locale,
      ),
    };
  }

  const summarize = normalized.match(/^summarize(?:\s+(.+))?$/i);

  if (summarize) {
    return {
      content: localizeConnectorText(
        `${summarize[1]?.trim() || "현재 채널"}을 요약하고 다음 액션을 제안해줘`,
        locale,
      ),
    };
  }

  const skill = normalized.match(/^skill\s+(\S+)\s+(.+)$/i);

  if (skill) {
    return {
      content: localizeConnectorText(
        `${skill[1]} skill을 적용해서 다음 요청을 처리해줘: ${skill[2].trim()}`,
        locale,
      ),
    };
  }

  return null;
}

function parseAgentCompactCommand(content: string): { prompt: string | null } | null {
  const prefix = "__cdc_agent_compact";

  if (content === prefix) {
    return { prompt: null };
  }

  if (!content.startsWith(`${prefix} `)) {
    return null;
  }

  const prompt = content.slice(prefix.length + 1).trim();
  return { prompt: prompt || null };
}

function parseChatResume(content: string): { sessionId: string | null } | null {
  const match = content.trim().match(/^chat\s+resume(?:\s+([A-Za-z0-9-]{8,64}))?$/i);

  if (!match) {
    return null;
  }

  return { sessionId: match[1]?.trim() || null };
}

function parseAgentUsageShortcut(
  content: string,
  locale: ConnectorLocale = "ko",
): { content: string } | null {
  const match = content.trim().match(/^\/(?:howtouse|how-to-use|사용법)(?:\s+([\s\S]+))?$/i);

  if (!match) {
    return null;
  }

  const usagePrompt = codexDiscordHowToUsePrompt(locale);
  const extraPrompt = match[1]?.trim();

  return {
    content: extraPrompt
      ? `${usagePrompt}\n\n---\n위 사용법을 참고해서 이어지는 요청을 처리해줘:\n${extraPrompt}`
      : usagePrompt,
  };
}

function codexCommandShortcut(
  commandName: string,
  prompt: string | null,
  locale: ConnectorLocale = "ko",
): RoutedDiscordMessage | null {
  switch (commandName) {
    case "status":
      return { type: "channel-status" };
    case "diff":
      return { type: "execute-command", command: "git diff --stat", confirmedDangerous: false };
    case "model": {
      const model = prompt?.trim();
      return model
        ? { type: "agent-model", model: /^(?:default|reset|inherit)$/i.test(model) ? null : model }
        : null;
    }
    case "fast":
      return { type: "codex-run-mode", mode: "fast" };
    case "task":
      return { type: "codex-run-mode", mode: "task" };
    case "mode": {
      const mode = parseCodexRunModeValue(prompt ?? "");
      return mode ? { type: "codex-run-mode", mode } : null;
    }
    case "review":
      return {
        type: "codex-review",
        prompt: prompt?.trim() || localizeConnectorText("현재 변경사항을 리뷰해줘.", locale),
      };
    case "compact": {
      const compact = prompt?.trim();
      const generatedPrompt = compact
        ? `지금까지의 작업 맥락을 압축 요약해줘. ${compact}`
        : "지금까지의 작업 맥락을 압축 요약해줘.";
      return {
        type: "codex-chat",
        content: localizeConnectorText(generatedPrompt, locale),
      };
    }
    case "mcp":
      return {
        type: "execute-command",
        command: prompt?.trim() ? `codex mcp ${prompt.trim()}` : "codex mcp list",
        confirmedDangerous: false,
      };
    default:
      return null;
  }
}

function parseBridgeShortcut(
  content: string,
  locale: ConnectorLocale = "ko",
): RoutedDiscordMessage | null {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (/^(?:diff|git diff)$/i.test(normalized)) {
    return { type: "execute-command", command: "git diff --stat", confirmedDangerous: false };
  }

  if (/^browse$/i.test(normalized)) {
    return { type: "execute-command", command: "__cdc_ls 0", confirmedDangerous: false };
  }

  const shell = normalized.match(/^shell\s+(.+)$/i);

  if (shell) {
    return { type: "execute-command", ...parseExplicitConfirmation(shell[1].trim()) };
  }

  const codexCommand = normalized.match(/^codex-command\s+([a-z0-9_-]{1,32})(?:\s+(.+))?$/i);

  if (codexCommand) {
    const routed = codexCommandShortcut(
      codexCommand[1].toLowerCase(),
      codexCommand[2] ?? null,
      locale,
    );

    if (!routed) {
      return null;
    }

    return routed;
  }

  return null;
}

function parseCodexModel(content: string): { model: string } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:codex\s+)?model\s+([A-Za-z0-9._:-]{1,80})$/i);

  if (!match) {
    return null;
  }

  return { model: match[1] };
}

function parseAgentModel(content: string): { model: string | null } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^model\s+(\S{1,120})$/i);

  if (!match) {
    return null;
  }

  return { model: /^(?:default|reset|inherit)$/i.test(match[1]) ? null : match[1] };
}

function parseAgentEffort(content: string): { effort: AgentEffort | "default" } | null {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
  const match = normalized.match(/^effort\s+(default|reset|inherit|low|medium|high|xhigh|max)$/);

  if (!match) {
    return null;
  }

  return {
    effort: match[1] === "reset" || match[1] === "inherit"
      ? "default"
      : match[1] as AgentEffort | "default",
  };
}

function parseAgentSettings(content: string): boolean {
  return /^\/?(?:settings|agent-settings)$/i.test(content.trim());
}

function parseCodexRunModeValue(value: string): "default" | "fast" | "task" | null {
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalized === "default" || normalized === "off" || normalized === "reset") {
    return "default";
  }

  if (normalized === "fast") {
    return "fast";
  }

  if (normalized === "task") {
    return "task";
  }

  return null;
}

function parseCodexRunMode(content: string): { mode: "default" | "fast" | "task" } | null {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalized === "fast") {
    return { mode: "fast" };
  }

  if (normalized === "task") {
    return { mode: "task" };
  }

  const match = normalized.match(/^(?:codex\s+)?mode\s+(default|off|reset|fast|task)$/);
  const mode = match ? parseCodexRunModeValue(match[1]) : null;

  return mode ? { mode } : null;
}

function parseEncodedNewChatCommand(content: string): Omit<Extract<RoutedDiscordMessage, { type: "admin-new-chat" }>, "type"> | null {
  if (!content.startsWith("__cdc_new_chat ")) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(content.slice("__cdc_new_chat ".length).trim())) as {
      name?: unknown;
      cwd?: unknown;
      useCategory?: unknown;
      initialPrompt?: unknown;
    };

    return {
      name: typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : null,
      cwd: typeof parsed.cwd === "string" && parsed.cwd.trim().length > 0 ? parsed.cwd.trim() : null,
      useCategory: parsed.useCategory === true,
      initialPrompt:
        typeof parsed.initialPrompt === "string" && parsed.initialPrompt.trim().length > 0
          ? parsed.initialPrompt.trim()
          : null,
    };
  } catch {
    return null;
  }
}

function parseEncodedScheduleCommand(content: string): ScheduleCommandRequest | null {
  if (!content.startsWith("__cdc_schedule ")) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(content.slice("__cdc_schedule ".length).trim())) as {
      action?: unknown;
      mode?: unknown;
      command?: unknown;
      at?: unknown;
      every?: unknown;
      weekdays?: unknown;
      id?: unknown;
    };

    if (parsed.action === "list") {
      return { action: "list" };
    }

    if (parsed.action === "delete" && typeof parsed.id === "string" && parsed.id.trim().length > 0) {
      return { action: "delete", id: parsed.id.trim() };
    }

    if (
      parsed.action === "create" &&
      (parsed.mode === "once" || parsed.mode === "every" || parsed.mode === "daily" || parsed.mode === "weekly") &&
      typeof parsed.command === "string" &&
      parsed.command.trim().length > 0
    ) {
      const request: Extract<ScheduleCommandRequest, { action: "create" }> = {
        action: "create",
        mode: parsed.mode,
        command: parsed.command.trim(),
      };

      if (typeof parsed.at === "string" && parsed.at.trim().length > 0) {
        request.at = parsed.at.trim();
      }

      if (typeof parsed.every === "string" && parsed.every.trim().length > 0) {
        request.every = parsed.every.trim();
      }

      if (typeof parsed.weekdays === "string" && parsed.weekdays.trim().length > 0) {
        request.weekdays = parsed.weekdays.trim();
      }

      return request;
    }
  } catch {
    return null;
  }

  return null;
}

function parseEncodedCodexContinueCommand(content: string): {
  sessionId: string;
  content: string;
} | null {
  if (!content.startsWith("__cdc_codex_continue ")) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(content.slice("__cdc_codex_continue ".length).trim())) as {
      sessionId?: unknown;
      prompt?: unknown;
    };

    if (
      typeof parsed.sessionId !== "string" ||
      !/^[0-9a-f-]{32,36}$/i.test(parsed.sessionId) ||
      typeof parsed.prompt !== "string" ||
      parsed.prompt.trim().length === 0
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId.toLowerCase(),
      content: parsed.prompt.trim(),
    };
  } catch {
    return null;
  }
}

function parseEncodedForkSessionCommand(content: string): { name: string } | null {
  if (!content.startsWith("__cdc_fork_session ")) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(content.slice("__cdc_fork_session ".length).trim())) as {
      name?: unknown;
    };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    return name.length > 0 ? { name } : null;
  } catch {
    return null;
  }
}

function parseForkSessionCommand(content: string): { name: string } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const keyedName = parseKeyedValue(normalized, "name");

  if (/^\/fork(?:\s+session)?$/i.test(normalized)) {
    return null;
  }

  if (keyedName && /^\/(?:fork|fork session)(?:\s+name:[^\n]+)$/i.test(normalized)) {
    return { name: keyedName };
  }

  const match = normalized.match(/^\/fork(?:\s+session)?\s+(.+)$/i);
  const name = match?.[1]?.trim();
  return name ? { name } : null;
}

function parseQueueControlCommand(content: string): RoutedDiscordMessage | null {
  const command = content.trim().replace(/^\/+/, "");
  const normalized = command.replace(/\s+/g, " ");

  const queuedPrompt = command.match(/^queue\s+prompt\s*:\s*([\s\S]+)$/i)?.[1]?.trim();

  if (queuedPrompt) {
    return { type: "queue-prompt", content: queuedPrompt };
  }

  if (/^(?:queue|queue-status)$/i.test(normalized)) {
    return { type: "queue-status" };
  }

  if (/^(?:queue-clear|clear-queue)$/i.test(normalized)) {
    return { type: "queue-clear" };
  }

  if (/^(?:interrupt|stop-current)$/i.test(normalized)) {
    return { type: "codex-interrupt" };
  }

  const steer = normalized.match(/^steer\s+([\s\S]+)$/i);
  const steerContent = steer?.[1]?.trim();
  return steerContent ? { type: "codex-steer", content: steerContent } : null;
}

function codexOpenShellCommand(sessionId: string): string {
  return `open 'codex://threads/${sessionId.toLowerCase()}'`;
}

function codexRestartOpenShellCommand(sessionId: string): string {
  return [
    "pkill -f '/Applications/Codex.app/Contents/MacOS/ChatGPT' || true",
    "sleep 2",
    codexOpenShellCommand(sessionId),
    "sleep 5",
    codexOpenShellCommand(sessionId),
  ].join("; ");
}

function parseCodexOpenSessionCommand(content: string): { sessionId: string; restart: boolean } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /^(?:(codex\s+reopen|codex\s+restart-open|reopen\s+codex|restart\s+codex)|(?:codex\s+open|open\s+codex|open\s+session))\s+([0-9a-f-]{32,36})$/i,
  );

  return match ? { sessionId: (match[2] ?? "").toLowerCase(), restart: Boolean(match[1]) } : null;
}

function parseKeyedValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`(?:^|\\s)${key}:([^\\n]+?)(?=\\s+[a-z]+:|$)`, "i"));
  return match?.[1]?.trim() || null;
}

function parseAdminNewChat(content: string): Omit<Extract<RoutedDiscordMessage, { type: "admin-new-chat" }>, "type"> | null {
  const encoded = parseEncodedNewChatCommand(content);

  if (encoded) {
    return encoded;
  }

  const normalized = content.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:codex\s+)?(?:chat\s+new|new\s+chat)(?:\s+(.+))?$/i);

  if (!match) {
    return null;
  }

  const rest = match[1]?.trim() ?? "";
  const keyedCwd = parseKeyedValue(rest, "cwd") ?? parseKeyedValue(rest, "path");
  const keyedName = parseKeyedValue(rest, "name");
  const keyedPrompt = parseKeyedValue(rest, "prompt");
  const currentMatch = rest.match(/^(?:current|here)(?:\s+(.+))?$/i);
  const isGeneral = rest.length === 0 || /^general$/i.test(rest);

  if (currentMatch) {
    const currentRest = currentMatch[1]?.trim() ?? "";
    return {
      name: parseKeyedValue(currentRest, "name") ?? (currentRest.length > 0 ? currentRest : null),
      cwd: ".",
      useCategory: true,
      initialPrompt: parseKeyedValue(currentRest, "prompt"),
    };
  }

  if (keyedCwd || keyedName || keyedPrompt || isGeneral) {
    return {
      name: keyedName,
      cwd: keyedCwd,
      useCategory: Boolean(keyedCwd),
      initialPrompt: keyedPrompt,
    };
  }

  if (/^(?:\/|\.{1,2}\/|~\/)/.test(rest)) {
    return {
      name: null,
      cwd: rest,
      useCategory: true,
      initialPrompt: null,
    };
  }

  return {
    name: rest,
    cwd: null,
    useCategory: false,
    initialPrompt: null,
  };
}

function parseSyncLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 25;
  }

  return Math.min(parsed, 100);
}

function parseAdminSync(content: string): { limit: number } | null {
  const match = content.match(/^(?:codex\s+)?(?:sync|resync)\s+(?:all|run|now)(?:\s+(\d+))?$/i);

  if (!match) {
    return null;
  }

  return { limit: parseSyncLimit(match[1]) };
}

function parseAdminSyncSelect(content: string): { limit: number } | null {
  const match = content.match(/^(?:codex\s+)?sync(?:\s+select)?(?:\s+(\d+))?$/i);

  if (!match) {
    return null;
  }

  return { limit: parseSyncLimit(match[1]) };
}

function parseAdminSyncSelected(content: string): { sessionIds: string[] } | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:codex )?sync selected (.+)$/i);

  if (!match) {
    return null;
  }

  const sessionIds = match[1]
    .split(" ")
    .map((sessionId) => sessionId.trim().toLowerCase())
    .filter((sessionId) => /^[0-9a-f-]{32,36}$/i.test(sessionId));

  if (sessionIds.length === 0) {
    return null;
  }

  return { sessionIds: [...new Set(sessionIds)] };
}

function parseAdminSyncStatus(content: string): boolean {
  return /^(?:codex\s+)?sync\s+status$/i.test(content.trim());
}

function parseAdminSyncMode(content: string): { mode: TranscriptSyncMode } | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:codex )?sync mode (on-chat|realtime)$/);

  if (!match) {
    return null;
  }

  return {
    mode: match[1] === "realtime" ? "realtime" : "on-chat",
  };
}

function parseBotReload(content: string): {
  mode: "commands" | "restart";
  confirmed: boolean;
  force: boolean;
} | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:bot )?reload(?: (commands|restart))?(?: (force))?(?: (confirm))?$/);

  if (!match) {
    return null;
  }

  const mode = match[1] === "restart" ? "restart" : "commands";
  const force = mode === "restart" && match[2] === "force";

  if (match[2] === "force" && mode !== "restart") {
    return null;
  }

  return {
    mode,
    force,
    confirmed: mode === "commands" || match[3] === "confirm",
  };
}

function parseAdminClearMessages(content: string): { mode: "all" | "count"; count?: number; confirmed: boolean } | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const match = normalized.match(/^clear(?: (all|[1-9]\d{0,2}))?(?: (confirm))?$/);

  if (!match) {
    return null;
  }

  if (!match[1] || match[1] === "all") {
    return { mode: "all", confirmed: match[2] === "confirm" };
  }

  return { mode: "count", count: Math.min(Number.parseInt(match[1], 10), 100), confirmed: true };
}

function parseAdminSyncDelete(content: string): {
  mode: "all" | "channels" | "session";
  sessionId?: string | null;
  confirmed: boolean;
} | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const sessionMatch = normalized.match(/^(?:codex )?sync delete session ([a-z0-9._:-]{1,128})(?: (confirm))?$/);

  if (sessionMatch) {
    return {
      mode: "session",
      sessionId: sessionMatch[1],
      confirmed: sessionMatch[2] === "confirm",
    };
  }

  const match = normalized.match(/^(?:codex )?sync delete(?: (preview|channels|all))?(?: (confirm))?$/);

  if (!match) {
    return null;
  }

  const action = match[1] ?? "preview";
  const confirmed = match[2] === "confirm";

  if (action === "preview") {
    return { mode: "all", confirmed: false };
  }

  return {
    mode: action === "channels" ? "channels" : "all",
    confirmed,
  };
}

function parseAdminArchive(content: string): { sessionId: string; confirmed: boolean } | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:codex )?sync archive ([0-9a-f-]{32,36})(?: (confirm))?$/);

  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    confirmed: match[2] === "confirm",
  };
}

function parseScheduleCommand(content: string): ScheduleCommandRequest | null {
  const encoded = parseEncodedScheduleCommand(content);

  if (encoded) {
    return encoded;
  }

  const normalized = content.replace(/\s+/g, " ").trim();

  if (/^schedule list$/i.test(normalized)) {
    return { action: "list" };
  }

  const deleteMatch = normalized.match(/^schedule delete (\S+)$/i);

  if (deleteMatch) {
    return { action: "delete", id: deleteMatch[1] };
  }

  const everyMatch = normalized.match(/^schedule every (\S+) command:(.+)$/i);

  if (everyMatch) {
    return {
      action: "create",
      mode: "every",
      every: everyMatch[1],
      command: everyMatch[2].trim(),
    };
  }

  const dailyMatch = normalized.match(/^schedule daily at (\d{1,2}:\d{2}) command:(.+)$/i);

  if (dailyMatch) {
    return {
      action: "create",
      mode: "daily",
      at: dailyMatch[1],
      command: dailyMatch[2].trim(),
    };
  }

  const weeklyMatch = normalized.match(/^schedule weekly ([^ ]+) at (\d{1,2}:\d{2}) command:(.+)$/i);

  if (weeklyMatch) {
    return {
      action: "create",
      mode: "weekly",
      weekdays: weeklyMatch[1],
      at: weeklyMatch[2],
      command: weeklyMatch[3].trim(),
    };
  }

  const onceMatch = normalized.match(/^schedule once at (.+?) command:(.+)$/i);

  if (onceMatch) {
    return {
      action: "create",
      mode: "once",
      at: onceMatch[1],
      command: onceMatch[2].trim(),
    };
  }

  return null;
}

function parseSessionArchive(content: string): { confirmed: boolean } | null {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim().replace(/^!/, "");
  const match = normalized.match(/^archive(?: (confirm))?$/);

  if (!match) {
    return null;
  }

  return { confirmed: match[1] === "confirm" };
}

function authorizationDenied(input: RouteDiscordMessageInput): Extract<RoutedDiscordMessage, { type: "denied" }> | null {
  const authorization = authorizeCommand({
    userRoleIds: input.userRoleIds,
    allowedRoleIds: input.allowedRoleIds,
  });

  return authorization.allowed
    ? null
    : {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
}

function blockedCommand(reason: string, guidance: string): Extract<RoutedDiscordMessage, { type: "blocked-command" }> {
  return { type: "blocked-command", reason, guidance };
}

function adminCodexBlock(content: string): Extract<RoutedDiscordMessage, { type: "blocked-command" }> | null {
  const bridgeShortcut = parseBridgeShortcut(content);

  if (
    bridgeShortcut &&
    (bridgeShortcut.type === "codex-chat" ||
      bridgeShortcut.type === "claude-chat" ||
      bridgeShortcut.type === "agent-model" ||
      bridgeShortcut.type === "codex-run-mode" ||
      bridgeShortcut.type === "codex-review")
  ) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "Codex/Claude와 대화하거나 모델/리뷰 명령을 실행하려면 session 채널을 사용하세요.",
    );
  }

  if (content.startsWith("codex ")) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "Codex와 대화하려면 /chat-new로 세션 채널을 만들거나 기존 session 채널에서 메시지를 보내세요.",
    );
  }

  if (content.startsWith("claude ")) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "Claude Code와 대화하려면 /chat-new로 session 채널을 만들거나 기존 session 채널에서 `claude ...`를 보내세요.",
    );
  }

  if (parseCodexModel(content)) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "모델 설정과 Codex 요청은 session 채널에서 실행하세요.",
    );
  }

  if (parseCodexRunMode(content)) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "모델 설정과 Codex 요청은 session 채널에서 실행하세요.",
    );
  }

  if (parseInternalCodexReview(content) || parseCodexReviewCommand(content)) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "리뷰는 session 채널에서 실행하거나 /chat-new로 새 session을 만든 뒤 요청하세요.",
    );
  }

  if (parseAgentUsageShortcut(content)) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "/howtouse는 Codex 또는 Claude Code session 채널에서 실행하세요.",
    );
  }

  if (parseCodexShortcut(content)) {
    return blockedCommand(
      "main 채널은 운영 전용입니다.",
      "테스트 수정 요청은 session 채널에서 실행하세요. main에서는 !pnpm test처럼 shell만 실행할 수 있습니다.",
    );
  }

  if (parseSessionArchive(content)) {
    return blockedCommand(
      "이 명령은 session 채널 전용입니다.",
      "현재 세션을 보관하려면 해당 session 채널에서 /archive 또는 archive confirm을 실행하세요.",
    );
  }

  return null;
}

function sessionGlobalBlock(content: string): Extract<RoutedDiscordMessage, { type: "blocked-command" }> | null {
  if (parseBotReload(content)) {
    return blockedCommand(
      "이 명령은 main 채널 전용입니다.",
      "봇 명령어 재등록과 재시작은 main/admin 채널에서 실행하세요.",
    );
  }

  if (parseAdminClearMessages(content)) {
    return blockedCommand(
      "이 명령은 main 채널 전용입니다.",
      "메시지 삭제는 관리자 채널에서 /clear 또는 clear <개수>로 실행하세요.",
    );
  }

  if (
    parseAdminSyncStatus(content) ||
    parseAdminSyncMode(content) ||
    parseAdminSyncSelect(content) ||
    parseAdminSyncSelected(content) ||
    parseAdminSyncDelete(content) ||
    parseAdminSync(content) ||
    parseAdminArchive(content)
  ) {
    return blockedCommand(
      "이 명령은 main 채널 전용입니다.",
      "세션 동기화는 main/admin 채널에서 실행하세요.",
    );
  }

  return null;
}

export function routeDiscordMessage(input: RouteDiscordMessageInput): RoutedDiscordMessage {
  const trimmedContent = input.content.trim();

  if (trimmedContent === "help" || trimmedContent === "!help" || trimmedContent === "?") {
    return { type: "bot-help" };
  }

  const componentShellCommand = parseComponentShellCommand(trimmedContent);

  if (componentShellCommand) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return {
      type: "execute-command",
      command: componentShellCommand.command,
      confirmedDangerous: componentShellCommand.confirmedDangerous,
    };
  }

  const newChat = parseAdminNewChat(trimmedContent);

  if (newChat) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return { type: "admin-new-chat", ...newChat };
  }

  const codexContinueSession = parseEncodedCodexContinueCommand(trimmedContent);

  if (codexContinueSession) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return { type: "codex-continue-session", ...codexContinueSession };
  }

  const forkSession = parseEncodedForkSessionCommand(trimmedContent) ?? parseForkSessionCommand(trimmedContent);

  if (forkSession) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    if (input.channelMode === "shell-admin") {
      return blockedCommand(
        "이 명령은 session thread 전용입니다.",
        "Codex 또는 Claude Code 세션 thread 안에서 /fork를 실행하세요.",
      );
    }

    return { type: "fork-session", name: forkSession.name };
  }

  const queueControl = parseQueueControlCommand(trimmedContent);

  if (queueControl) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return queueControl;
  }

  const agentCompact = parseAgentCompactCommand(trimmedContent);

  if (agentCompact) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    if (input.channelMode === "shell-admin") {
      return blockedCommand(
        "이 명령은 session thread 전용입니다.",
        "압축할 Codex 또는 Claude Code session thread에서 /compact를 실행하세요.",
      );
    }

    if (input.channelMode === "claude-code") {
      return {
        type: "claude-chat",
        content: agentCompact.prompt ? `/compact ${agentCompact.prompt}` : "/compact",
      };
    }

    const generatedPrompt = agentCompact.prompt
      ? `지금까지의 작업 맥락을 압축 요약해줘. ${agentCompact.prompt}`
      : "지금까지의 작업 맥락을 압축 요약해줘.";
    return {
      type: "codex-chat",
      content: localizeConnectorText(generatedPrompt, input.locale ?? "ko"),
    };
  }

  const codexOpenSession = parseCodexOpenSessionCommand(trimmedContent);

  if (codexOpenSession) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return {
      type: "execute-command",
      command: codexOpenSession.restart
        ? codexRestartOpenShellCommand(codexOpenSession.sessionId)
        : codexOpenShellCommand(codexOpenSession.sessionId),
      confirmedDangerous: codexOpenSession.restart,
    };
  }

  if (/^(?:where|status|context|target|pwd\?)$/i.test(trimmedContent)) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return { type: "channel-status" };
  }

  const agentModel = parseAgentModel(trimmedContent);
  const agentEffort = parseAgentEffort(trimmedContent);
  const agentSettings = parseAgentSettings(trimmedContent);

  if (agentModel || agentEffort || agentSettings) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    if (input.channelMode === "shell-admin" && !input.agentMain) {
      return blockedCommand(
        "이 채널에는 agent 기본 설정 대상이 없습니다.",
        "Codex 또는 Claude Code main 채널에서 모델과 effort 기본값을 설정하세요.",
      );
    }

    if (agentModel) {
      return { type: "agent-model", model: agentModel.model };
    }

    if (agentEffort) {
      return { type: "agent-effort", effort: agentEffort.effort };
    }

    return { type: "agent-settings" };
  }

  if (/^(?:maintenance|maint|유지보수)$/i.test(trimmedContent)) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return { type: "maintenance-panel" };
  }

  if (input.channelMode === "shell-admin") {
    const blocked = adminCodexBlock(trimmedContent);

    if (blocked) {
      const denied = authorizationDenied(input);
      return denied ?? blocked;
    }
  }

  if (input.channelMode !== "shell-admin") {
    const blocked = sessionGlobalBlock(trimmedContent);

    if (blocked) {
      const denied = authorizationDenied(input);
      return denied ?? blocked;
    }
  }

  const agentUsageShortcut = parseAgentUsageShortcut(trimmedContent, input.locale);

  if (agentUsageShortcut) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return input.channelMode === "claude-code"
      ? { type: "claude-chat", content: agentUsageShortcut.content }
      : { type: "codex-chat", content: agentUsageShortcut.content };
  }

  const bridgeShortcut = parseBridgeShortcut(trimmedContent, input.locale);

  if (
    input.channelMode === "claude-code" &&
    bridgeShortcut &&
    (bridgeShortcut.type === "codex-chat" ||
      bridgeShortcut.type === "agent-model" ||
      bridgeShortcut.type === "codex-run-mode" ||
      bridgeShortcut.type === "codex-review")
  ) {
    return blockedCommand(
      "Claude Code 전용 채널입니다.",
      "Codex와 대화하거나 Codex 설정을 바꾸려면 Codex 채널이나 session 채널에서 요청하세요.",
    );
  }

  if (bridgeShortcut) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return bridgeShortcut;
  }

  const schedule = parseScheduleCommand(trimmedContent);

  if (schedule) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return { type: "schedule-command", request: schedule };
  }

  const codexRunMode = input.channelMode === "claude-code" ? null : parseCodexRunMode(trimmedContent);

  if (codexRunMode) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return { type: "codex-run-mode", mode: codexRunMode.mode };
  }

  const codexReview =
    input.channelMode === "claude-code"
      ? null
      : parseInternalCodexReview(trimmedContent, input.locale) ??
        parseCodexReviewCommand(trimmedContent, input.locale);

  if (codexReview) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return { type: "codex-review", prompt: codexReview.prompt };
  }

  const codexShortcut = input.channelMode === "claude-code"
    ? null
    : parseCodexShortcut(trimmedContent, input.locale);

  if (codexShortcut) {
    const denied = authorizationDenied(input);

    if (denied) {
      return denied;
    }

    return { type: "codex-chat", content: codexShortcut.content };
  }

  const reload = parseBotReload(trimmedContent);

  if (reload && (input.channelMode === "shell-admin" || !/^reload$/i.test(trimmedContent))) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return { type: "bot-reload", ...reload };
  }

  const currentChannelArchive = input.channelMode === "session-linked" ? parseSessionArchive(trimmedContent) : null;

  if (currentChannelArchive) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return { type: "archive-session", sessionId: null, confirmed: currentChannelArchive.confirmed };
  }

  if (input.channelMode === "shell-admin") {
    const clearMessages = parseAdminClearMessages(trimmedContent);

    if (clearMessages) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-clear-messages", ...clearMessages };
    }

    const archive = parseAdminArchive(trimmedContent);

    if (archive) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "archive-session", sessionId: archive.sessionId, confirmed: archive.confirmed };
    }

    if (parseAdminSyncStatus(trimmedContent)) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-sync-status" };
    }

    const syncMode = parseAdminSyncMode(trimmedContent);

    if (syncMode) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-sync-mode", mode: syncMode.mode };
    }

    const syncSelect = parseAdminSyncSelect(trimmedContent);

    if (syncSelect) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-sync-select", limit: syncSelect.limit };
    }

    const chatResume = parseChatResume(trimmedContent);

    if (chatResume) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return chatResume.sessionId
        ? { type: "claude-resume", sessionId: chatResume.sessionId }
        : { type: "claude-resume-list" };
    }

    const syncSelected = parseAdminSyncSelected(trimmedContent);

    if (syncSelected) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-sync-selected", sessionIds: syncSelected.sessionIds };
    }

    const syncDelete = parseAdminSyncDelete(trimmedContent);

    if (syncDelete) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-sync-delete", ...syncDelete };
    }

    const sync = parseAdminSync(trimmedContent);

    if (sync) {
      const authorization = authorizeCommand({
        userRoleIds: input.userRoleIds,
        allowedRoleIds: input.allowedRoleIds,
      });

      if (!authorization.allowed) {
        return {
          type: "denied",
          reason: authorization.reason ?? "User does not have an allowed role",
        };
      }

      return { type: "admin-sync", limit: sync.limit };
    }
  }

  if (trimmedContent.startsWith("codex ")) {
    if (input.channelMode === "claude-code") {
      return blockedCommand(
        "Claude Code 전용 채널입니다.",
        "Codex와 대화하려면 Codex 채널이나 session 채널에서 요청하세요.",
      );
    }

    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return { type: "codex-chat", content: trimmedContent.slice("codex ".length).trim() };
  }

  if (trimmedContent.startsWith("claude ")) {
    const authorization = authorizeCommand({
      userRoleIds: input.userRoleIds,
      allowedRoleIds: input.allowedRoleIds,
    });

    if (!authorization.allowed) {
      return {
        type: "denied",
        reason: authorization.reason ?? "User does not have an allowed role",
      };
    }

    return { type: "claude-chat", content: trimmedContent.slice("claude ".length).trim() };
  }

  const parsed = parseDiscordMessageCommand({
    mode: input.channelMode,
    content: trimmedContent,
  });

  const authorization = authorizeCommand({
    userRoleIds: input.userRoleIds,
    allowedRoleIds: input.allowedRoleIds,
  });

  if (!authorization.allowed) {
    return {
      type: "denied",
      reason: authorization.reason ?? "User does not have an allowed role",
    };
  }

  if (parsed.kind === "chat") {
    if (input.channelMode === "claude-code") {
      return { type: "claude-chat", content: parsed.content };
    }

    return { type: "codex-chat", content: parsed.content };
  }

  const confirmedCommand = parseExplicitConfirmation(parsed.command);

  return {
    type: "execute-command",
    command: confirmedCommand.command,
    confirmedDangerous: confirmedCommand.confirmedDangerous,
  };
}
