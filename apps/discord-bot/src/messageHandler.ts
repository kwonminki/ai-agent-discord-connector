import {
  classifyCommand,
  extractHarnessCandidate,
  extractHarnessInterviewBrief,
  stripHarnessBuilderBlocks,
  type ConnectorLocale,
  type HarnessProvider,
  type HarnessSourceMode,
} from "../../../packages/core/src/index.js";
import type { ManagedDiscordChannelContext } from "./channelContext.js";
import type {
  DeletePreviewResult,
  DeleteSyncedDiscordSessionsResult,
  SyncedDeleteMode,
} from "./codexSessionDelete.js";
import type { ArchiveSyncedCodexSessionResult } from "./codexSessionArchive.js";
import type { NewCodexChatResult } from "./codexNewChat.js";
import type {
  DiscordGuildSurface,
  SyncCodexSessionsProgress,
  SyncCodexSessionsResult,
} from "./codexSessionSync.js";
import type { SyncCodexSessionTranscriptUpdatesResult } from "./codexTranscriptSync.js";
import type {
  CodexPromptApprovalDecision,
  CodexPromptApprovalRequest,
  CodexPromptUserInputRequest,
  CodexPromptUserInputResponse,
  ControlApiJobResponse,
  ControlApiClient,
  AgentPromptProgressEvent,
} from "./controlApiClient.js";
import type { TranscriptSyncMode } from "./directState.js";
import type { DiscordIncomingAttachment, MaterializedDiscordAttachment } from "./incomingAttachments.js";
import { extractAgentSurveyRequests } from "./agentSurvey.js";
import type { AgentDefaultSettings, AgentEffort, AgentKind } from "./agentSettings.js";
import { createAgentSettingsController } from "./agentSettingsController.js";
import { buildAgentRelayCallbackMessages, collectAgentResultFiles } from "./agentRelayBridge.js";
import type { ActiveRelayPresence } from "./agentRelayPresence.js";
import type { ScheduleCommandRequest, ScheduleCommandResult } from "./scheduler.js";
import { routeDiscordMessage } from "./commandRouter.js";
import type { HarnessCommandRequest } from "./commandRouter.js";
import {
  formatHarnessBuildStatus,
  formatHarnessBuilderNotice,
  formatHarnessBuilderGuide,
  formatHarnessCandidateSaved,
  formatHarnessInterviewProgress,
  formatHarnessList,
  formatHarnessPublished,
  formatHarnessRunReady,
  formatHarnessRunStatus,
  harnessBuilderPrompt,
  harnessBuilderRepairPrompt,
  harnessExecutionPrompt,
} from "./harnessPrompts.js";
import type {
  HarnessBuildState,
  HarnessRunState,
  HarnessStore,
  PublishedHarnessVersionState,
} from "./harnessStore.js";
import {
  applyHarnessProgressEvent,
  createHarnessProgressState,
  formatHarnessProgress,
  formatHarnessProgressReport,
  type HarnessProgressState,
} from "./harnessProgress.js";
import type { DiscordMessagePayload } from "./responses.js";
import { AGENT_PROGRESS_EVENT_LIMIT, isAgentQuestionMessage, withRoleMentions } from "./responses.js";
import {
  formatAgentAck,
  formatCodexApprovalDecision,
  formatCodexApprovalRequest,
  formatCodexUserInputReceived,
  formatCodexUserInputRequest,
  formatAgentSettingsResult,
  formatAgentProgressUpdate,
  formatAgentResultUpdate,
  formatAgentSurveyMessages,
  formatAgentSurveySelectionResult,
  formatBlockedCommand,
  formatCommandAck,
  formatCommandResultUpdate,
  formatArchiveAck,
  formatArchiveResult,
  formatChannelStatus,
  formatClearConfirmation,
  formatClearResult,
  formatDeleteAck,
  formatDeletePreview,
  formatDeleteResult,
  formatDenied,
  formatHelp,
  formatForkedSessionThreadNotice,
  formatForkSessionAck,
  formatForkSessionResult,
  formatAgentResultPosted,
  formatLiveAgentProgress,
  isIntermediateAgentResult,
  splitDiscordMessageContent,
  formatMaintenancePanel,
  formatNewChatAck,
  formatNewChatResult,
  formatReloadAck,
  formatReloadConfirmation,
  formatReloadResult,
  formatRestartDrainPending,
  formatAgentMainChannelGuidance,
  formatClaudeResumeAck,
  formatClaudeResumeResult,
  formatClaudeResumeSelection,
  formatSyncSelection,
  formatSyncSelectionAck,
  formatSyncAck,
  formatSyncModeResult,
  formatSyncStatus,
  formatSyncProgressUpdate,
  formatSyncResultUpdate,
  formatScheduleResult,
  formatCodexRunModeResult,
  formatCodexTurnControlResult,
  formatQueueClearResult,
  formatQueueStatus,
  getAgentResultContinuationMessages,
} from "./responses.js";
import type { CodexPermissionSettings, SelectableCodexSession } from "./responses.js";

export const DEFAULT_AGENT_PROMPT_TIMEOUT_MS = 5 * 60 * 60 * 1_000;
const AUTO_STEER_READY_RETRY_ATTEMPTS = 8;
const DEFAULT_AUTO_STEER_RETRY_DELAY_MS = 250;
export const DEFAULT_HARNESS_VALIDATION_RETRY_ATTEMPTS = 3;
const MAX_HARNESS_VALIDATION_RETRY_ATTEMPTS = 5;

export interface BotReloadExecutionState {
  activeCount: number;
  pendingCount: number;
}

export interface BotReloadResult extends BotReloadExecutionState {
  mode: "commands" | "restart";
  commandCount: number;
  restarting: boolean;
  deferred?: boolean;
  forced?: boolean;
  startedAt: string;
}

export function resolveAgentPromptTimeoutMs(
  channelTimeoutMs: number,
  configuredValue = process.env.CONNECT_CODEX_PROMPT_TIMEOUT_MS,
): number {
  const trimmedValue = configuredValue?.trim();

  if (trimmedValue === "0") {
    return 0;
  }

  const configuredTimeoutMs = Number.parseInt(trimmedValue ?? "", 10);
  const codexTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_AGENT_PROMPT_TIMEOUT_MS;

  return Math.max(channelTimeoutMs, codexTimeoutMs);
}

export function resolveHarnessValidationRetryAttempts(
  configuredValue = process.env.CONNECT_HARNESS_VALIDATION_RETRIES,
): number {
  const parsed = Number.parseInt(configuredValue?.trim() ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_HARNESS_VALIDATION_RETRY_ATTEMPTS;
  }
  return Math.min(Math.max(parsed, 0), MAX_HARNESS_VALIDATION_RETRY_ATTEMPTS);
}

export type { ManagedDiscordChannelContext } from "./channelContext.js";

export interface DiscordMessageLike {
  authorBot: boolean;
  relayRequest?: boolean;
  relayCancelRequestId?: string;
  userId: string;
  channelId: string;
  content: string;
  roleIds: string[];
  messageId?: string;
  attachments?: DiscordIncomingAttachment[];
  requestId?: string;
  durableQueuedAt?: string;
  restoreOnly?: boolean;
  guild?: DiscordGuildSurface | null;
  clearMessages?(input: { mode: "all" | "count"; count?: number }): Promise<{ deletedCount: number; requestedCount?: number | null }>;
  reply(message: DiscordOutgoingMessage): Promise<DiscordReplyLike | void>;
}

export interface DiscordReplyLike {
  edit(message: DiscordOutgoingMessage): Promise<unknown>;
}

export type DiscordOutgoingMessage = string | DiscordMessagePayload;

export interface CreateDiscordMessageHandlerInput {
  locale?: ConnectorLocale;
  resolveChannelContext(channelId: string): Promise<ManagedDiscordChannelContext | null>;
  submitCommandJob: ControlApiClient["submitCommandJob"];
  submitCodexPrompt?: ControlApiClient["submitCodexPrompt"];
  controlCodexTurn?: ControlApiClient["controlCodexTurn"];
  autoSteerRetryDelayMs?: number;
  harnessValidationRetryAttempts?: number;
  submitClaudePrompt?: ControlApiClient["submitClaudePrompt"];
  syncCodexSessions?: (input: {
    guild: DiscordGuildSurface;
    limit: number;
    sessionIds?: string[];
    onProgress?: (progress: SyncCodexSessionsProgress) => Promise<void> | void;
  }) => Promise<SyncCodexSessionsResult>;
  createNewCodexChat?: (input: {
    guild: DiscordGuildSurface;
    name: string | null;
    cwd: string | null;
    currentCwd: string;
    useCategory: boolean;
    initialPrompt: string | null;
    channelMode: "session-linked" | "claude-code";
    sessionThreadParentChannelId: string | null;
  }) => Promise<NewCodexChatResult>;
  createForkedSessionThread?: (input: {
    guild: DiscordGuildSurface;
    sourceDiscordChannelId: string;
    sourceSessionId: string;
    name: string;
  }) => Promise<NewCodexChatResult>;
  discardForkedSessionThread?: (input: {
    guild: DiscordGuildSurface;
    discordChannelId: string;
  }) => Promise<boolean>;
  linkNewCodexSession?: (input: {
    discordChannelId: string;
    codexSessionId: string;
    threadName: string;
  }) => Promise<void>;
  recordClaudeSession?: (input: {
    discordChannelId: string;
    claudeSessionId: string;
  }) => Promise<void> | void;
  updateAgentDefaults?: (
    agent: AgentKind,
    patch: { model?: string | null; effort?: AgentEffort },
  ) => Promise<AgentDefaultSettings>;
  updateSessionAgentSettings?: (
    discordChannelId: string,
    patch: { model?: string | null; effort?: AgentEffort | null },
  ) => Promise<void>;
  previewSelectableCodexSessions?: (input: { limit: number }) => Promise<{
    sessions: SelectableCodexSession[];
    totalAvailable: number;
    limit: number;
  }>;
  listResumableClaudeSessions?: (input: { limit: number }) => Promise<Array<{
    id: string;
    firstUserMessage: string | null;
    cwd: string;
    updatedAt: string;
  }>>;
  resumeClaudeSession?: (input: {
    sessionId: string;
    guild: DiscordGuildSurface;
  }) => Promise<
    | { status: "created"; channelId: string; threadName: string }
    | { status: "already-linked"; channelId: string }
    | { status: "not-found" }
  >;
  getSyncStatus?: () => Promise<{
    workspaceCount: number;
    sessionChannelCount: number;
    archivedSessionCount: number;
    contextPostedCount: number;
    transcriptSyncMode: TranscriptSyncMode;
    transcriptSyncedChannelCount: number;
  }>;
  setTranscriptSyncMode?: (mode: TranscriptSyncMode) => Promise<{ mode: TranscriptSyncMode }>;
  syncTranscriptUpdates?: (input: {
    guild: DiscordGuildSurface;
    discordChannelId?: string;
    trigger: "on-chat" | "realtime";
    postUpdates?: boolean;
  }) => Promise<SyncCodexSessionTranscriptUpdatesResult>;
  setSessionStreaming?: (sessionId: string, active: boolean) => void;
  markDiscordRequestedCodexSession?: (
    sessionId: string,
    options?: { discordChannelId?: string | null; completionMentionSent?: boolean },
  ) => Promise<void> | void;
  resolveCodexGoalStatus?: (sessionId: string) => Promise<string | null>;
  reloadBot?: (input: {
    mode: "commands" | "restart";
    execution: BotReloadExecutionState;
    force: boolean;
  }) => Promise<BotReloadResult>;
  previewSyncedChannelsDelete?: (input: {
    mode: SyncedDeleteMode;
    sessionId?: string | null;
  }) => Promise<DeletePreviewResult>;
  deleteSyncedChannels?: (input: {
    guild: DiscordGuildSurface;
    mode: SyncedDeleteMode;
    sessionId?: string | null;
  }) => Promise<DeleteSyncedDiscordSessionsResult>;
  archiveSyncedSession?: (input: {
    guild: DiscordGuildSurface | null | undefined;
    discordChannelId: string;
    codexSessionId?: string | null;
  }) => Promise<ArchiveSyncedCodexSessionResult>;
  scheduleCommand?: (input: {
    request: ScheduleCommandRequest;
    channelId: string;
    userId: string;
    roleIds: string[];
  }) => Promise<ScheduleCommandResult>;
  updateChannelCwd: ControlApiClient["updateChannelCwd"];
  recordCommandAudit: ControlApiClient["recordCommandAudit"];
  resolveRelayPresence?: (threadId: string) => Promise<ActiveRelayPresence | null>;
  persistDurableRequest?: (input: {
    requestId?: string;
    channelId: string;
    userId: string;
    content: string;
    roleIds: string[];
    authorBot?: boolean;
    messageId?: string;
    relayRequest?: boolean;
    createdAt?: string;
  }) => Promise<{ requestId: string; createdAt: string }>;
  completeDurableRequest?: (requestId: string) => Promise<void>;
  relayControlChannelId?: string | null;
  materializeIncomingAttachments?: (input: {
    messageId: string;
    attachments: DiscordIncomingAttachment[];
    content: string;
  }) => Promise<{ content: string; files: MaterializedDiscordAttachment[] }>;
  harnessStore?: HarnessStore;
}

export interface DiscordMessageHandler {
  (message: DiscordMessageLike): Promise<void>;
  drainRestoredMessages(): void;
}

function extractUpdatedCwd(response: Awaited<ReturnType<ControlApiClient["submitCommandJob"]>>): string | null {
  if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
    return null;
  }

  const cwd = (response.result as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function extractResultStatus(response: Awaited<ReturnType<ControlApiClient["submitCommandJob"]>>): string {
  if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
    return "failed";
  }

  const status = (response.result as { status?: unknown }).status;
  return typeof status === "string" && status.length > 0 ? status : "unknown";
}

function promptResponseFailed(response: { result?: unknown; error?: unknown }): boolean {
  if ("error" in response && response.error) {
    return true;
  }

  if (!("result" in response) || typeof response.result !== "object" || response.result === null) {
    return true;
  }

  return (response.result as { status?: unknown }).status === "failed";
}

async function recordCommandAudit(
  input: CreateDiscordMessageHandlerInput,
  details: {
    discordChannelId: string;
    userId: string;
    cwd: string;
    rawCommand: string;
    resultStatus: string;
  },
) {
  try {
    await input.recordCommandAudit({
      ...details,
      tier: classifyCommand(details.rawCommand).tier,
    });
  } catch (error) {
    console.error("discord-bot failed to record command audit", error);
  }
}

async function updateQueuedReply(
  queuedReply: DiscordReplyLike | void,
  fallbackReply: (message: DiscordOutgoingMessage) => Promise<DiscordReplyLike | void>,
  message: DiscordOutgoingMessage,
): Promise<void> {
  if (queuedReply && typeof queuedReply.edit === "function") {
    await queuedReply.edit(message);
    return;
  }

  await fallbackReply(message);
}

async function updateQueuedResultReply(input: {
  message: DiscordMessageLike;
  queuedReply: DiscordReplyLike | void;
  fallbackReply: (message: DiscordOutgoingMessage) => Promise<DiscordReplyLike | void>;
  payload: DiscordMessagePayload;
  postAsNewMessage?: boolean;
  terminalPayload?: DiscordMessagePayload;
  questionMentionRoleIds?: string[];
}): Promise<boolean> {
  if (input.postAsNewMessage && input.message.guild?.sendTextMessage) {
    if (input.terminalPayload) {
      try {
        await updateQueuedReply(input.queuedReply, input.fallbackReply, input.terminalPayload);
      } catch (error) {
        console.warn("discord-bot failed to close the progress message before posting the final answer", error);
      }
    }

    let postedFinalAnswer = false;

    try {
      await input.message.guild.sendTextMessage(input.message.channelId, input.payload);
      postedFinalAnswer = true;
    } catch (error) {
      console.warn("discord-bot failed to post the final answer as a new message; falling back to the progress message", error);
    }

    if (postedFinalAnswer) {
      return sendResultContinuations(input);
    }
  }

  await updateQueuedReply(input.queuedReply, input.fallbackReply, input.payload);
  return sendResultContinuations(input);
}

async function sendResultContinuations(input: {
  message: DiscordMessageLike;
  fallbackReply: (message: DiscordOutgoingMessage) => Promise<DiscordReplyLike | void>;
  payload: DiscordMessagePayload;
  questionMentionRoleIds?: string[];
}): Promise<boolean> {
  const mentionRoleIds = input.questionMentionRoleIds?.filter((roleId) => roleId.trim().length > 0) ?? [];
  let questionMentionSent = false;

  for (const continuation of getAgentResultContinuationMessages(input.payload)) {
    const mentionQuestion = isAgentQuestionMessage(continuation) && mentionRoleIds.length > 0;

    if (input.message.guild?.sendTextMessage) {
      try {
        if (mentionQuestion) {
          await input.message.guild.sendTextMessage(
            input.message.channelId,
            continuation,
            { mentionRoleIds },
          );
          questionMentionSent = true;
        } else {
          await input.message.guild.sendTextMessage(input.message.channelId, continuation);
        }
        continue;
      } catch (error) {
        console.warn("discord-bot failed to send a final-answer continuation directly", error);
      }
    }

    try {
      await input.fallbackReply(mentionQuestion ? withRoleMentions(continuation, mentionRoleIds) : continuation);
      questionMentionSent ||= mentionQuestion;
    } catch (error) {
      console.warn("discord-bot failed to send a final-answer continuation", error);
    }
  }

  return questionMentionSent;
}

function createReplyWithOptionalRoleMentions(
  reply: DiscordMessageLike["reply"],
  roleIds: string[],
): DiscordMessageLike["reply"] {
  const mentionRoleIds = roleIds.filter((roleId) => roleId.trim().length > 0);

  if (mentionRoleIds.length === 0) {
    return reply;
  }

  return async (replyMessage) => {
    const queuedReply = await reply(withRoleMentions(replyMessage, mentionRoleIds));

    if (!queuedReply) {
      return queuedReply;
    }

    return {
      edit: (nextMessage) => queuedReply.edit(withRoleMentions(nextMessage, mentionRoleIds)),
    };
  };
}

async function sendThreadCompletionMention(input: {
  message: DiscordMessageLike;
  channelContext: ManagedDiscordChannelContext;
  agentLabel: "Codex" | "Claude Code";
  failed: boolean;
  intermediate?: boolean;
  deferForPendingRequest?: boolean;
  pendingRequestCount?: number;
}): Promise<"sent" | "deferred" | "unavailable"> {
  if (input.message.relayRequest || input.deferForPendingRequest) {
    return "deferred";
  }

  const mentionRoleIds = input.channelContext.allowedRoleIds.filter(
    (roleId) => roleId.trim().length > 0,
  );

  if (
    input.channelContext.discordDeliveryMode !== "thread" ||
    mentionRoleIds.length === 0 ||
    !input.message.guild?.sendTextMessage
  ) {
    return "unavailable";
  }

  const pendingRequestCount = input.pendingRequestCount ?? 0;
  const resultLabel = input.failed
    ? "작업 실패"
    : input.intermediate
      ? "중간 답변"
      : "작업 완료";
  const completionText = `**${input.agentLabel} ${resultLabel}**${
    pendingRequestCount > 0 ? ` — 대기열 ${pendingRequestCount}개를 이어서 진행합니다` : ""
  }`;

  try {
    await input.message.guild.sendTextMessage(
      input.message.channelId,
      completionText,
      { mentionRoleIds },
    );
    return "sent";
  } catch (error) {
    console.error("discord-bot failed to send thread completion mention", error);
    return "unavailable";
  }
}

async function sendAgentRelayCallback(input: {
  message: DiscordMessageLike;
  relayControlChannelId?: string | null;
  agentLabel: "Codex" | "Claude Code";
  response: { result?: unknown; error?: { message: string } };
  resultPayload: DiscordMessagePayload;
}): Promise<void> {
  const requestMessageId = input.message.messageId?.trim();
  const controlChannelId = input.relayControlChannelId?.trim();

  if (!input.message.relayRequest || !requestMessageId || !controlChannelId || !input.message.guild?.sendTextMessage) {
    return;
  }

  const failed = promptResponseFailed(input.response);
  const finalMessage = extractAgentResponseFinalMessage(input.response) ?? input.response.error?.message ?? "";
  const callbackMessages = buildAgentRelayCallbackMessages({
    requestMessageId,
    sourceThreadId: input.message.channelId,
    agentLabel: input.agentLabel,
    status: failed ? "failed" : "completed",
    finalMessage,
    errorMessage: failed ? finalMessage || "Agent relay turn failed." : null,
    files: collectAgentResultFiles(input.resultPayload),
  });

  try {
    for (const callbackMessage of callbackMessages) {
      await input.message.guild.sendTextMessage(controlChannelId, callbackMessage);
    }
  } catch (error) {
    console.error(`discord-bot failed to send ${input.agentLabel} relay callback`, error);
  }
}

function appendProgressEvent(events: string[], event: string): string[] {
  const normalizedEvent = event.trim();

  if (!normalizedEvent || events.at(-1) === normalizedEvent) {
    return events;
  }

  return [...events, normalizedEvent].slice(-AGENT_PROGRESS_EVENT_LIMIT);
}

function extractAgentResponseSessionId(response: { result?: unknown; error?: unknown }): string | null {
  return "result" in response &&
    typeof response.result === "object" &&
    response.result !== null &&
    typeof (response.result as { sessionId?: unknown }).sessionId === "string"
    ? (response.result as { sessionId: string }).sessionId
    : null;
}

function bindChannelSessionId(input: {
  agentLabel: "Codex" | "Claude Code";
  channelId: string;
  currentSessionId: string | null;
  candidateSessionId: string;
}): string {
  const currentSessionId = input.currentSessionId?.trim() || null;
  const candidateSessionId = input.candidateSessionId.trim();

  if (!candidateSessionId) {
    throw new Error(`${input.agentLabel} returned an empty session ID.`);
  }

  if (
    currentSessionId &&
    currentSessionId.toLowerCase() !== candidateSessionId.toLowerCase()
  ) {
    throw new Error(
      `${input.agentLabel} session isolation blocked a response for ${candidateSessionId}; ` +
      `Discord channel ${input.channelId} is bound to ${currentSessionId}.`,
    );
  }

  return currentSessionId ?? candidateSessionId;
}

function extractAgentResponseFinalMessage(response: { result?: unknown; error?: unknown }): string | null {
  return "result" in response &&
    typeof response.result === "object" &&
    response.result !== null &&
    typeof (response.result as { finalMessage?: unknown }).finalMessage === "string"
    ? (response.result as { finalMessage: string }).finalMessage
    : null;
}

function withAgentFinalMessage<T extends { result?: unknown; error?: unknown }>(
  response: T,
  finalMessage: string,
): T {
  if (response.error || typeof response.result !== "object" || response.result === null) {
    return response;
  }

  return {
    ...response,
    result: {
      ...response.result,
      finalMessage,
    },
  };
}

function forkResponseErrorMessage(
  response: { result?: unknown; error?: unknown },
  agentLabel: "Codex" | "Claude Code",
): string | null {
  if (!promptResponseFailed(response)) {
    return null;
  }

  if (typeof response.error === "object" && response.error !== null) {
    const message = (response.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  if (typeof response.result === "object" && response.result !== null) {
    const result = response.result as { finalMessage?: unknown; stderr?: unknown };
    const message = [result.finalMessage, result.stderr].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (message) {
      return message.trim();
    }
  }

  return `${agentLabel} fork 실행이 실패했습니다.`;
}

function withAgentMessageFallback<T extends { result?: unknown; error?: unknown }>(
  response: T,
  latestAgentMessage: string | null,
): T {
  const fallback = latestAgentMessage?.trim();

  if (!fallback || response.error || typeof response.result !== "object" || response.result === null) {
    return response;
  }

  const finalMessage = (response.result as { finalMessage?: unknown }).finalMessage;

  if (typeof finalMessage === "string" && finalMessage.trim().length > 0) {
    return response;
  }

  return {
    ...response,
    result: {
      ...response.result,
      finalMessage: fallback,
    },
  };
}

function withCodexGoalStatus<T extends { result?: unknown; error?: unknown }>(
  response: T,
  goalStatus: string | null,
): T {
  if (!goalStatus || response.error || typeof response.result !== "object" || response.result === null) {
    return response;
  }

  const existingGoalStatus = (response.result as { goalStatus?: unknown }).goalStatus;
  if (typeof existingGoalStatus === "string" && existingGoalStatus.length > 0) {
    return response;
  }

  return {
    ...response,
    result: {
      ...response.result,
      goalStatus,
    },
  };
}

function claudeForkPrompt(name: string): string {
  return [
    `이 세션은 Discord /fork 명령으로 "${name}" 이름의 새 스레드에 분기되었습니다.`,
    "기존 대화 맥락은 유지하되 아직 새 작업은 시작하지 마세요.",
    "새 fork 세션이 준비되었다고 한 문장으로만 답하세요.",
  ].join("\n");
}

function codexForkPrompt(name: string): string {
  return [
    `이 세션은 Discord /fork 명령으로 "${name}" 이름의 새 스레드에 분기되었습니다.`,
    "기존 대화 맥락은 유지하되 아직 새 작업은 시작하지 마세요.",
    "새 fork 세션이 준비되었다고 한 문장으로만 답하세요.",
  ].join("\n");
}

function readableProgressEvent(event: {
  type: string;
  label?: string;
  detail?: string;
  text?: string;
  eventType?: string;
}): string {
  if (event.type === "agent-message" && event.text) {
    return event.text;
  }

  if (event.type === "agent-thought" && event.text) {
    return `생각: ${event.text}`;
  }

  if (event.type !== "operation-progress") {
    return event.eventType ?? event.type;
  }

  if (event.detail?.startsWith("편집함 ")) {
    return event.detail;
  }

  const fileCount = event.detail?.match(/(\d+)개 파일/)?.[1];

  if (event.label === "파일 탐색 중" && fileCount) {
    return `${fileCount}개의 파일 탐색중...`;
  }

  if (event.label === "탐색마침") {
    return "탐색마침";
  }

  if (event.label === "파일 수정 중") {
    return event.detail ? `편집중 · ${event.detail}` : "편집중...";
  }

  if (event.label === "파일 수정 완료") {
    return event.detail ?? "편집함";
  }

  return event.detail ? `${event.label ?? "작업 중"} · ${event.detail}` : (event.label ?? "작업 중");
}

const LIVE_PROGRESS_CHUNK_LENGTH = 1_800;
const MAX_LIVE_PROGRESS_MESSAGES_PER_TASK = (() => {
  const parsed = Number.parseInt(process.env.CONNECT_LIVE_PROGRESS_MAX_MESSAGES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
})();

function parseCodexApprovalResponse(content: string): {
  token: string;
  decision: CodexPromptApprovalDecision["decision"];
} | null {
  const match = content.trim().match(/^__cdc_codex_approval\s+([A-Za-z0-9_-]{1,48})\s+(accept|acceptForSession|decline|cancel)$/);

  if (!match) {
    return null;
  }

  return {
    token: match[1] ?? "",
    decision: (match[2] ?? "decline") as CodexPromptApprovalDecision["decision"],
  };
}

function parseCodexUserInputSelection(content: string): { token: string; answers: string[] } | null {
  const match = content.trim().match(/^__cdc_codex_user_input\s+([A-Za-z0-9_-]{1,48})\s+(\S+)$/);

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(match[2] ?? "")) as unknown;
    const answers = Array.isArray(parsed)
      ? parsed.filter((answer): answer is string => typeof answer === "string" && answer.trim().length > 0)
          .map((answer) => answer.trim())
          .slice(0, 25)
      : [];
    return answers.length > 0 ? { token: match[1] ?? "", answers } : null;
  } catch {
    return null;
  }
}

function hasAllowedRole(userRoleIds: string[], allowedRoleIds: string[]): boolean {
  if (allowedRoleIds.length === 0) {
    return true;
  }

  const userRoles = new Set(userRoleIds);
  return allowedRoleIds.some((roleId) => userRoles.has(roleId));
}

function codexPermissionSettings(): CodexPermissionSettings {
  const approvalPolicy = process.env.CODEX_DISCORD_CODEX_APPROVAL_POLICY?.trim() || "never";
  const configuredSandbox = process.env.CODEX_DISCORD_CODEX_SANDBOX?.trim();
  const sandbox =
    configuredSandbox === "read-only" ||
    configuredSandbox === "workspace-write" ||
    configuredSandbox === "danger-full-access"
      ? configuredSandbox
      : "danger-full-access";

  return {
    approvalPolicy,
    approvalsReviewer: "user",
    sandbox,
    networkAccess: "enabled",
  };
}

function relayWaitingMessage(locale: ConnectorLocale | undefined, activeThreadId: string): string {
  switch (locale) {
    case "en":
      return `This agent is waiting for the other agent's answer. To intervene, send your message in the active thread <#${activeThreadId}>.`;
    case "zh":
      return `此 agent 正在等待另一方的回答。如需介入，请在当前活动线程 <#${activeThreadId}> 中发送消息。`;
    case "ja":
      return `この agent は相手の回答を待っています。介入する場合は、現在実行中のスレッド <#${activeThreadId}> でメッセージを送ってください。`;
    default:
      return `이 agent는 현재 상대 agent의 답변을 기다리고 있습니다. 대화에 개입하려면 실행 중인 스레드 <#${activeThreadId}>에서 메시지를 보내세요.`;
  }
}

export function createDiscordMessageHandler(input: CreateDiscordMessageHandlerInput): DiscordMessageHandler {
  interface QueuedMessage {
    message: DiscordMessageLike;
    resolve(): void;
    reject(error: unknown): void;
  }

  interface ChannelQueue {
    running: boolean;
    activeMessage: DiscordMessageLike | null;
    activeStartedAt: number | null;
    activeLastActivityAt: number | null;
    pending: QueuedMessage[];
  }

  const channelQueues = new Map<string, ChannelQueue>();
  const codexSessionIdsByChannel = new Map<string, string>();
  const claudeSessionIdsByChannel = new Map<string, string>();
  const agentSettingsController = createAgentSettingsController({
    updateDefaults: input.updateAgentDefaults,
    updateSession: input.updateSessionAgentSettings,
  });
  const harnessValidationRetryAttempts = input.harnessValidationRetryAttempts === undefined
    ? resolveHarnessValidationRetryAttempts()
    : resolveHarnessValidationRetryAttempts(String(input.harnessValidationRetryAttempts));
  let deferredRestartRequested = false;
  let restartScheduled = false;
  let deferredRestartCheckRunning = false;
  let deferredRestartNotice: {
    channelId: string;
    guild?: DiscordGuildSurface | null;
    reply: DiscordMessageLike["reply"];
  } | null = null;
  const pendingCodexApprovals = new Map<
    string,
    {
      channelId: string;
      resolve: (decision: CodexPromptApprovalDecision) => void;
    }
  >();
  let nextCodexApprovalToken = 1;
  const pendingCodexUserInputs = new Map<
    string,
    {
      token: string;
      question: CodexPromptUserInputRequest["questions"][number];
      resolve: (answers: string[]) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  let nextCodexUserInputToken = 1;

  function executionState(excludeActiveMessage?: DiscordMessageLike): BotReloadExecutionState {
    let activeCount = 0;
    let pendingCount = 0;

    for (const queue of channelQueues.values()) {
      if (queue.activeMessage && queue.activeMessage !== excludeActiveMessage) {
        activeCount += 1;
      }

      pendingCount += queue.pending.length;
    }

    return { activeCount, pendingCount };
  }

  async function sendDeferredRestartNotice(payload: DiscordMessagePayload): Promise<void> {
    const notice = deferredRestartNotice;

    if (!notice) {
      return;
    }

    if (notice.guild?.sendTextMessage) {
      await notice.guild.sendTextMessage(notice.channelId, payload);
      return;
    }

    await notice.reply(payload);
  }

  async function restartAfterQueueDrain(): Promise<void> {
    if (
      !deferredRestartRequested ||
      restartScheduled ||
      deferredRestartCheckRunning ||
      !input.reloadBot
    ) {
      return;
    }

    const execution = executionState();

    if (execution.activeCount > 0 || execution.pendingCount > 0) {
      return;
    }

    deferredRestartCheckRunning = true;
    restartScheduled = true;

    try {
      const result = await input.reloadBot({ mode: "restart", execution, force: false });
      await sendDeferredRestartNotice(formatReloadResult({ result }));
    } catch (error) {
      restartScheduled = false;
      deferredRestartRequested = false;
      await sendDeferredRestartNotice(formatReloadResult({
        error: { message: error instanceof Error ? error.message : "Deferred bot restart failed" },
      }));
    } finally {
      deferredRestartCheckRunning = false;
    }
  }

  function touchChannelActivity(channelId: string): void {
    const queue = channelQueues.get(channelId);

    if (queue?.activeMessage) {
      queue.activeLastActivityAt = Date.now();
    }
  }

  async function completeDurableMessage(message: DiscordMessageLike): Promise<void> {
    if (!message.requestId || !input.completeDurableRequest) {
      return;
    }

    try {
      await input.completeDurableRequest(message.requestId);
    } catch (error) {
      console.error(`discord-bot failed to complete durable request ${message.requestId}`, error);
    }
  }

  async function cancelRelayRequest(message: DiscordMessageLike): Promise<void> {
    const requestMessageId = message.relayCancelRequestId;
    if (!requestMessageId) {
      return;
    }
    const queue = channelQueues.get(message.channelId);
    if (!queue) {
      return;
    }

    const removed = queue.pending.filter(
      (entry) => entry.message.relayRequest && entry.message.messageId === requestMessageId,
    );
    queue.pending = queue.pending.filter((entry) => !removed.includes(entry));
    for (const entry of removed) {
      await completeDurableMessage(entry.message);
      entry.resolve();
    }

    const active = queue.activeMessage;
    if (
      !active?.relayRequest ||
      active.messageId !== requestMessageId ||
      !input.controlCodexTurn
    ) {
      return;
    }

    const channelContext = await input.resolveChannelContext(message.channelId);
    if (!channelContext) {
      return;
    }
    const result = await input.controlCodexTurn({
      computerId: channelContext.computerId,
      controlKey: message.channelId,
      action: "interrupt",
    });
    if (result.status === "failed" || result.status === "unsupported") {
      console.warn(
        `discord-bot failed to interrupt relay request ${requestMessageId}: ${result.message}`,
      );
    }
    const pending = pendingCodexUserInputs.get(message.channelId);
    if (pending) {
      pendingCodexUserInputs.delete(message.channelId);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve([]);
    }
  }

  function channelWaitingForApproval(channelId: string): boolean {
    return [...pendingCodexApprovals.values()].some((approval) => approval.channelId === channelId);
  }

  function channelWaitingForUserInput(channelId: string): boolean {
    return pendingCodexUserInputs.has(channelId);
  }

  function channelPendingAgentRequestCount(
    channelId: string,
    channelContext: ManagedDiscordChannelContext,
  ): number {
    return channelQueues.get(channelId)?.pending.filter((entry) => {
      const routed = routeDiscordMessage({
        channelMode: channelContext.channelMode,
        agentMain: channelContext.agentMain,
        content: entry.message.content,
        userRoleIds: entry.message.roleIds,
        allowedRoleIds: channelContext.allowedRoleIds,
        locale: input.locale,
      });

      return routed.type === "codex-chat" ||
        routed.type === "codex-continue-session" ||
        routed.type === "claude-chat" ||
        routed.type === "codex-review" ||
        routed.type === "fork-session";
    }).length ?? 0;
  }

  function routeMessage(
    message: DiscordMessageLike,
    channelContext: ManagedDiscordChannelContext,
  ) {
    return routeDiscordMessage({
      channelMode: channelContext.channelMode,
      agentMain: channelContext.agentMain,
      content: message.content,
      userRoleIds: message.roleIds,
      allowedRoleIds: channelContext.allowedRoleIds,
      locale: input.locale,
    });
  }

  function harnessProvider(channelContext: ManagedDiscordChannelContext): HarnessProvider | null {
    if (channelContext.channelMode === "claude-code" || channelContext.agentMain === "claude") {
      return "claude";
    }
    if (channelContext.channelMode === "session-linked" || channelContext.agentMain === "codex") {
      return "codex";
    }
    return null;
  }

  function channelAgentSessionId(
    channelId: string,
    channelContext: ManagedDiscordChannelContext,
    provider: HarnessProvider,
  ): string | null {
    return provider === "claude"
      ? claudeSessionIdsByChannel.get(channelId) ?? channelContext.claudeSessionId ?? null
      : codexSessionIdsByChannel.get(channelId) ?? channelContext.codexSessionId ?? null;
  }

  async function prepareHarnessBuilderResponse<T extends { result?: unknown; error?: unknown }>(
    build: HarnessBuildState,
    response: T,
    options: { retrying?: boolean } = {},
  ): Promise<{ response: T; notice: string | null; validationErrors: string[] }> {
    const finalMessage = extractAgentResponseFinalMessage(response);
    if (!finalMessage) {
      const error = "Builder 응답에 최종 메시지가 없어 설계 상태를 읽을 수 없습니다.";
      return { response, notice: `⚠️ ${error}`, validationErrors: [error] };
    }
    const interviewExtraction = extractHarnessInterviewBrief(finalMessage);
    const candidateExtraction = extractHarnessCandidate(finalMessage);
    const notices: string[] = [];
    const validationErrors: string[] = [];
    let acceptedInterviewDigest: string | null = null;
    let acceptedBuild: HarnessBuildState | null = null;

    if (interviewExtraction.error) {
      await input.harnessStore?.recordInterviewError(build.buildId, interviewExtraction.error);
      notices.push(`⚠️ 설계 브리프 검증 실패:\n${interviewExtraction.error}`);
      validationErrors.push(interviewExtraction.error);
    } else if (!interviewExtraction.brief) {
      const error = "Builder 응답에 필수 설계 브리프가 없습니다. 대화 내용은 보이지만 설계 단계에는 반영하지 않았습니다.";
      await input.harnessStore?.recordInterviewError(build.buildId, error);
      notices.push(`⚠️ ${error}`);
      validationErrors.push(error);
    } else {
      try {
        const currentBuild = options.retrying
          ? await input.harnessStore?.buildForChannel(build.builderDiscordChannelId)
          : null;
        const isRetryOfAcceptedBrief = currentBuild?.interviewBrief?.digest === interviewExtraction.brief.digest &&
          currentBuild.interviewPhase === interviewExtraction.brief.phase;
        const updated = await input.harnessStore?.recordInterview(
          build.buildId,
          interviewExtraction.brief,
          isRetryOfAcceptedBrief ? { countTurn: false } : undefined,
        );
        acceptedBuild = updated ?? null;
        acceptedInterviewDigest = updated?.interviewBrief?.digest ?? interviewExtraction.brief.digest;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await input.harnessStore?.recordInterviewError(build.buildId, message);
        notices.push(`⚠️ 설계 단계 검증 실패:\n${message}`);
        validationErrors.push(message);
      }
    }

    if (candidateExtraction.error) {
      await input.harnessStore?.recordCandidateError(build.buildId, candidateExtraction.error);
      notices.push(`⚠️ 하네스 후보 검증 실패:\n${candidateExtraction.error}`);
      validationErrors.push(candidateExtraction.error);
    } else if (candidateExtraction.candidate) {
      if (!acceptedInterviewDigest) {
        const error = "같은 응답의 확인된 ready 설계 브리프 없이는 하네스 후보를 저장할 수 없습니다.";
        await input.harnessStore?.recordCandidateError(build.buildId, error);
        notices.push(`⚠️ ${error}`);
        validationErrors.push(error);
      } else {
        try {
          const saved = await input.harnessStore?.saveCandidate(
            build.buildId,
            candidateExtraction.candidate,
            acceptedInterviewDigest,
          );
          if (saved) {
            notices.push(formatHarnessCandidateSaved(saved));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await input.harnessStore?.recordCandidateError(build.buildId, message);
          notices.push(`⚠️ 하네스 후보 저장 거부:\n${message}`);
          validationErrors.push(message);
        }
      }
    } else if (interviewExtraction.brief?.phase === "ready" && acceptedInterviewDigest) {
      const error = "ready 설계 브리프와 함께 최종 하네스 후보가 출력되지 않았습니다.";
      await input.harnessStore?.recordCandidateError(build.buildId, error);
      notices.push(`⚠️ ${error}`);
      validationErrors.push(error);
    }

    if (acceptedBuild) {
      const latestBuild = await input.harnessStore?.buildForChannel(build.builderDiscordChannelId) ?? acceptedBuild;
      notices.unshift(formatHarnessInterviewProgress(latestBuild));
    }

    const visible = stripHarnessBuilderBlocks(finalMessage) || "Harness Builder가 설계 상태를 갱신했습니다.";
    return {
      response: withAgentFinalMessage(response, visible),
      notice: notices.length > 0 ? notices.join("\n\n") : null,
      validationErrors,
    };
  }

  async function prepareHarnessBuilderResponseWithRetries(inputRepair: {
    build: HarnessBuildState;
    response: ControlApiJobResponse;
    provider: HarnessProvider;
    channelContext: ManagedDiscordChannelContext;
    settingsChannelId: string;
    queueKey: string;
    workspaceRoot: string;
    cwd: string;
    sessionId: string | null;
    sessionName?: string | null;
  }): Promise<{ response: ControlApiJobResponse; notice: string | null }> {
    let currentBuild = inputRepair.build;
    let currentResponse = inputRepair.response;
    let prepared = await prepareHarnessBuilderResponse(currentBuild, currentResponse);
    let retryCount = 0;

    while (
      prepared.validationErrors.length > 0 &&
      retryCount < harnessValidationRetryAttempts &&
      inputRepair.sessionId &&
      !promptResponseFailed(currentResponse)
    ) {
      retryCount += 1;
      currentBuild = await input.harnessStore?.buildForChannel(currentBuild.builderDiscordChannelId) ?? currentBuild;
      const repairPrompt = harnessBuilderRepairPrompt({
        build: currentBuild,
        errors: prepared.validationErrors,
        attempt: retryCount,
        maxAttempts: harnessValidationRetryAttempts,
      });
      const settings = agentSettingsController.get(inputRepair.settingsChannelId, inputRepair.channelContext);

      try {
        currentResponse = inputRepair.provider === "claude"
          ? await input.submitClaudePrompt!({
            computerId: inputRepair.channelContext.computerId,
            queueKey: inputRepair.queueKey,
            payload: {
              workspaceRoot: inputRepair.workspaceRoot,
              cwd: inputRepair.cwd,
              prompt: repairPrompt,
              timeoutMs: resolveAgentPromptTimeoutMs(inputRepair.channelContext.timeoutMs),
              controlKey: inputRepair.queueKey,
              sessionId: inputRepair.sessionId,
              forkSession: false,
              sessionName: inputRepair.sessionName,
              model: settings.model,
              effort: settings.effort,
              harnessBuilder: true,
            },
          })
          : await input.submitCodexPrompt!({
            computerId: inputRepair.channelContext.computerId,
            queueKey: inputRepair.queueKey,
            payload: {
              workspaceRoot: inputRepair.workspaceRoot,
              cwd: inputRepair.cwd,
              prompt: repairPrompt,
              timeoutMs: resolveAgentPromptTimeoutMs(inputRepair.channelContext.timeoutMs),
              controlKey: inputRepair.queueKey,
              sessionId: inputRepair.sessionId,
              forkSession: false,
              sessionName: inputRepair.sessionName,
              model: settings.model,
              reasoningEffort: agentSettingsController.codexReasoningEffort(
                inputRepair.settingsChannelId,
                inputRepair.channelContext,
              ),
              harnessBuilder: true,
            },
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          response: prepared.response,
          notice: [
            prepared.notice,
            `⚠️ Builder 형식 자동 복구 ${retryCount}/${harnessValidationRetryAttempts}회차 요청이 실패했습니다:\n${message}`,
            "Builder 상태는 유지했습니다. 이 스레드에서 메시지를 보내면 같은 설계를 이어갑니다.",
          ].filter(Boolean).join("\n\n"),
        };
      }

      const repairFailure = forkResponseErrorMessage(
        currentResponse,
        inputRepair.provider === "claude" ? "Claude Code" : "Codex",
      );
      if (repairFailure) {
        return {
          response: prepared.response,
          notice: [
            prepared.notice,
            `⚠️ Builder 형식 자동 복구 ${retryCount}/${harnessValidationRetryAttempts}회차가 실패했습니다:\n${repairFailure}`,
            "Builder 상태는 유지했습니다. 이 스레드에서 메시지를 보내면 같은 설계를 이어갑니다.",
          ].filter(Boolean).join("\n\n"),
        };
      }

      const repairSessionId = extractAgentResponseSessionId(currentResponse);
      if (
        repairSessionId &&
        repairSessionId.toLowerCase() !== inputRepair.sessionId.toLowerCase()
      ) {
        return {
          response: prepared.response,
          notice: [
            prepared.notice,
            "⚠️ Builder 형식 자동 복구가 다른 agent session을 반환해 안전하게 중단했습니다.",
            "Builder 상태는 유지했습니다. 이 스레드에서 메시지를 보내면 원래 세션으로 이어갑니다.",
          ].filter(Boolean).join("\n\n"),
        };
      }

      currentBuild = await input.harnessStore?.buildForChannel(currentBuild.builderDiscordChannelId) ?? currentBuild;
      prepared = await prepareHarnessBuilderResponse(currentBuild, currentResponse, { retrying: true });
    }

    if (prepared.validationErrors.length === 0) {
      return {
        response: prepared.response,
        notice: [
          retryCount > 0
            ? `🔧 Builder 출력 형식 오류를 같은 세션에서 자동으로 ${retryCount}회 수정해 복구했습니다.`
            : null,
          prepared.notice,
        ].filter(Boolean).join("\n\n") || null,
      };
    }

    const retrySummary = harnessValidationRetryAttempts === 0
      ? "Builder 출력 형식 자동 복구가 비활성화되어 있습니다."
      : inputRepair.sessionId
        ? `Builder 출력 형식 자동 복구를 ${retryCount}회 시도했지만 검증을 통과하지 못했습니다.`
        : "Builder agent session ID가 없어 출력 형식 자동 복구를 시작할 수 없었습니다.";
    return {
      response: prepared.response,
      notice: [
        prepared.notice,
        `⚠️ ${retrySummary}`,
        "Builder 상태는 유지했습니다. 이 스레드에서 메시지를 보내면 같은 설계를 이어갑니다.",
      ].filter(Boolean).join("\n\n"),
    };
  }

  async function submitProvisionedHarnessTurn(inputTurn: {
    provider: HarnessProvider;
    thread: NewCodexChatResult;
    guild: DiscordGuildSurface;
    settingsChannelId: string;
    sourceSessionId: string | null;
    forkSession: boolean;
    sourceContext: ManagedDiscordChannelContext;
    build?: HarnessBuildState;
    run?: HarnessRunState;
    runProgressReporter?: HarnessRunProgressReporter;
    userPrompt: string;
    reply: DiscordMessageLike["reply"];
    replyWithRoleMentions: DiscordMessageLike["reply"];
  }): Promise<{
    sessionId: string;
    visibleMessage: string;
    candidateNotice: string | null;
  }> {
    const settings = agentSettingsController.get(
      inputTurn.settingsChannelId,
      inputTurn.sourceContext,
    );
    const threadReply: DiscordMessageLike["reply"] = async (payload) => {
      if (!inputTurn.guild.sendTextMessage) {
        return inputTurn.reply(payload);
      }
      const sent = await inputTurn.guild.sendTextMessage(inputTurn.thread.discordChannelId, payload);
      if (!sent?.id || !inputTurn.guild.editTextMessage) {
        return;
      }
      return {
        edit: (editedPayload) =>
          inputTurn.guild.editTextMessage!(inputTurn.thread.discordChannelId, sent.id!, editedPayload),
      };
    };
    const threadReplyWithRoleMentions: DiscordMessageLike["reply"] = async (payload) => {
      if (!inputTurn.guild.sendTextMessage) {
        return inputTurn.replyWithRoleMentions(payload);
      }
      const sent = await inputTurn.guild.sendTextMessage(
        inputTurn.thread.discordChannelId,
        typeof payload === "string"
          ? withRoleMentions(payload, inputTurn.sourceContext.allowedRoleIds)
          : payload,
        { mentionRoleIds: inputTurn.sourceContext.allowedRoleIds },
      );
      if (!sent?.id || !inputTurn.guild.editTextMessage) {
        return;
      }
      return {
        edit: (editedPayload) =>
          inputTurn.guild.editTextMessage!(inputTurn.thread.discordChannelId, sent.id!, editedPayload),
      };
    };
    const prompt = inputTurn.build
      ? harnessBuilderPrompt({ build: inputTurn.build, userMessage: inputTurn.userPrompt, initial: true })
      : harnessExecutionPrompt({ run: inputTurn.run!, userMessage: inputTurn.userPrompt, initial: true });
    let response: ControlApiJobResponse;
    let streamedSessionId: string | null = null;

    if (inputTurn.run) {
      await input.harnessStore?.markRunStatus(inputTurn.run.runId, "running");
    }

    const handleProgress = async (event: AgentPromptProgressEvent) => {
      if (event.type === "thread-started") {
        streamedSessionId = event.sessionId;
        if (inputTurn.run) {
          await input.harnessStore?.bindRunSession(inputTurn.run.runId, event.sessionId);
          await input.harnessStore?.markRunStatus(inputTurn.run.runId, "running");
        }
        if (inputTurn.provider === "codex") {
          await input.markDiscordRequestedCodexSession?.(event.sessionId, {
            discordChannelId: inputTurn.thread.discordChannelId,
          });
        }
      }
      await inputTurn.runProgressReporter?.publish(event);
    };

    if (inputTurn.provider === "claude") {
      if (!input.submitClaudePrompt) {
        throw new Error("Claude Code is not connected for this bot mode.");
      }
      response = await input.submitClaudePrompt({
        computerId: inputTurn.sourceContext.computerId,
        ...(inputTurn.run?.workerJobId ? { requestId: inputTurn.run.workerJobId } : {}),
        queueKey: inputTurn.thread.discordChannelId,
        payload: {
          workspaceRoot: inputTurn.thread.workspaceRoot,
          cwd: inputTurn.thread.cwd,
          prompt,
          timeoutMs: resolveAgentPromptTimeoutMs(inputTurn.sourceContext.timeoutMs),
          controlKey: inputTurn.thread.discordChannelId,
          sessionId: inputTurn.sourceSessionId,
          forkSession: inputTurn.forkSession,
          sessionName: inputTurn.thread.threadName,
          model: settings.model,
          effort: settings.effort,
          harnessBuilder: Boolean(inputTurn.build),
          ...(inputTurn.run ? { harness: input.harnessStore?.workerBinding(inputTurn.run) } : {}),
        },
        onProgress: handleProgress,
      });
    } else {
      if (!input.submitCodexPrompt) {
        throw new Error("Codex is not connected for this bot mode.");
      }
      response = await input.submitCodexPrompt({
        computerId: inputTurn.sourceContext.computerId,
        ...(inputTurn.run?.workerJobId ? { requestId: inputTurn.run.workerJobId } : {}),
        queueKey: inputTurn.thread.discordChannelId,
        payload: {
          workspaceRoot: inputTurn.thread.workspaceRoot,
          cwd: inputTurn.thread.cwd,
          prompt,
          timeoutMs: resolveAgentPromptTimeoutMs(inputTurn.sourceContext.timeoutMs),
          controlKey: inputTurn.thread.discordChannelId,
          sessionId: inputTurn.sourceSessionId,
          forkSession: inputTurn.forkSession,
          sessionName: inputTurn.thread.threadName,
          model: settings.model,
          reasoningEffort: agentSettingsController.codexReasoningEffort(
            inputTurn.settingsChannelId,
            inputTurn.sourceContext,
          ),
          harnessBuilder: Boolean(inputTurn.build),
          ...(inputTurn.run ? { harness: input.harnessStore?.workerBinding(inputTurn.run) } : {}),
        },
        onProgress: handleProgress,
        onApprovalRequest: (request) =>
          requestCodexApproval(threadReplyWithRoleMentions, inputTurn.thread.discordChannelId, request),
        onUserInputRequest: (request) =>
          requestCodexUserInput(
            threadReply,
            threadReplyWithRoleMentions,
            inputTurn.thread.discordChannelId,
            request,
          ),
      });
    }

    const failure = forkResponseErrorMessage(response, inputTurn.provider === "claude" ? "Claude Code" : "Codex");
    if (failure) {
      throw new Error(failure);
    }
    const sessionId = extractAgentResponseSessionId(response) ?? streamedSessionId;
    if (!sessionId) {
      throw new Error("Harness session provisioning did not return an agent session ID.");
    }
    if (
      inputTurn.forkSession &&
      inputTurn.sourceSessionId &&
      sessionId.toLowerCase() === inputTurn.sourceSessionId.toLowerCase()
    ) {
      throw new Error("Harness fork returned the original agent session ID.");
    }

    if (inputTurn.provider === "claude") {
      if (!input.recordClaudeSession) {
        throw new Error("Claude Code session persistence is not connected.");
      }
      await input.recordClaudeSession({
        discordChannelId: inputTurn.thread.discordChannelId,
        claudeSessionId: sessionId,
      });
      claudeSessionIdsByChannel.set(inputTurn.thread.discordChannelId, sessionId);
    } else {
      if (!input.linkNewCodexSession) {
        throw new Error("Codex session persistence is not connected.");
      }
      await input.linkNewCodexSession({
        discordChannelId: inputTurn.thread.discordChannelId,
        codexSessionId: sessionId,
        threadName: inputTurn.thread.threadName,
      });
      codexSessionIdsByChannel.set(inputTurn.thread.discordChannelId, sessionId);
    }

    if (inputTurn.build) {
      await input.harnessStore?.bindBuilderSession(inputTurn.build.buildId, sessionId);
    }
    if (inputTurn.run) {
      await input.harnessStore?.bindRunSession(inputTurn.run.runId, sessionId);
    }

    let candidateNotice: string | null = null;
    if (inputTurn.build) {
      const prepared = await prepareHarnessBuilderResponseWithRetries({
        build: inputTurn.build,
        response,
        provider: inputTurn.provider,
        channelContext: inputTurn.sourceContext,
        settingsChannelId: inputTurn.settingsChannelId,
        queueKey: inputTurn.thread.discordChannelId,
        workspaceRoot: inputTurn.thread.workspaceRoot,
        cwd: inputTurn.thread.cwd,
        sessionId,
        sessionName: inputTurn.thread.threadName,
      });
      response = prepared.response;
      candidateNotice = prepared.notice;
    }
    const finalMessage = extractAgentResponseFinalMessage(response)?.trim() ?? "";

    return {
      sessionId,
      visibleMessage: stripHarnessBuilderBlocks(finalMessage) ||
        (inputTurn.build ? "Harness Builder가 준비되었습니다. 이어서 원하는 workflow를 설명해 주세요." : "하네스가 준비되었습니다."),
      candidateNotice,
    };
  }

  async function createHarnessSessionThread(inputCreate: {
    message: DiscordMessageLike;
    context: ManagedDiscordChannelContext;
    sourceMode: HarnessSourceMode;
    sourceChannelId: string;
    sourceSessionId: string | null;
    name: string;
  }): Promise<NewCodexChatResult> {
    if (!inputCreate.message.guild) {
      throw new Error("Discord guild context is required for harness sessions.");
    }
    if (inputCreate.sourceMode === "current") {
      if (!inputCreate.sourceSessionId) {
        throw new Error("현재 Discord 스레드에 연결된 agent session ID가 없습니다.");
      }
      if (!input.createForkedSessionThread) {
        throw new Error("Harness session fork is supported only in direct mode.");
      }
      return input.createForkedSessionThread({
        guild: inputCreate.message.guild,
        sourceDiscordChannelId: inputCreate.sourceChannelId,
        sourceSessionId: inputCreate.sourceSessionId,
        name: inputCreate.name,
      });
    }

    if (!input.createNewCodexChat) {
      throw new Error("Fresh harness session creation is supported only in direct mode.");
    }
    return input.createNewCodexChat({
      guild: inputCreate.message.guild,
      name: inputCreate.name,
      cwd: ".",
      currentCwd: inputCreate.context.cwd,
      useCategory: true,
      initialPrompt: null,
      channelMode: inputCreate.context.channelMode === "claude-code" ? "claude-code" : "session-linked",
      sessionThreadParentChannelId:
        inputCreate.context.discordDeliveryMode === "thread"
          ? inputCreate.context.discordParentChannelId ?? null
          : inputCreate.sourceChannelId,
    });
  }

  async function startPublishedHarnessRun(inputRun: {
    message: DiscordMessageLike;
    invocationContext: ManagedDiscordChannelContext;
    published: PublishedHarnessVersionState;
    sourceMode: HarnessSourceMode;
    sourceChannelId?: string | null;
    sourceSessionId?: string | null;
    name?: string | null;
    prompt?: string | null;
    reply: DiscordMessageLike["reply"];
    replyWithRoleMentions: DiscordMessageLike["reply"];
  }): Promise<HarnessRunState> {
    if (!input.harnessStore) {
      throw new Error("Harness is unavailable in this bot mode.");
    }
    const sourceChannelId = inputRun.sourceChannelId ?? inputRun.message.channelId;
    const sourceContext = sourceChannelId === inputRun.message.channelId
      ? inputRun.invocationContext
      : await input.resolveChannelContext(sourceChannelId);
    if (!sourceContext) {
      throw new Error("Harness run source Discord session no longer exists.");
    }
    const provider = harnessProvider(sourceContext);
    if (!provider) {
      throw new Error("Harness는 Codex 또는 Claude Code 채널에서만 실행할 수 있습니다.");
    }
    if (!inputRun.published.manifest.providers.includes(provider)) {
      throw new Error(`${inputRun.published.harnessVersionId}은 ${provider} provider를 지원하지 않습니다.`);
    }
    const currentSourceSessionId = inputRun.sourceMode === "current"
      ? channelAgentSessionId(sourceChannelId, sourceContext, provider)
      : null;
    if (
      inputRun.sourceMode === "current" &&
      inputRun.sourceSessionId &&
      currentSourceSessionId?.toLowerCase() !== inputRun.sourceSessionId.toLowerCase()
    ) {
      throw new Error("원본 agent session이 build 이후 변경되어 harness run을 중단했습니다.");
    }
    const exactSourceSessionId = inputRun.sourceMode === "current"
      ? inputRun.sourceSessionId ?? currentSourceSessionId
      : null;
    const runName = inputRun.name?.trim() || `🧰 ${inputRun.published.harnessId} ${inputRun.published.version}`;
    let run = inputRun.message.requestId
      ? await input.harnessStore.runForRequest(inputRun.message.requestId)
      : null;
    if (run && run.harnessVersionId !== inputRun.published.harnessVersionId) {
      throw new Error("같은 Discord 요청 ID가 다른 Harness 실행에 이미 사용되었습니다.");
    }
    if (run?.status === "ready" && run.resultMessageId) {
      await inputRun.reply(`✅ 이미 완료된 하네스 실행입니다: <#${run.executionDiscordChannelId}>`);
      return run;
    }
    if (run?.status === "failed" || run?.status === "interrupted") {
      await inputRun.reply(
        `⚠️ 이전 하네스 실행 상태를 복구했습니다: <#${run.executionDiscordChannelId}>\n` +
        `상태: ${run.status}${run.error ? ` · ${run.error}` : ""}`,
      );
      return run;
    }
    const thread: NewCodexChatResult = run
      ? {
          discordChannelId: run.executionDiscordChannelId,
          discordCategoryId: null,
          channelName: runName,
          threadName: runName,
          cwd: sourceContext.cwd,
          workspaceRoot: sourceContext.workspaceRoot,
          workspaceDisplayName: sourceContext.workspaceDisplayName,
          pendingSession: !run.executionAgentSessionId,
          initialPrompt: null,
          discordDeliveryMode: "thread",
          channelMode: provider === "claude" ? "claude-code" : "session-linked",
        }
      : await createHarnessSessionThread({
          message: inputRun.message,
          context: sourceContext,
          sourceMode: inputRun.sourceMode,
          sourceChannelId,
          sourceSessionId: exactSourceSessionId,
          name: runName,
        });
    let provisioningReply: DiscordReplyLike | void = undefined;
    let progressReporter: HarnessRunProgressReporter | null = null;

    try {
      if (!run) {
        run = await input.harnessStore.createRun({
          provider,
          published: inputRun.published,
          sourceMode: inputRun.sourceMode,
          sourceDiscordChannelId: inputRun.sourceMode === "current" ? sourceChannelId : null,
          sourceAgentSessionId: exactSourceSessionId,
          executionDiscordChannelId: thread.discordChannelId,
          requestId: inputRun.message.requestId,
        });
      }
      await inputRun.message.guild?.addThreadMember?.(
        thread.discordChannelId,
        inputRun.message.userId,
      ).catch((error) => {
        console.warn("discord-bot failed to add the Harness requester to the execution thread", error);
      });
      provisioningReply = await inputRun.reply(
        `${run.progressMessageId ? "♻️ 하네스 실행을 다시 연결했습니다" : "⏳ 하네스 실행 스레드를 만들었습니다"}: ` +
        `<#${thread.discordChannelId}>\n` +
        "실행 스레드의 역할·현재 단계·진행 보고 카드에서 내부 작업을 확인할 수 있습니다.",
      );
      progressReporter = createHarnessRunProgressReporter({
        run,
        guild: inputRun.message.guild!,
      });
      await progressReporter.start();
      const provisioned = await submitProvisionedHarnessTurn({
        provider,
        thread,
        guild: inputRun.message.guild!,
        settingsChannelId: sourceChannelId,
        sourceSessionId: exactSourceSessionId,
        forkSession: inputRun.sourceMode === "current",
        sourceContext,
        run,
        runProgressReporter: progressReporter,
        userPrompt: inputRun.prompt ?? "",
        reply: inputRun.reply,
        replyWithRoleMentions: inputRun.replyWithRoleMentions,
      });
      if (!run.resultMessageId) {
        const resultMessage = await inputRun.message.guild?.sendTextMessage?.(
          thread.discordChannelId,
          `${formatHarnessRunReady({ ...run, executionAgentSessionId: provisioned.sessionId, status: "ready" })}\n\n${provisioned.visibleMessage}`,
          { mentionRoleIds: sourceContext.allowedRoleIds },
        );
        if (resultMessage?.id) {
          run = await input.harnessStore.updateRunExecution(run.runId, {
            resultMessageId: resultMessage.id,
          });
        }
      }
      await progressReporter.finish("completed");
      await input.harnessStore.markRunStatus(run.runId, "ready");
      await updateQueuedReply(
        provisioningReply,
        inputRun.reply,
        `✅ 하네스 실행 스레드가 준비됐습니다: <#${thread.discordChannelId}>`,
      );
      return { ...run, executionAgentSessionId: provisioned.sessionId, status: "ready" };
    } catch (error) {
      if (run) {
        await input.harnessStore.markRunStatus(
          run.runId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        await progressReporter?.finish(
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!run && inputRun.message.guild && input.discardForkedSessionThread) {
        await input.discardForkedSessionThread({
          guild: inputRun.message.guild,
          discordChannelId: thread.discordChannelId,
        }).catch(() => false);
      }
      if (provisioningReply) {
        await updateQueuedReply(
          provisioningReply,
          inputRun.reply,
          `❌ 하네스 실행 준비에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async function handleHarnessCommand(
    message: DiscordMessageLike,
    channelContext: ManagedDiscordChannelContext,
    request: HarnessCommandRequest,
    reply: DiscordMessageLike["reply"],
    replyWithRoleMentions: DiscordMessageLike["reply"],
  ): Promise<void> {
    const store = input.harnessStore;
    if (!store) {
      await reply("이 실행 모드에서는 Harness v2가 활성화되어 있지 않습니다. direct bot/worker 구성을 확인하세요.");
      return;
    }

    if (request.action === "list") {
      await reply(formatHarnessList(await store.listPublished()));
      return;
    }
    const build = await store.buildForChannel(message.channelId);
    const currentRun = await store.runForChannel(message.channelId);

    if (request.action === "status") {
      await reply(
        build
          ? formatHarnessBuildStatus(build)
          : currentRun
            ? formatHarnessRunStatus(currentRun)
            : "현재 스레드는 harness builder/run에 연결되어 있지 않습니다.",
      );
      return;
    }
    if (request.action === "leave") {
      const removed = await store.removeChannelBinding(message.channelId);
      await reply(removed
        ? "현재 Discord 스레드의 harness 자동 주입을 해제했습니다. agent session은 종료하지 않았습니다."
        : "현재 스레드에는 해제할 harness 연결이 없습니다.");
      return;
    }
    if (request.action === "cancel") {
      if (!build) {
        await reply("현재 스레드에는 취소할 harness build가 없습니다.");
        return;
      }
      await store.cancelBuild(build.buildId);
      await reply("Harness build를 취소했습니다. Builder agent session에는 종료 신호를 보내지 않았습니다.");
      return;
    }

    if (request.action === "create") {
      const provider = harnessProvider(channelContext);
      if (!provider) {
        throw new Error("Harness Builder는 Codex 또는 Claude Code 채널에서만 만들 수 있습니다.");
      }
      const sourceMode = request.source ?? "current";
      const sourceSessionId = sourceMode === "current"
        ? channelAgentSessionId(message.channelId, channelContext, provider)
        : null;
      const thread = await createHarnessSessionThread({
        message,
        context: channelContext,
        sourceMode,
        sourceChannelId: message.channelId,
        sourceSessionId,
        name: request.name?.trim() || "Harness Builder",
      });
      let newBuild: HarnessBuildState | null = null;
      let provisioningReply: DiscordReplyLike | void = undefined;

      try {
        newBuild = await store.createBuild({
          provider,
          sourceMode,
          goal: request.prompt,
          sourceDiscordChannelId: sourceMode === "current" ? message.channelId : null,
          sourceAgentSessionId: sourceSessionId,
          builderDiscordChannelId: thread.discordChannelId,
        });
        await message.guild?.addThreadMember?.(thread.discordChannelId, message.userId).catch((error) => {
          console.warn("discord-bot failed to add the Harness requester to the Builder thread", error);
        });
        provisioningReply = await reply(
          `⏳ Harness Builder 스레드를 만들었습니다: <#${thread.discordChannelId}>\n` +
          "Agent session을 연결하고 첫 질문을 준비하고 있습니다.",
        );
        const provisioned = await submitProvisionedHarnessTurn({
          provider,
          thread,
          guild: message.guild!,
          settingsChannelId: message.channelId,
          sourceSessionId,
          forkSession: sourceMode === "current",
          sourceContext: channelContext,
          build: newBuild,
          userPrompt: request.prompt ?? "",
          reply,
          replyWithRoleMentions,
        });
        const refreshed = await store.buildForChannel(thread.discordChannelId) ?? newBuild;
        await message.guild?.sendTextMessage?.(
          thread.discordChannelId,
          formatHarnessBuilderNotice([
            `🧩 **Harness Builder** · ${sourceMode === "current" ? "원본 세션에서 fork" : "새 세션"}`,
            `Build: \`${newBuild.buildId}\` · Agent session: \`${provisioned.sessionId}\``,
            "",
            formatHarnessBuilderGuide(sourceMode),
            "",
            provisioned.visibleMessage,
            provisioned.candidateNotice,
            "",
            formatHarnessBuildStatus(refreshed),
          ].filter(Boolean).join("\n"), refreshed),
          { mentionRoleIds: channelContext.allowedRoleIds },
        );
        await updateQueuedReply(
          provisioningReply,
          reply,
          `✅ Harness Builder 스레드가 준비됐습니다: <#${thread.discordChannelId}>`,
        );
      } catch (error) {
        if (newBuild) {
          await store.cancelBuild(newBuild.buildId, error instanceof Error ? error.message : String(error));
        }
        if (message.guild && input.discardForkedSessionThread) {
          await input.discardForkedSessionThread({
            guild: message.guild,
            discordChannelId: thread.discordChannelId,
          }).catch(() => false);
        }
        if (provisioningReply) {
          await updateQueuedReply(
            provisioningReply,
            reply,
            `❌ Harness Builder 준비에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
          ).catch(() => undefined);
        }
        throw error;
      }
      return;
    }

    if (request.action === "publish" || request.action === "publish-run") {
      if (!build) {
        throw new Error("발행은 Harness Builder 스레드에서 실행하세요.");
      }
      const published = build.status === "published" && build.publishedVersionId
        ? (await store.listPublished()).find(
            (entry) => entry.harnessVersionId === build.publishedVersionId,
          ) ?? null
        : await store.publishBuild(build.buildId);
      if (!published) {
        throw new Error("이미 발행된 Harness 버전을 찾을 수 없습니다. 상태를 확인하세요.");
      }
      await reply(formatHarnessPublished(published));
      if (request.action === "publish-run") {
        await startPublishedHarnessRun({
          message,
          invocationContext: channelContext,
          published,
          sourceMode: request.source ?? build.sourceMode,
          sourceChannelId: (request.source ?? build.sourceMode) === "current"
            ? build.sourceDiscordChannelId
            : message.channelId,
          sourceSessionId: (request.source ?? build.sourceMode) === "current"
            ? build.sourceAgentSessionId
            : null,
          name: request.name,
          prompt: request.prompt,
          reply,
          replyWithRoleMentions,
        });
      }
      return;
    }

    if (request.action === "run") {
      let published: PublishedHarnessVersionState | null = null;
      if (request.harnessId) {
        published = await store.resolvePublished(request.harnessId, request.version);
      } else if (build?.publishedVersionId) {
        published = (await store.listPublished()).find(
          (entry) => entry.harnessVersionId === build.publishedVersionId,
        ) ?? null;
      } else if (currentRun) {
        published = await store.resolvePublished(currentRun.harnessId, request.version);
      }
      if (!published) {
        throw new Error("실행할 발행 harness를 찾을 수 없습니다. harness id와 version을 확인하세요.");
      }
      await startPublishedHarnessRun({
        message,
        invocationContext: channelContext,
        published,
        sourceMode: request.source ?? "fresh",
        name: request.name,
        prompt: request.prompt,
        reply,
        replyWithRoleMentions,
      });
    }
  }

  async function tryAutoSteerAgentTurn(
    message: DiscordMessageLike,
    channelContext: ManagedDiscordChannelContext,
    queue: ChannelQueue,
  ): Promise<boolean> {
    if (
      !queue.activeMessage ||
      !input.controlCodexTurn ||
      message.content.trim().startsWith("__cdc_agent_compact")
    ) {
      return false;
    }

    const routed = routeMessage(message, channelContext);
    const activeRouted = routeMessage(queue.activeMessage, channelContext);
    const isClaudeChannel = channelContext.channelMode === "claude-code";
    const steeringContent = isClaudeChannel && routed.type === "claude-chat"
      ? routed.content
      : channelContext.channelMode === "session-linked" && routed.type === "codex-chat"
        ? routed.content
        : null;
    const activeAgentTurn = isClaudeChannel
      ? activeRouted.type === "claude-chat"
      : activeRouted.type === "codex-chat" ||
        activeRouted.type === "codex-continue-session" ||
        activeRouted.type === "codex-review";

    if (steeringContent === null || !activeAgentTurn) {
      return false;
    }

    const activeMessage = queue.activeMessage;
    const retryDelayMs = input.autoSteerRetryDelayMs ?? DEFAULT_AUTO_STEER_RETRY_DELAY_MS;
    let result: Awaited<ReturnType<NonNullable<CreateDiscordMessageHandlerInput["controlCodexTurn"]>>>;

    try {
      result = await input.controlCodexTurn({
        computerId: channelContext.computerId,
        controlKey: message.channelId,
        action: "steer",
        content: steeringContent,
      });

      for (
        let attempt = 1;
        result.status === "no-active-turn" &&
          attempt < AUTO_STEER_READY_RETRY_ATTEMPTS &&
          queue.activeMessage === activeMessage;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        result = await input.controlCodexTurn({
          computerId: channelContext.computerId,
          controlKey: message.channelId,
          action: "steer",
          content: steeringContent,
        });
      }
    } catch (error) {
      console.warn("discord-bot failed to auto-steer the active agent turn", error);
      if (queue.activeMessage !== activeMessage) {
        return false;
      }
      result = {
        status: "failed",
        message: error instanceof Error ? error.message : "Agent steering 요청에 실패했습니다.",
      };
    }

    if (result.status !== "accepted" && queue.activeMessage !== activeMessage) {
      return false;
    }

    if (isClaudeChannel && result.status !== "accepted") {
      return false;
    }

    if (result.status === "no-active-turn") {
      // The Discord queue can become active slightly before the durable
      // worker has registered its app-server turn. If every readiness retry
      // misses that window, preserve this message as the next queued turn
      // instead of consuming and losing the user's instruction.
      return false;
    }

    touchChannelActivity(message.channelId);

    try {
      await message.reply(formatCodexTurnControlResult({
        action: "steer",
        ...result,
        agentLabel: isClaudeChannel ? "Claude Code" : "Codex",
      }));
    } catch (error) {
      console.warn("discord-bot failed to acknowledge an automatic steering message", error);
    }

    return true;
  }

  async function requestCodexApproval(
    reply: DiscordMessageLike["reply"],
    channelId: string,
    request: CodexPromptApprovalRequest,
  ): Promise<CodexPromptApprovalDecision> {
    touchChannelActivity(channelId);
    const token = String(nextCodexApprovalToken++);

    const decisionPromise = new Promise<CodexPromptApprovalDecision>((resolve) => {
      pendingCodexApprovals.set(token, { channelId, resolve });
    });

    await reply(formatCodexApprovalRequest({ token, request }));

    return decisionPromise;
  }

  function codexUserInputAnswer(
    question: CodexPromptUserInputRequest["questions"][number],
    content: string,
  ): string {
    const answer = content.trim();
    const options = question.options ?? [];
    const numericChoice = answer.match(/^([1-9]\d*)$/);

    if (numericChoice) {
      const selected = options[Number.parseInt(numericChoice[1] ?? "0", 10) - 1];
      if (selected) {
        return selected.label;
      }
    }

    const namedChoice = options.find((option) => option.label.toLowerCase() === answer.toLowerCase());
    return namedChoice?.label ?? answer;
  }

  async function requestCodexUserInput(
    reply: DiscordMessageLike["reply"],
    replyWithRoleMentions: DiscordMessageLike["reply"],
    channelId: string,
    request: CodexPromptUserInputRequest,
  ): Promise<CodexPromptUserInputResponse> {
    const answers: CodexPromptUserInputResponse["answers"] = {};
    const deadline = request.autoResolutionMs && request.autoResolutionMs > 0
      ? Date.now() + request.autoResolutionMs
      : null;

    for (const [index, question] of request.questions.entries()) {
      touchChannelActivity(channelId);
      const remainingMs = deadline === null ? null : Math.max(0, deadline - Date.now());
      const surveyExtraction = extractAgentSurveyRequests(question.question, {
        fallbackOptions: question.options ?? [],
      });
      const survey = surveyExtraction.surveys[0] ?? null;
      const effectiveQuestion: CodexPromptUserInputRequest["questions"][number] = survey
        ? {
            ...question,
            question: survey.question,
            options: survey.options.map((option) => ({
              label: option.label,
              description: option.description ?? "",
            })),
          }
        : surveyExtraction.hadBlocks && surveyExtraction.cleanedText
          ? { ...question, question: surveyExtraction.cleanedText }
          : question;
      const token = `${Date.now().toString(36)}-${nextCodexUserInputToken++}`;
      let pending: {
        token: string;
        question: CodexPromptUserInputRequest["questions"][number];
        resolve: (values: string[]) => void;
        timer: ReturnType<typeof setTimeout> | null;
      };
      const responsePromise = new Promise<string[]>((resolve) => {
        pending = { token, question: effectiveQuestion, resolve, timer: null };
      });

      pendingCodexUserInputs.set(channelId, pending!);

      if (remainingMs !== null) {
        pending!.timer = setTimeout(() => {
          if (pendingCodexUserInputs.get(channelId) !== pending) {
            return;
          }

          pendingCodexUserInputs.delete(channelId);
          const fallback = effectiveQuestion.options?.[0]?.label ?? "";
          pending!.resolve(fallback ? [fallback] : []);
          void reply(formatCodexUserInputReceived({ answer: fallback, autoResolved: true })).catch((error) => {
            console.warn("discord-bot failed to post a Codex question auto-response", error);
          });
        }, remainingMs);
      }

      try {
        if (survey) {
          const timeoutText = remainingMs && remainingMs > 0
            ? `${Math.ceil(remainingMs / 1_000)}초 안에 답하지 않으면 첫 번째 선택지로 자동 진행합니다.`
            : null;
          const surveyMessages = formatAgentSurveyMessages({
            agent: "codex",
            survey,
            response: {
              kind: "user-input",
              token,
              context: [
                `Codex 질문 ${index + 1}/${request.questions.length} · ${effectiveQuestion.header}`,
                timeoutText,
              ].filter(Boolean).join("\n"),
            },
          });
          const [questionMessage, ...fileMessages] = surveyMessages;

          if (questionMessage) {
            await replyWithRoleMentions(questionMessage);
          }

          for (const fileMessage of fileMessages) {
            await reply(fileMessage);
          }
        } else {
          await replyWithRoleMentions(formatCodexUserInputRequest({
            question: effectiveQuestion,
            index,
            total: request.questions.length,
            autoResolutionMs: remainingMs,
          }));
        }
        answers[question.id] = { answers: await responsePromise };
      } finally {
        if (pendingCodexUserInputs.get(channelId) === pending!) {
          pendingCodexUserInputs.delete(channelId);
        }
        if (pending!.timer) {
          clearTimeout(pending!.timer);
        }
      }
    }

    return { answers };
  }

  function createLiveProgressReporter(input: {
    message: DiscordMessageLike;
    channelContext: ManagedDiscordChannelContext;
    agentLabel: "Codex" | "Claude Code";
  }): {
    publish(event: {
      type: string;
      label?: string;
      detail?: string;
      text?: string;
      eventType?: string;
    }): Promise<void>;
    finish(finalMessage?: string | null): Promise<void>;
  } {
    let lastText: string | null = null;
    let pendingAgentMessage: string | null = null;
    let sentCount = 0;
    let announcedTruncation = false;

    // Long intermediate texts are split into full standalone messages instead
    // of being truncated; the cap only guards against runaway flooding.
    const send = async (text: string, kind: "message" | "thought") => {
      if (!input.message.guild?.sendTextMessage || text === lastText) {
        return;
      }

      lastText = text;
      const chunks = splitDiscordMessageContent(text, LIVE_PROGRESS_CHUNK_LENGTH);

      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (sentCount >= MAX_LIVE_PROGRESS_MESSAGES_PER_TASK) {
          if (!announcedTruncation) {
            announcedTruncation = true;
            try {
              await input.message.guild.sendTextMessage(
                input.message.channelId,
                formatLiveAgentProgress({
                  agentLabel: input.agentLabel,
                  text: "중간 메시지가 너무 많아 이후 진행 텍스트는 생략합니다. 최종 답변은 그대로 전송됩니다.",
                }),
              );
            } catch (error) {
              console.warn("discord-bot failed to send a progress truncation notice", error);
            }
          }
          return;
        }

        sentCount += 1;

        try {
          await input.message.guild.sendTextMessage(
            input.message.channelId,
            formatLiveAgentProgress({
              agentLabel: input.agentLabel,
              text: chunk,
              kind,
              continued: chunkIndex > 0,
            }),
          );
        } catch (error) {
          console.warn("discord-bot failed to send an unmentioned progress message", error);
        }
      }
    };

    return {
      async publish(event) {
        if (event.type === "agent-message") {
          const text = event.text?.trim() ?? "";

          if (!text || text === pendingAgentMessage) {
            return;
          }

          if (pendingAgentMessage) {
            await send(pendingAgentMessage, "message");
          }

          pendingAgentMessage = text;
          return;
        }

        if (pendingAgentMessage) {
          await send(pendingAgentMessage, "message");
          pendingAgentMessage = null;
        }

        if (event.type !== "agent-thought") {
          return;
        }

        const text = event.text?.trim() ?? "";
        if (text) {
          await send(text, "thought");
        }
      },
      async finish(finalMessage) {
        const pending = pendingAgentMessage;
        pendingAgentMessage = null;

        if (pending && pending !== finalMessage?.trim()) {
          await send(pending, "message");
        }

        lastText = null;
      },
    };
  }

  interface HarnessRunProgressReporter {
    start(): Promise<void>;
    publish(event: AgentPromptProgressEvent): Promise<void>;
    finish(status: "completed" | "failed", detail?: string | null): Promise<void>;
  }

  function createHarnessRunProgressReporter(inputReporter: {
    run: HarnessRunState;
    guild: DiscordGuildSurface;
  }): HarnessRunProgressReporter {
    let state: HarnessProgressState = inputReporter.run.progress ?? createHarnessProgressState({
      provider: inputReporter.run.provider,
      harnessVersionId: inputReporter.run.harnessVersionId,
      runId: inputReporter.run.runId,
      sessionId: inputReporter.run.executionAgentSessionId,
    });
    let messageId = inputReporter.run.progressMessageId;
    let lastRenderedAt = 0;
    let receivedEvent = false;

    const persist = async () => {
      await input.harnessStore?.updateRunExecution(inputReporter.run.runId, {
        progressMessageId: messageId,
        progress: state,
      });
    };

    const render = async (
      status: "running" | "completed" | "failed" = "running",
      force = false,
    ) => {
      const now = Date.now();
      if (!force && now - lastRenderedAt < 15_000) {
        return;
      }
      const content = formatHarnessProgress(state, status);
      if (messageId && inputReporter.guild.editTextMessage) {
        try {
          await inputReporter.guild.editTextMessage(
            inputReporter.run.executionDiscordChannelId,
            messageId,
            content,
          );
          lastRenderedAt = now;
          await persist();
          return;
        } catch (error) {
          console.warn("discord-bot failed to edit Harness progress card; creating a replacement", error);
          messageId = null;
        }
      }
      if (!inputReporter.guild.sendTextMessage) {
        return;
      }
      const sent = await inputReporter.guild.sendTextMessage(
        inputReporter.run.executionDiscordChannelId,
        content,
      );
      messageId = sent?.id ?? null;
      lastRenderedAt = now;
      await persist();
    };

    const sendReport = async (report: string) => {
      if (!inputReporter.guild.sendTextMessage) {
        return;
      }
      const chunks = splitDiscordMessageContent(
        formatHarnessProgressReport({ provider: state.provider, report }),
        LIVE_PROGRESS_CHUNK_LENGTH,
      );
      for (const chunk of chunks) {
        await inputReporter.guild.sendTextMessage(
          inputReporter.run.executionDiscordChannelId,
          chunk,
        );
      }
    };

    return {
      async start() {
        // A restored Gateway reuses the existing card and its persisted counters.
        // A fresh run creates the card before waiting for the worker.
        if (!messageId) {
          await render("running", true);
        }
      },
      async publish(event) {
        receivedEvent = true;
        const update = applyHarnessProgressEvent(state, event);
        state = update.state;
        if (update.report) {
          try {
            await sendReport(update.report);
          } catch (error) {
            console.warn("discord-bot failed to post Harness coordinator progress", error);
          }
        }
        try {
          await render("running", update.significant);
        } catch (error) {
          console.warn("discord-bot failed to update Harness progress", error);
        }
      },
      async finish(status, detail) {
        // When a Gateway resumes after the worker has already finished, keep the
        // persisted counters instead of replacing them with a fresh empty card.
        if (!receivedEvent && inputReporter.run.progress) {
          state = inputReporter.run.progress;
        }
        state = {
          ...state,
          stage: status === "completed" ? "완료" : "실패",
          activeRole: "gateway",
          activeDetail: detail?.trim() || (status === "completed"
            ? "최종 결과를 Discord에 전달했습니다."
            : "실패 내용을 보존하고 Discord에 전달했습니다."),
          updatedAt: new Date().toISOString(),
        };
        try {
          await render(status, true);
        } catch (error) {
          console.warn("discord-bot failed to finalize Harness progress", error);
        }
      },
    };
  }

  async function processDiscordMessage(message: DiscordMessageLike): Promise<void> {
    const channelContext = await input.resolveChannelContext(message.channelId);

    if (!channelContext) {
      return;
    }

    const reply = (replyMessage: DiscordOutgoingMessage) => message.reply(replyMessage);
    const replyWithRoleMentions = createReplyWithOptionalRoleMentions(
      reply,
      channelContext.channelMode !== "shell-admin" && channelContext.discordDeliveryMode === "thread"
        ? channelContext.allowedRoleIds
        : [],
    );

    const approvalResponse = parseCodexApprovalResponse(message.content);

    if (approvalResponse) {
      if (!hasAllowedRole(message.roleIds, channelContext.allowedRoleIds)) {
        await reply(formatDenied("User does not have an allowed role"));
        return;
      }

      const pending = pendingCodexApprovals.get(approvalResponse.token);

      if (!pending || pending.channelId !== message.channelId) {
        await reply(formatCodexApprovalDecision({
          decision: approvalResponse.decision,
          accepted: false,
          found: false,
        }));
        return;
      }

      pendingCodexApprovals.delete(approvalResponse.token);
      touchChannelActivity(message.channelId);
      pending.resolve({ decision: approvalResponse.decision });
      await reply(formatCodexApprovalDecision({
        decision: approvalResponse.decision,
        accepted: approvalResponse.decision === "accept" || approvalResponse.decision === "acceptForSession",
        found: true,
      }));
      return;
    }

    const userInputSelection = parseCodexUserInputSelection(message.content);
    const pendingUserInput = pendingCodexUserInputs.get(message.channelId);

    if (userInputSelection) {
      if (!hasAllowedRole(message.roleIds, channelContext.allowedRoleIds)) {
        await reply(formatDenied("User does not have an allowed role"));
        return;
      }

      if (!pendingUserInput || pendingUserInput.token !== userInputSelection.token) {
        await reply(formatAgentSurveySelectionResult({ accepted: false, answers: userInputSelection.answers }));
        return;
      }

      pendingCodexUserInputs.delete(message.channelId);
      if (pendingUserInput.timer) {
        clearTimeout(pendingUserInput.timer);
      }
      touchChannelActivity(message.channelId);
      pendingUserInput.resolve(userInputSelection.answers);
      await reply(formatAgentSurveySelectionResult({ accepted: true, answers: userInputSelection.answers }));
      return;
    }

    if (pendingUserInput && isCodexUserInputReply(message.content)) {
      if (!hasAllowedRole(message.roleIds, channelContext.allowedRoleIds)) {
        await reply(formatDenied("User does not have an allowed role"));
        return;
      }

      pendingCodexUserInputs.delete(message.channelId);
      if (pendingUserInput.timer) {
        clearTimeout(pendingUserInput.timer);
      }
      const answer = codexUserInputAnswer(pendingUserInput.question, message.content);
      touchChannelActivity(message.channelId);
      pendingUserInput.resolve(answer ? [answer] : []);
      await reply(formatCodexUserInputReceived({ answer }));
      return;
    }

    const routed = routeMessage(message, channelContext);

    if (routed.type === "harness-command") {
      try {
        await handleHarnessCommand(
          message,
          channelContext,
          routed.request,
          reply,
          replyWithRoleMentions,
        );
      } catch (error) {
        await reply(`Harness 작업 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (routed.type === "queue-prompt") {
      await processDiscordMessage({ ...message, content: routed.content });
      return;
    }

    if (routed.type === "queue-status") {
      const queue = channelQueues.get(message.channelId);
      await reply(formatQueueStatus({
        active: queue?.activeMessage ? queueMessageSummary(queue.activeMessage.content) : null,
        pending: queue?.pending.map((entry) => queueMessageSummary(entry.message.content)) ?? [],
      }));
      return;
    }

    if (routed.type === "queue-clear") {
      const queue = channelQueues.get(message.channelId);
      const removed = queue?.pending.splice(0) ?? [];

      for (const entry of removed) {
        try {
          await entry.message.reply("이 요청은 /queue-clear로 대기열에서 삭제되었습니다.");
        } catch (error) {
          console.warn("discord-bot failed to acknowledge a cleared queue entry", error);
        } finally {
          await completeDurableMessage(entry.message);
          entry.resolve();
        }
      }

      await reply(formatQueueClearResult({
        clearedCount: removed.length,
        active: Boolean(queue?.activeMessage),
      }));
      return;
    }

    if (routed.type === "codex-steer" || routed.type === "codex-interrupt") {
      const action = routed.type === "codex-steer" ? "steer" : "interrupt";

      if (!input.controlCodexTurn) {
        await reply(formatCodexTurnControlResult({
          action,
          status: "unsupported",
          message: "이 봇 실행 모드에는 agent turn 제어가 연결되어 있지 않습니다.",
          agentLabel: channelContext.channelMode === "claude-code" ? "Claude Code" : "Codex",
        }));
        return;
      }

      const result = await input.controlCodexTurn({
        computerId: channelContext.computerId,
        controlKey: message.channelId,
        action,
        ...(routed.type === "codex-steer" ? { content: routed.content } : {}),
      });
      if (action === "interrupt" && result.status !== "failed" && result.status !== "unsupported") {
        const pending = pendingCodexUserInputs.get(message.channelId);
        if (pending) {
          pendingCodexUserInputs.delete(message.channelId);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          pending.resolve([]);
        }
      }
      await reply(formatCodexTurnControlResult({
        action,
        ...result,
        agentLabel: channelContext.channelMode === "claude-code" ? "Claude Code" : "Codex",
      }));
      return;
    }

    if (routed.type === "bot-help") {
      await reply(formatHelp(channelContext.channelMode));
      return;
    }

    if (routed.type === "channel-status") {
      const queue = channelQueues.get(message.channelId);
      const claudeSessionId =
        channelContext.channelMode === "claude-code"
          ? claudeSessionIdsByChannel.get(message.channelId) ?? channelContext.claudeSessionId ?? null
          : null;

      await reply(
        formatChannelStatus({
          ...channelContext,
          claudeSessionId,
          agentSettings: agentSettingsController.get(message.channelId, channelContext),
          execution: {
            active: Boolean(queue?.activeMessage),
            activeRequest: queue?.activeMessage ? queueMessageSummary(queue.activeMessage.content) : null,
            startedAt: queue?.activeStartedAt ?? null,
            lastActivityAt: queue?.activeLastActivityAt ?? null,
            pendingCount: queue?.pending.length ?? 0,
            waitingForApproval: channelWaitingForApproval(message.channelId),
            waitingForUserInput: channelWaitingForUserInput(message.channelId),
          },
        }),
      );
      return;
    }

    if (routed.type === "maintenance-panel") {
      await reply(formatMaintenancePanel(channelContext.channelMode));
      return;
    }

    if (routed.type === "admin-sync") {
      const queuedReply = await reply(formatSyncAck({ limit: routed.limit }));

      try {
        if (!input.syncCodexSessions) {
          throw new Error("Codex session sync is not connected for this bot mode.");
        }

        if (!message.guild) {
          throw new Error("Discord guild context is required for session sync.");
        }

        const result = await input.syncCodexSessions({
          guild: message.guild,
          limit: routed.limit,
          onProgress: async (progress) => {
            touchChannelActivity(message.channelId);
            await updateQueuedReply(
              queuedReply,
              (replyMessage) => reply(replyMessage),
              formatSyncProgressUpdate(progress),
            );
          },
        });
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatSyncResultUpdate({ result }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Codex session sync failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatSyncResultUpdate({ error: { message: messageText } }),
        );
      }
      return;
    }

    if (routed.type === "admin-new-chat") {
      const newChatChannelMode = channelContext.channelMode === "claude-code" ? "claude-code" : "session-linked";
      const queuedReply = await reply(formatNewChatAck({
        ...routed,
        channelMode: newChatChannelMode,
      }));

      try {
        if (!input.createNewCodexChat) {
          throw new Error("New Codex chat creation is not connected for this bot mode.");
        }

        if (!message.guild) {
          throw new Error("Discord guild context is required for new Codex chat creation.");
        }

        const result = await input.createNewCodexChat({
          guild: message.guild,
          name: routed.name,
          cwd: routed.cwd,
          currentCwd: channelContext.cwd,
          useCategory: routed.useCategory,
          initialPrompt: routed.initialPrompt,
          channelMode: newChatChannelMode,
          sessionThreadParentChannelId:
            (channelContext.discordDeliveryMode ?? "channel") === "channel" ? message.channelId : null,
        });
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatNewChatResult({ result }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "New Codex chat creation failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatNewChatResult({ error: { message: messageText } }),
        );
      }
      return;
    }

    if (routed.type === "admin-sync-status") {
      try {
        if (!input.getSyncStatus) {
          throw new Error("Codex sync status is not connected for this bot mode.");
        }

        await reply(formatSyncStatus(await input.getSyncStatus()));
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Codex sync status failed";
        await reply(formatSyncResultUpdate({ error: { message: messageText } }));
      }
      return;
    }

    if (routed.type === "admin-sync-mode") {
      try {
        if (!input.setTranscriptSyncMode) {
          throw new Error("Transcript sync mode is not connected for this bot mode.");
        }

        const result = await input.setTranscriptSyncMode(routed.mode);
        await reply(formatSyncModeResult(result));
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Transcript sync mode update failed";
        await reply(formatSyncResultUpdate({ error: { message: messageText } }));
      }
      return;
    }

    if (routed.type === "bot-reload") {
      if (routed.mode === "restart" && !routed.confirmed) {
        await reply(formatReloadConfirmation());
        return;
      }

      const queuedReply = await reply(formatReloadAck({ mode: routed.mode, force: routed.force }));

      try {
        if (!input.reloadBot) {
          throw new Error("Bot reload is not connected for this bot mode.");
        }

        const result = await input.reloadBot({
          mode: routed.mode,
          execution: executionState(message),
          force: routed.force,
        });

        if (result.deferred) {
          deferredRestartRequested = true;
          deferredRestartNotice = {
            channelId: message.channelId,
            guild: message.guild,
            reply: message.reply,
          };
        } else if (result.restarting) {
          deferredRestartRequested = false;
          restartScheduled = true;
        }

        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatReloadResult({ result }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Bot reload failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatReloadResult({ error: { message: messageText } }),
        );
      }
      return;
    }

    if (routed.type === "admin-clear-messages") {
      if (routed.mode === "all" && !routed.confirmed) {
        await reply(formatClearConfirmation());
        return;
      }

      try {
        if (!message.clearMessages) {
          throw new Error("Discord message deletion is not connected for this bot mode.");
        }

        const result = await message.clearMessages({
          mode: routed.mode,
          ...(routed.mode === "count" ? { count: routed.count } : {}),
        });
        await reply(formatClearResult({ result }));
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Discord message deletion failed";
        await reply(formatClearResult({ error: { message: messageText } }));
      }
      return;
    }

    if (routed.type === "claude-resume-list") {
      try {
        if (!input.listResumableClaudeSessions) {
          throw new Error("Claude 세션 다시 열기는 direct 모드에서만 지원됩니다.");
        }

        const sessions = await input.listResumableClaudeSessions({ limit: 25 });
        await reply(formatClaudeResumeSelection({ sessions }));
      } catch (error) {
        await reply(formatClaudeResumeResult({
          status: "error",
          message: error instanceof Error ? error.message : "Claude 세션 목록 조회에 실패했습니다.",
        }));
      }
      return;
    }

    if (routed.type === "claude-resume") {
      const queuedReply = await reply(formatClaudeResumeAck());

      try {
        if (!input.resumeClaudeSession) {
          throw new Error("Claude 세션 다시 열기는 direct 모드에서만 지원됩니다.");
        }

        if (!message.guild) {
          throw new Error("Discord guild context is required to reopen a session thread.");
        }

        const result = await input.resumeClaudeSession({
          sessionId: routed.sessionId,
          guild: message.guild,
        });
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatClaudeResumeResult(result),
        );
      } catch (error) {
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatClaudeResumeResult({
            status: "error",
            message: error instanceof Error ? error.message : "Claude 세션 다시 열기에 실패했습니다.",
          }),
        );
      }
      return;
    }

    if (routed.type === "admin-sync-select") {
      const queuedReply = await reply(formatSyncSelectionAck({ limit: routed.limit }));

      try {
        if (!input.previewSelectableCodexSessions) {
          throw new Error("Selectable Codex session sync is not connected for this bot mode.");
        }

        const result = await input.previewSelectableCodexSessions({ limit: routed.limit });
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatSyncSelection(result),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Codex session selection failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatSyncResultUpdate({ error: { message: messageText } }),
        );
      }
      return;
    }

    if (routed.type === "admin-sync-selected") {
      const queuedReply = await reply(formatSyncAck({ limit: routed.sessionIds.length }));

      try {
        if (!input.syncCodexSessions) {
          throw new Error("Codex session sync is not connected for this bot mode.");
        }

        if (!message.guild) {
          throw new Error("Discord guild context is required for session sync.");
        }

        const result = await input.syncCodexSessions({
          guild: message.guild,
          limit: routed.sessionIds.length,
          sessionIds: routed.sessionIds,
          onProgress: async (progress) => {
            touchChannelActivity(message.channelId);
            await updateQueuedReply(
              queuedReply,
              (replyMessage) => reply(replyMessage),
              formatSyncProgressUpdate(progress),
            );
          },
        });
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatSyncResultUpdate({ result }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Codex session sync failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatSyncResultUpdate({ error: { message: messageText } }),
        );
      }
      return;
    }

    if (routed.type === "admin-sync-delete") {
      try {
        if (!routed.confirmed) {
          if (!input.previewSyncedChannelsDelete) {
            throw new Error("Synced channel delete preview is not connected for this bot mode.");
          }

          await reply(
            formatDeletePreview(
              await input.previewSyncedChannelsDelete({
                mode: routed.mode,
                ...(routed.mode === "session" ? { sessionId: routed.sessionId ?? null } : {}),
              }),
            ),
          );
          return;
        }

        if (!input.deleteSyncedChannels) {
          throw new Error("Synced channel deletion is not connected for this bot mode.");
        }

        if (!message.guild) {
          throw new Error("Discord guild context is required for synced channel deletion.");
        }

        const queuedReply = await reply(formatDeleteAck({ mode: routed.mode }));
        const result = await input.deleteSyncedChannels({
          guild: message.guild,
          mode: routed.mode,
          ...(routed.mode === "session" ? { sessionId: routed.sessionId ?? null } : {}),
        });
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatDeleteResult({ result }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Synced channel deletion failed";
        await reply(formatDeleteResult({ error: { message: messageText } }));
      }
      return;
    }

    if (routed.type === "archive-session") {
      if (!routed.confirmed) {
        await reply(formatArchiveAck({ confirmed: false, sessionId: routed.sessionId }));
        return;
      }

      const queuedReply = await reply(formatArchiveAck({ confirmed: true, sessionId: routed.sessionId }));

      try {
        if (!input.archiveSyncedSession) {
          throw new Error("Codex session archive is not connected for this bot mode.");
        }

        const result = await input.archiveSyncedSession({
          guild: message.guild ?? null,
          discordChannelId: message.channelId,
          codexSessionId: routed.sessionId ?? channelContext.codexSessionId ?? null,
        });

        try {
          await updateQueuedReply(
            queuedReply,
            (replyMessage) => reply(replyMessage),
            formatArchiveResult({ result }),
          );
        } catch (error) {
          console.warn("discord-bot could not edit archive result, possibly because the channel was deleted", error);
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Codex session archive failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatArchiveResult({ error: { message: messageText } }),
        );
      }
      return;
    }

    if (routed.type === "schedule-command") {
      try {
        if (!input.scheduleCommand) {
          throw new Error("Scheduled commands are not connected for this bot mode.");
        }

        const result = await input.scheduleCommand({
          request: routed.request,
          channelId: message.channelId,
          userId: message.userId,
          roleIds: message.roleIds,
        });
        await reply(formatScheduleResult(result));
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Schedule command failed";
        await reply(formatScheduleResult({ error: { message: messageText } }));
      }
      return;
    }

    if (routed.type === "agent-model") {
      await agentSettingsController.updateModel(message.channelId, channelContext, routed.model);
      const settings = agentSettingsController.get(message.channelId, channelContext);
      await reply(formatAgentSettingsResult({
        agent: agentSettingsController.agentFor(channelContext),
        scope: channelContext.agentMain ? "main default" : "thread override",
        ...settings,
        updated: "model",
      }));
      return;
    }

    if (routed.type === "agent-effort") {
      await agentSettingsController.updateEffort(message.channelId, channelContext, routed.effort);
      const settings = agentSettingsController.get(message.channelId, channelContext);
      await reply(formatAgentSettingsResult({
        agent: agentSettingsController.agentFor(channelContext),
        scope: channelContext.agentMain ? "main default" : "thread override",
        ...settings,
        updated: "effort",
      }));
      return;
    }

    if (routed.type === "agent-settings") {
      const settings = agentSettingsController.get(message.channelId, channelContext);
      await reply(formatAgentSettingsResult({
        agent: agentSettingsController.agentFor(channelContext),
        scope: channelContext.agentMain ? "main default" : "thread override",
        ...settings,
      }));
      return;
    }

    if (routed.type === "codex-run-mode") {
      await agentSettingsController.updateEffort(
        message.channelId,
        channelContext,
        routed.mode === "default" ? "default" : routed.mode === "fast" ? "low" : "xhigh",
      );

      await reply(
        formatCodexRunModeResult({
          mode: routed.mode,
          reasoningEffort: agentSettingsController.codexReasoningEffort(message.channelId, channelContext),
        }),
      );
      return;
    }

    if (routed.type === "codex-review") {
      const agentSettings = agentSettingsController.get(message.channelId, channelContext);
      const codexMessage = {
        computerDisplayName: channelContext.computerDisplayName,
        workspaceDisplayName: channelContext.workspaceDisplayName,
        cwd: channelContext.cwd,
        prompt: routed.prompt,
        permissionSettings: codexPermissionSettings(),
      };

      if (!input.submitCodexPrompt) {
        await reply(
          formatAgentResultUpdate(codexMessage, {
            error: { message: "Codex review is not connected for this mode yet." },
          }),
        );
        return;
      }

      const queuedReply = await reply(formatAgentAck(codexMessage));
      let recentEvents: string[] = [];
      const progressReporter = createLiveProgressReporter({ message, channelContext, agentLabel: "Codex" });

      try {
        const response = await input.submitCodexPrompt({
          computerId: channelContext.computerId,
          ...(message.requestId ? { requestId: message.requestId, queueKey: message.channelId } : {}),
          payload: {
            workspaceRoot: channelContext.workspaceRoot,
            cwd: channelContext.cwd,
            prompt: routed.prompt,
            timeoutMs: resolveAgentPromptTimeoutMs(channelContext.timeoutMs),
            sessionId: null,
            mode: "review",
            model: agentSettings.model,
            reasoningEffort: agentSettingsController.codexReasoningEffort(message.channelId, channelContext),
            controlKey: message.channelId,
          },
          onProgress: async (event) => {
            touchChannelActivity(message.channelId);
            if (event.type === "thread-started") {
              await input.markDiscordRequestedCodexSession?.(event.sessionId, {
                discordChannelId: message.channelId,
              });
            }
            const status = event.type === "operation-progress" ? event.label : event.type;
            recentEvents = appendProgressEvent(recentEvents, readableProgressEvent(event));
            await progressReporter.publish(event);
            await updateQueuedReply(
              queuedReply,
              (replyMessage) => reply(replyMessage),
              formatAgentProgressUpdate(codexMessage, {
                status,
                latestMessage:
                  event.type === "operation-progress"
                    ? event.detail
                    : event.type === "agent-message"
                      ? event.text
                      : undefined,
                recentEvents,
              }),
            );
          },
          onApprovalRequest: (request) => requestCodexApproval(replyWithRoleMentions, message.channelId, request),
          onUserInputRequest: (request) => requestCodexUserInput(reply, replyWithRoleMentions, message.channelId, request),
        });
        await progressReporter.finish(extractAgentResponseFinalMessage(response));

        const reviewSessionId = extractAgentResponseSessionId(response);

        const questionMentionSent = await updateQueuedResultReply({
          message,
          queuedReply,
          fallbackReply: (replyMessage) => reply(replyMessage),
          payload: formatAgentResultUpdate(codexMessage, response),
          questionMentionRoleIds: message.relayRequest ? [] : channelContext.allowedRoleIds,
        });
        const responseFailed = promptResponseFailed(response);
        const completionDelivery = await sendThreadCompletionMention({
          message,
          channelContext,
          agentLabel: "Codex",
          failed: responseFailed,
          deferForPendingRequest: questionMentionSent,
          pendingRequestCount: channelPendingAgentRequestCount(message.channelId, channelContext),
        });

        if (reviewSessionId) {
          if (completionDelivery !== "unavailable") {
            await input.markDiscordRequestedCodexSession?.(reviewSessionId, {
              discordChannelId: message.channelId,
              completionMentionSent: true,
            });
          } else {
            await input.markDiscordRequestedCodexSession?.(reviewSessionId, {
              discordChannelId: message.channelId,
            });
          }
        }
      } catch (error) {
        await progressReporter.finish();
        const messageText = error instanceof Error ? error.message : "Codex review failed";
        await updateQueuedResultReply({
          message,
          queuedReply,
          fallbackReply: (replyMessage) => reply(replyMessage),
          payload: formatAgentResultUpdate(codexMessage, { error: { message: messageText } }),
          questionMentionRoleIds: message.relayRequest ? [] : channelContext.allowedRoleIds,
        });
        await sendThreadCompletionMention({
          message,
          channelContext,
          agentLabel: "Codex",
          failed: true,
        });
      }
      return;
    }

    if (routed.type === "fork-session") {
      if (channelContext.channelMode !== "session-linked" && channelContext.channelMode !== "claude-code") {
        await reply(
          formatForkSessionResult({
            error: {
              message: "현재 /fork는 Codex 또는 Claude Code session thread에서만 지원됩니다.",
            },
          }),
        );
        return;
      }

      const isClaudeFork = channelContext.channelMode === "claude-code";
      const agentSettings = agentSettingsController.get(message.channelId, channelContext);
      const sourceSessionId = isClaudeFork
        ? claudeSessionIdsByChannel.get(message.channelId) ?? channelContext.claudeSessionId ?? null
        : codexSessionIdsByChannel.get(message.channelId) ?? channelContext.codexSessionId ?? null;
      const sourceHarnessBuild = await input.harnessStore?.buildForChannel(message.channelId) ?? null;
      const sourceHarnessRun = await input.harnessStore?.runForChannel(message.channelId) ?? null;

      const queuedReply = await reply(
        formatForkSessionAck({
          name: routed.name,
          channelMode: channelContext.channelMode,
          sourceSessionId,
        }),
      );
      let forkThread: NewCodexChatResult | null = null;
      let forkHarnessBuild: HarnessBuildState | null = null;
      let forkHarnessRun: HarnessRunState | null = null;
      const activeForkSessionIds = new Set<string>();

      const trackActiveForkSession = (sessionId: string) => {
        if (!input.setSessionStreaming || activeForkSessionIds.has(sessionId)) {
          return;
        }

        activeForkSessionIds.add(sessionId);
        input.setSessionStreaming(sessionId, true);
      };

      try {
        if (!sourceSessionId) {
          const agentLabel = isClaudeFork ? "Claude Code" : "Codex";
          throw new Error(`현재 Discord thread에 연결된 ${agentLabel} session ID가 없습니다. 먼저 이 thread에서 요청을 한 번 실행해 주세요.`);
        }

        if (!input.createForkedSessionThread) {
          throw new Error("Session fork thread creation is not connected for this bot mode.");
        }

        if (!message.guild) {
          throw new Error("Discord guild context is required for session fork.");
        }

        forkThread = await input.createForkedSessionThread({
          guild: message.guild,
          sourceDiscordChannelId: message.channelId,
          sourceSessionId,
          name: routed.name,
        });

        if (sourceHarnessBuild && input.harnessStore) {
          forkHarnessBuild = await input.harnessStore.createBuild({
            provider: sourceHarnessBuild.provider,
            sourceMode: "current",
            goal: sourceHarnessBuild.goal,
            sourceDiscordChannelId: message.channelId,
            sourceAgentSessionId: sourceSessionId,
            builderDiscordChannelId: forkThread.discordChannelId,
          });
          forkHarnessBuild = await input.harnessStore.cloneBuildCandidate(
            sourceHarnessBuild.buildId,
            forkHarnessBuild.buildId,
          );
        } else if (sourceHarnessRun && input.harnessStore) {
          const published = (await input.harnessStore.listPublished()).find(
            (entry) =>
              entry.harnessVersionId === sourceHarnessRun.harnessVersionId &&
              entry.snapshotDigest === sourceHarnessRun.snapshotDigest,
          );
          if (!published) {
            throw new Error("현재 실행 스레드에 고정된 immutable harness snapshot을 찾을 수 없습니다.");
          }
          forkHarnessRun = await input.harnessStore.createRun({
            provider: sourceHarnessRun.provider,
            published,
            sourceMode: "current",
            sourceDiscordChannelId: message.channelId,
            sourceAgentSessionId: sourceSessionId,
            executionDiscordChannelId: forkThread.discordChannelId,
          });
          await input.harnessStore.markRunStatus(forkHarnessRun.runId, "running");
        }

        let forkSessionId: string | null = null;
        let finalMessage: string | null = null;
        let candidateNotice: string | null = null;
        const forkPrompt = forkHarnessBuild
          ? harnessBuilderPrompt({
              build: forkHarnessBuild,
              userMessage: `원본 Harness Builder에서 '${routed.name}' 분기로 이어서 설계하세요.`,
              initial: true,
            })
          : forkHarnessRun
            ? harnessExecutionPrompt({
                run: forkHarnessRun,
                userMessage: `원본 하네스 실행에서 '${routed.name}' 분기로 작업을 이어가세요.`,
                initial: true,
              })
            : isClaudeFork
              ? claudeForkPrompt(routed.name)
              : codexForkPrompt(routed.name);

        if (isClaudeFork) {
          if (!input.submitClaudePrompt) {
            throw new Error("Claude Code is not connected for this bot mode.");
          }

          let response = await input.submitClaudePrompt({
            computerId: channelContext.computerId,
            ...(message.requestId ? { requestId: message.requestId } : {}),
            queueKey: forkThread.discordChannelId,
            payload: {
              workspaceRoot: forkThread.workspaceRoot,
              cwd: forkThread.cwd,
              prompt: forkPrompt,
              timeoutMs: resolveAgentPromptTimeoutMs(channelContext.timeoutMs),
              sessionId: sourceSessionId,
              forkSession: true,
              sessionName: forkThread.threadName,
              model: agentSettings.model,
              effort: agentSettings.effort,
              controlKey: forkThread.discordChannelId,
              harnessBuilder: Boolean(forkHarnessBuild),
              ...(forkHarnessRun ? { harness: input.harnessStore?.workerBinding(forkHarnessRun) } : {}),
            },
          });

          const failureMessage = forkResponseErrorMessage(response, "Claude Code");
          if (failureMessage) {
            throw new Error(failureMessage);
          }

          forkSessionId = extractAgentResponseSessionId(response);
          if (!forkSessionId) {
            throw new Error("Claude Code fork가 새 session ID를 반환하지 않았습니다.");
          }

          if (forkSessionId.toLowerCase() === sourceSessionId.toLowerCase()) {
            throw new Error("Claude Code fork가 원본과 같은 session ID를 반환해 연결을 중단했습니다.");
          }

          if (!input.recordClaudeSession) {
            throw new Error("Claude Code fork session persistence is not connected for this bot mode.");
          }

          await input.recordClaudeSession({
            discordChannelId: forkThread.discordChannelId,
            claudeSessionId: forkSessionId,
          });
          claudeSessionIdsByChannel.set(forkThread.discordChannelId, forkSessionId);
          if (forkHarnessBuild) {
            await input.harnessStore?.bindBuilderSession(forkHarnessBuild.buildId, forkSessionId);
            const prepared = await prepareHarnessBuilderResponseWithRetries({
              build: forkHarnessBuild,
              response,
              provider: "claude",
              channelContext,
              settingsChannelId: message.channelId,
              queueKey: forkThread.discordChannelId,
              workspaceRoot: forkThread.workspaceRoot,
              cwd: forkThread.cwd,
              sessionId: forkSessionId,
              sessionName: forkThread.threadName,
            });
            response = prepared.response;
            candidateNotice = prepared.notice;
          }
          if (forkHarnessRun) {
            await input.harnessStore?.bindRunSession(forkHarnessRun.runId, forkSessionId);
          }
          finalMessage = extractAgentResponseFinalMessage(response);
        } else {
          if (!input.submitCodexPrompt) {
            throw new Error("Codex chat is not connected for this bot mode.");
          }

          let response = await input.submitCodexPrompt({
            computerId: channelContext.computerId,
            ...(message.requestId ? { requestId: message.requestId } : {}),
            queueKey: forkThread.discordChannelId,
            payload: {
              workspaceRoot: forkThread.workspaceRoot,
              cwd: forkThread.cwd,
              prompt: forkPrompt,
              timeoutMs: resolveAgentPromptTimeoutMs(channelContext.timeoutMs),
              sessionId: sourceSessionId,
              forkSession: true,
              sessionName: forkThread.threadName,
              model: agentSettings.model,
              reasoningEffort: agentSettingsController.codexReasoningEffort(message.channelId, channelContext),
              controlKey: forkThread.discordChannelId,
              harnessBuilder: Boolean(forkHarnessBuild),
              ...(forkHarnessRun ? { harness: input.harnessStore?.workerBinding(forkHarnessRun) } : {}),
            },
            onProgress: async (event) => {
              if (event.type === "thread-started") {
                trackActiveForkSession(event.sessionId);
                await input.markDiscordRequestedCodexSession?.(event.sessionId, {
                  discordChannelId: forkThread?.discordChannelId ?? message.channelId,
                });
              }
            },
            onApprovalRequest: (request) => requestCodexApproval(replyWithRoleMentions, message.channelId, request),
            onUserInputRequest: (request) => requestCodexUserInput(reply, replyWithRoleMentions, message.channelId, request),
          });

          const failureMessage = forkResponseErrorMessage(response, "Codex");
          if (failureMessage) {
            throw new Error(failureMessage);
          }

          forkSessionId = extractAgentResponseSessionId(response);
          if (!forkSessionId) {
            throw new Error("Codex fork가 새 session ID를 반환하지 않았습니다.");
          }

          if (forkSessionId.toLowerCase() === sourceSessionId.toLowerCase()) {
            throw new Error("Codex fork가 원본과 같은 session ID를 반환해 연결을 중단했습니다.");
          }

          if (!input.linkNewCodexSession) {
            throw new Error("Codex fork session persistence is not connected for this bot mode.");
          }

          await input.linkNewCodexSession({
            discordChannelId: forkThread.discordChannelId,
            codexSessionId: forkSessionId,
            threadName: routed.name,
          });
          codexSessionIdsByChannel.set(forkThread.discordChannelId, forkSessionId);
          if (forkHarnessBuild) {
            await input.harnessStore?.bindBuilderSession(forkHarnessBuild.buildId, forkSessionId);
            const prepared = await prepareHarnessBuilderResponseWithRetries({
              build: forkHarnessBuild,
              response,
              provider: "codex",
              channelContext,
              settingsChannelId: message.channelId,
              queueKey: forkThread.discordChannelId,
              workspaceRoot: forkThread.workspaceRoot,
              cwd: forkThread.cwd,
              sessionId: forkSessionId,
              sessionName: forkThread.threadName,
            });
            response = prepared.response;
            candidateNotice = prepared.notice;
          }
          if (forkHarnessRun) {
            await input.harnessStore?.bindRunSession(forkHarnessRun.runId, forkSessionId);
          }
          finalMessage = extractAgentResponseFinalMessage(response);
        }

        try {
          await message.guild.sendTextMessage?.(
            forkThread.discordChannelId,
            formatForkedSessionThreadNotice({
              channelMode: forkThread.channelMode,
              sourceChannelId: message.channelId,
              sourceSessionId,
              forkSessionId,
              finalMessage,
            }),
            { mentionRoleIds: channelContext.allowedRoleIds },
          );
          const harnessForkNotice = [
            candidateNotice,
            forkHarnessRun
              ? formatHarnessRunReady({
                  ...forkHarnessRun,
                  status: "ready",
                  executionAgentSessionId: forkSessionId,
                })
              : null,
          ].filter(Boolean).join("\n\n");
          if (harnessForkNotice) {
            await message.guild.sendTextMessage?.(forkThread.discordChannelId, harnessForkNotice);
          }
        } catch (error) {
          console.warn("discord-bot failed to post the fork thread notice", error);
        }

        if (!isClaudeFork && forkSessionId) {
          try {
            await input.markDiscordRequestedCodexSession?.(forkSessionId, {
              discordChannelId: forkThread.discordChannelId,
              completionMentionSent: true,
            });
          } catch (error) {
            console.warn("discord-bot failed to record the fork completion delivery", error);
          }
        }

        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatForkSessionResult({
            result: forkThread,
            sourceSessionId,
            forkSessionId,
            finalMessage,
          }),
        );
      } catch (error) {
        if (forkHarnessBuild) {
          await input.harnessStore?.cancelBuild(
            forkHarnessBuild.buildId,
            error instanceof Error ? error.message : String(error),
          ).catch(() => undefined);
        }
        if (forkHarnessRun) {
          await input.harnessStore?.markRunStatus(
            forkHarnessRun.runId,
            "failed",
            error instanceof Error ? error.message : String(error),
          ).catch(() => undefined);
          await input.harnessStore?.removeChannelBinding(forkHarnessRun.executionDiscordChannelId).catch(() => false);
        }
        if (forkThread && message.guild && input.discardForkedSessionThread) {
          codexSessionIdsByChannel.delete(forkThread.discordChannelId);
          claudeSessionIdsByChannel.delete(forkThread.discordChannelId);

          try {
            await input.discardForkedSessionThread({
              guild: message.guild,
              discordChannelId: forkThread.discordChannelId,
            });
          } catch (cleanupError) {
            console.warn("discord-bot failed to clean up an unlinked fork thread", cleanupError);
          }
        }

        const messageText = error instanceof Error ? error.message : "Session fork failed";
        await updateQueuedReply(
          queuedReply,
          (replyMessage) => reply(replyMessage),
          formatForkSessionResult({ error: { message: messageText } }),
        );
      } finally {
        for (const sessionId of activeForkSessionIds) {
          input.setSessionStreaming?.(sessionId, false);
        }
      }
      return;
    }

    if (routed.type === "claude-chat") {
      if (channelContext.agentMain === "claude" && channelContext.discordDeliveryMode !== "thread") {
        // Sessions are managed per thread; the main channels only host the
        // session threads and shared notifications.
        await reply(formatAgentMainChannelGuidance({ agentLabel: "Claude Code" }));
        return;
      }

      const harnessBuild = await input.harnessStore?.buildForChannel(message.channelId) ?? null;
      const harnessRun = await input.harnessStore?.runForChannel(message.channelId) ?? null;
      if (harnessBuild?.status === "published") {
        await reply("이 Harness Builder는 이미 발행되었습니다. 새 버전은 `/harness create`로 별도 build를 시작하세요.");
        return;
      }
      if (harnessBuild && harnessBuild.provider !== "claude") {
        await reply("Harness Builder provider와 현재 Discord 채널 provider가 일치하지 않습니다.");
        return;
      }
      if (harnessRun && harnessRun.provider !== "claude") {
        await reply("Harness Run provider와 현재 Discord 채널 provider가 일치하지 않습니다.");
        return;
      }
      const userPrompt = routed.content;
      const nativeClaudeCompact = /^\/compact(?:\s|$)/i.test(userPrompt.trim());
      const prompt = nativeClaudeCompact
        ? userPrompt
        : harnessBuild
          ? harnessBuilderPrompt({ build: harnessBuild, userMessage: userPrompt })
          : harnessRun
            ? harnessExecutionPrompt({ run: harnessRun, userMessage: userPrompt })
            : userPrompt;
      const agentSettings = agentSettingsController.get(message.channelId, channelContext);
      const claudeMessage = {
        computerDisplayName: channelContext.computerDisplayName,
        workspaceDisplayName: channelContext.workspaceDisplayName,
        cwd: channelContext.cwd,
        prompt: userPrompt,
        agentLabel: "Claude Code",
      };

      if (!input.submitClaudePrompt) {
        await reply(
          formatAgentResultUpdate(claudeMessage, {
            error: { message: "Claude Code is not connected for this mode yet." },
          }),
        );
        return;
      }

      const queuedReply = await reply(formatAgentAck(claudeMessage));
      let recentEvents: string[] = [];
      let latestAgentMessage: string | null = null;
      let streamedSessionId =
        claudeSessionIdsByChannel.get(message.channelId) ?? channelContext.claudeSessionId ?? null;
      let sessionBindingError: Error | null = null;
      const progressReporter = createLiveProgressReporter({ message, channelContext, agentLabel: "Claude Code" });
      const harnessProgressReporter = harnessRun && message.guild
        ? createHarnessRunProgressReporter({ run: harnessRun, guild: message.guild })
        : null;
      const publishProgress = (event: AgentPromptProgressEvent) => harnessProgressReporter
        ? harnessProgressReporter.publish(event)
        : progressReporter.publish(event);

      try {
        if (harnessRun) {
          await input.harnessStore?.markRunStatus(harnessRun.runId, "running");
          await harnessProgressReporter?.start();
        }
        const response = await input.submitClaudePrompt({
          computerId: channelContext.computerId,
          ...(message.requestId ? { requestId: message.requestId } : {}),
          queueKey: message.channelId,
          payload: {
            workspaceRoot: channelContext.workspaceRoot,
            cwd: channelContext.cwd,
            prompt,
            timeoutMs: resolveAgentPromptTimeoutMs(channelContext.timeoutMs),
            controlKey: message.channelId,
            sessionId: streamedSessionId,
            model: agentSettings.model,
            effort: agentSettings.effort,
            harnessBuilder: Boolean(harnessBuild),
            ...(harnessRun ? { harness: input.harnessStore?.workerBinding(harnessRun) } : {}),
          },
          onProgress: async (event) => {
            touchChannelActivity(message.channelId);
            if (sessionBindingError) {
              return;
            }

            if (event.type === "thread-started") {
              try {
                streamedSessionId = bindChannelSessionId({
                  agentLabel: "Claude Code",
                  channelId: message.channelId,
                  currentSessionId: streamedSessionId,
                  candidateSessionId: event.sessionId,
                });
              } catch (error) {
                sessionBindingError = error instanceof Error ? error : new Error(String(error));
                console.error("discord-bot blocked a cross-channel Claude Code session event", sessionBindingError);
                return;
              }

              await publishProgress(event);
              recentEvents = appendProgressEvent(recentEvents, "생각중...");
              await updateQueuedReply(
                queuedReply,
                (replyMessage) => reply(replyMessage),
                formatAgentProgressUpdate(claudeMessage, {
                  status: "session opened",
                  sessionId: streamedSessionId,
                  recentEvents,
                }),
              );
              return;
            }

            if (event.type === "agent-message" && event.text?.trim()) {
              latestAgentMessage = event.text.trim();
              if (harnessBuild) {
                recentEvents = appendProgressEvent(recentEvents, "하네스 응답 검증 중...");
                await updateQueuedReply(
                  queuedReply,
                  (replyMessage) => reply(replyMessage),
                  formatAgentProgressUpdate(claudeMessage, {
                    status: "validating harness",
                    sessionId: streamedSessionId,
                    recentEvents,
                  }),
                );
                return;
              }
            }

            const status =
              event.type === "operation-progress"
                ? event.label
                : event.type === "agent-thought"
                  ? "생각 중"
                  : event.type;
            recentEvents = appendProgressEvent(recentEvents, readableProgressEvent(event));
            await publishProgress(event);
            await updateQueuedReply(
              queuedReply,
              (replyMessage) => reply(replyMessage),
              formatAgentProgressUpdate(claudeMessage, {
                status,
                sessionId: streamedSessionId,
                latestMessage:
                  event.type === "operation-progress"
                    ? event.detail
                    : event.type === "agent-message" || event.type === "agent-thought"
                      ? event.text
                      : undefined,
                recentEvents,
              }),
            );
          },
        });
        const responseSessionId = extractAgentResponseSessionId(response);

        if (sessionBindingError) {
          throw sessionBindingError;
        }

        if (responseSessionId) {
          streamedSessionId = bindChannelSessionId({
            agentLabel: "Claude Code",
            channelId: message.channelId,
            currentSessionId: streamedSessionId,
            candidateSessionId: responseSessionId,
          });
        }

        let responseForDisplay = withAgentMessageFallback(response, latestAgentMessage);
        let harnessNotice: string | null = null;
        if (harnessBuild) {
          const prepared = await prepareHarnessBuilderResponseWithRetries({
            build: harnessBuild,
            response: responseForDisplay,
            provider: "claude",
            channelContext,
            settingsChannelId: message.channelId,
            queueKey: message.channelId,
            workspaceRoot: channelContext.workspaceRoot,
            cwd: channelContext.cwd,
            sessionId: streamedSessionId,
            sessionName: null,
          });
          responseForDisplay = prepared.response;
          harnessNotice = prepared.notice;
        }
        await progressReporter.finish(extractAgentResponseFinalMessage(responseForDisplay));
        const responseFailed = promptResponseFailed(response);

        if (streamedSessionId) {
          await input.recordClaudeSession?.({
            discordChannelId: message.channelId,
            claudeSessionId: streamedSessionId,
          });
          claudeSessionIdsByChannel.set(message.channelId, streamedSessionId);
          if (harnessBuild) {
            await input.harnessStore?.bindBuilderSession(harnessBuild.buildId, streamedSessionId);
          }
          if (harnessRun) {
            await input.harnessStore?.bindRunSession(harnessRun.runId, streamedSessionId);
          }
        }

        if (harnessRun) {
          await input.harnessStore?.markRunStatus(
            harnessRun.runId,
            responseFailed ? "failed" : "ready",
            responseFailed ? extractAgentResponseFinalMessage(responseForDisplay) : null,
          );
        }

        const resultPayload = formatAgentResultUpdate(claudeMessage, responseForDisplay);
        const questionMentionSent = await updateQueuedResultReply({
          message,
          queuedReply,
          fallbackReply: (replyMessage) => reply(replyMessage),
          payload: resultPayload,
          postAsNewMessage: channelContext.discordDeliveryMode === "thread",
          terminalPayload: formatAgentResultPosted({ agentLabel: "Claude Code", failed: responseFailed }),
          questionMentionRoleIds: message.relayRequest ? [] : channelContext.allowedRoleIds,
        });
        await harnessProgressReporter?.finish(
          responseFailed ? "failed" : "completed",
          responseFailed ? extractAgentResponseFinalMessage(responseForDisplay) : null,
        );
        if (harnessNotice && harnessBuild) {
          const latestBuild = await input.harnessStore?.buildForChannel(message.channelId) ?? harnessBuild;
          await reply(formatHarnessBuilderNotice(harnessNotice, latestBuild));
        }
        await sendAgentRelayCallback({
          message,
          relayControlChannelId: input.relayControlChannelId,
          agentLabel: "Claude Code",
          response: responseForDisplay,
          resultPayload,
        });
        await sendThreadCompletionMention({
          message,
          channelContext,
          agentLabel: "Claude Code",
          failed: responseFailed,
          deferForPendingRequest: questionMentionSent,
          pendingRequestCount: channelPendingAgentRequestCount(message.channelId, channelContext),
        });
      } catch (error) {
        await progressReporter.finish();
        const messageText = error instanceof Error ? error.message : "Claude Code prompt failed";
        await harnessProgressReporter?.finish("failed", messageText);
        if (harnessRun) {
          await input.harnessStore?.markRunStatus(harnessRun.runId, "failed", messageText);
        }
        const failedResponse = { error: { message: messageText } };
        const resultPayload = formatAgentResultUpdate(claudeMessage, failedResponse);
        await updateQueuedResultReply({
          message,
          queuedReply,
          fallbackReply: (replyMessage) => reply(replyMessage),
          payload: resultPayload,
          postAsNewMessage: channelContext.discordDeliveryMode === "thread",
          terminalPayload: formatAgentResultPosted({ agentLabel: "Claude Code", failed: true }),
          questionMentionRoleIds: channelContext.allowedRoleIds,
        });
        await sendAgentRelayCallback({
          message,
          relayControlChannelId: input.relayControlChannelId,
          agentLabel: "Claude Code",
          response: failedResponse,
          resultPayload,
        });
        await sendThreadCompletionMention({
          message,
          channelContext,
          agentLabel: "Claude Code",
          failed: true,
        });
      }
      return;
    }

    if (routed.type === "codex-chat" || routed.type === "codex-continue-session") {
      if (
        routed.type === "codex-chat" &&
        channelContext.agentMain === "codex" &&
        channelContext.discordDeliveryMode !== "thread"
      ) {
        await reply(formatAgentMainChannelGuidance({ agentLabel: "Codex" }));
        return;
      }

      const harnessBuild = await input.harnessStore?.buildForChannel(message.channelId) ?? null;
      const harnessRun = await input.harnessStore?.runForChannel(message.channelId) ?? null;
      if (harnessBuild?.status === "published") {
        await reply("이 Harness Builder는 이미 발행되었습니다. 새 버전은 `/harness create`로 별도 build를 시작하세요.");
        return;
      }
      if (harnessBuild && harnessBuild.provider !== "codex") {
        await reply("Harness Builder provider와 현재 Discord 채널 provider가 일치하지 않습니다.");
        return;
      }
      if (harnessRun && harnessRun.provider !== "codex") {
        await reply("Harness Run provider와 현재 Discord 채널 provider가 일치하지 않습니다.");
        return;
      }
      const userPrompt = routed.content;
      const prompt = harnessBuild
        ? harnessBuilderPrompt({ build: harnessBuild, userMessage: userPrompt })
        : harnessRun
          ? harnessExecutionPrompt({ run: harnessRun, userMessage: userPrompt })
          : userPrompt;
      const agentSettings = agentSettingsController.get(message.channelId, channelContext);
      const codexMessage = {
        computerDisplayName: channelContext.computerDisplayName,
        workspaceDisplayName: channelContext.workspaceDisplayName,
        cwd: channelContext.cwd,
        prompt: userPrompt,
        permissionSettings: codexPermissionSettings(),
      };

      if (!input.submitCodexPrompt) {
        await reply(
          formatAgentResultUpdate(codexMessage, {
            error: { message: "Codex chat is not connected for this mode yet." },
          }),
        );
        return;
      }

      const queuedReply = await reply(formatAgentAck(codexMessage));
      const activeStreamingSessionIds = new Set<string>();
      let recentEvents: string[] = [];
      let latestAgentMessage: string | null = null;
      const progressReporter = createLiveProgressReporter({ message, channelContext, agentLabel: "Codex" });
      const harnessProgressReporter = harnessRun && message.guild
        ? createHarnessRunProgressReporter({ run: harnessRun, guild: message.guild })
        : null;
      const publishProgress = (event: AgentPromptProgressEvent) => harnessProgressReporter
        ? harnessProgressReporter.publish(event)
        : progressReporter.publish(event);

      try {
        if (harnessRun) {
          await input.harnessStore?.markRunStatus(harnessRun.runId, "running");
          await harnessProgressReporter?.start();
        }
        if (
          channelContext.channelMode === "session-linked" &&
          input.syncTranscriptUpdates &&
          message.guild
        ) {
          await input.syncTranscriptUpdates({
            guild: message.guild,
            discordChannelId: message.channelId,
            trigger: "on-chat",
            postUpdates: false,
          });
        }

        let streamedSessionId =
          routed.type === "codex-continue-session"
            ? routed.sessionId
            : codexSessionIdsByChannel.get(message.channelId) ?? channelContext.codexSessionId ?? null;
        let sessionBindingError: Error | null = null;

        if (streamedSessionId) {
          await input.markDiscordRequestedCodexSession?.(streamedSessionId, {
            discordChannelId: message.channelId,
          });

          if (input.setSessionStreaming) {
            input.setSessionStreaming(streamedSessionId, true);
            activeStreamingSessionIds.add(streamedSessionId);
          }
        }

        const response = await input.submitCodexPrompt({
          computerId: channelContext.computerId,
          ...(message.requestId ? { requestId: message.requestId, queueKey: message.channelId } : {}),
          payload: {
            workspaceRoot: channelContext.workspaceRoot,
            cwd: channelContext.cwd,
            prompt,
            timeoutMs: resolveAgentPromptTimeoutMs(channelContext.timeoutMs),
            sessionId: streamedSessionId,
            model: agentSettings.model,
            reasoningEffort: agentSettingsController.codexReasoningEffort(message.channelId, channelContext),
            controlKey: message.channelId,
            harnessBuilder: Boolean(harnessBuild),
            ...(harnessRun ? { harness: input.harnessStore?.workerBinding(harnessRun) } : {}),
          },
          onProgress: async (event) => {
            touchChannelActivity(message.channelId);
            if (sessionBindingError) {
              return;
            }

            if (event.type === "thread-started") {
              try {
                streamedSessionId = bindChannelSessionId({
                  agentLabel: "Codex",
                  channelId: message.channelId,
                  currentSessionId: streamedSessionId,
                  candidateSessionId: event.sessionId,
                });
              } catch (error) {
                sessionBindingError = error instanceof Error ? error : new Error(String(error));
                console.error("discord-bot blocked a cross-channel Codex session event", sessionBindingError);
                return;
              }

              recentEvents = appendProgressEvent(recentEvents, "생각중...");
              await input.markDiscordRequestedCodexSession?.(streamedSessionId, {
                discordChannelId: message.channelId,
              });
              if (input.setSessionStreaming && !activeStreamingSessionIds.has(streamedSessionId)) {
                input.setSessionStreaming(streamedSessionId, true);
                activeStreamingSessionIds.add(streamedSessionId);
              }
              await publishProgress(event);
              await updateQueuedReply(
                queuedReply,
                (replyMessage) => reply(replyMessage),
                formatAgentProgressUpdate(codexMessage, {
                  status: "session opened",
                  sessionId: streamedSessionId,
                  recentEvents,
                }),
              );
              return;
            }

            if (event.type === "agent-message") {
              if (event.text?.trim()) {
                latestAgentMessage = event.text.trim();
              }
              if (harnessBuild) {
                recentEvents = appendProgressEvent(recentEvents, "하네스 응답 검증 중...");
                await updateQueuedReply(
                  queuedReply,
                  (replyMessage) => reply(replyMessage),
                  formatAgentProgressUpdate(codexMessage, {
                    status: "validating harness",
                    sessionId: streamedSessionId,
                    recentEvents,
                  }),
                );
                return;
              }
              recentEvents = appendProgressEvent(recentEvents, readableProgressEvent(event));
              await publishProgress(event);
              await updateQueuedReply(
                queuedReply,
                (replyMessage) => reply(replyMessage),
                formatAgentProgressUpdate(codexMessage, {
                  status: "writing answer",
                  sessionId: streamedSessionId,
                  latestMessage: event.text,
                  recentEvents,
                }),
              );
              return;
            }

            if (event.type === "operation-progress") {
              recentEvents = appendProgressEvent(recentEvents, readableProgressEvent(event));
              await publishProgress(event);
              await updateQueuedReply(
                queuedReply,
                (replyMessage) => reply(replyMessage),
                formatAgentProgressUpdate(codexMessage, {
                  status: event.label,
                  sessionId: streamedSessionId,
                  latestMessage: event.detail,
                  recentEvents,
                }),
              );
              return;
            }

            recentEvents = appendProgressEvent(recentEvents, readableProgressEvent(event));
            await publishProgress(event);
            await updateQueuedReply(
              queuedReply,
              (replyMessage) => reply(replyMessage),
              formatAgentProgressUpdate(codexMessage, {
                status: event.eventType,
                sessionId: streamedSessionId,
                recentEvents,
              }),
            );
          },
          onApprovalRequest: (request) => requestCodexApproval(replyWithRoleMentions, message.channelId, request),
          onUserInputRequest: (request) => requestCodexUserInput(reply, replyWithRoleMentions, message.channelId, request),
        });
        const nextSessionId = extractAgentResponseSessionId(response);

        if (sessionBindingError) {
          throw sessionBindingError;
        }

        if (nextSessionId) {
          streamedSessionId = bindChannelSessionId({
            agentLabel: "Codex",
            channelId: message.channelId,
            currentSessionId: streamedSessionId,
            candidateSessionId: nextSessionId,
          });
        }

        let responseForDisplay = withAgentMessageFallback(response, latestAgentMessage);
        let harnessNotice: string | null = null;
        if (harnessBuild) {
          const prepared = await prepareHarnessBuilderResponseWithRetries({
            build: harnessBuild,
            response: responseForDisplay,
            provider: "codex",
            channelContext,
            settingsChannelId: message.channelId,
            queueKey: message.channelId,
            workspaceRoot: channelContext.workspaceRoot,
            cwd: channelContext.cwd,
            sessionId: streamedSessionId,
            sessionName: null,
          });
          responseForDisplay = prepared.response;
          harnessNotice = prepared.notice;
        }
        await progressReporter.finish(extractAgentResponseFinalMessage(responseForDisplay));

        if (nextSessionId && input.resolveCodexGoalStatus && !isIntermediateAgentResult(responseForDisplay)) {
          try {
            responseForDisplay = withCodexGoalStatus(
              responseForDisplay,
              await input.resolveCodexGoalStatus(nextSessionId),
            );
          } catch (error) {
            console.warn("discord-bot failed to resolve Codex goal status", error);
          }
        }

        const responseIntermediate = isIntermediateAgentResult(responseForDisplay);

        if (streamedSessionId) {
          if (
            routed.type === "codex-chat" &&
            channelContext.channelMode === "session-linked" &&
            !channelContext.codexSessionId &&
            input.linkNewCodexSession
          ) {
            await input.linkNewCodexSession({
              discordChannelId: message.channelId,
              codexSessionId: streamedSessionId,
              threadName: prompt.slice(0, 120) || "New Codex chat",
            });
          }

          if (routed.type === "codex-chat") {
            codexSessionIdsByChannel.set(message.channelId, streamedSessionId);
          }
          if (harnessBuild) {
            await input.harnessStore?.bindBuilderSession(harnessBuild.buildId, streamedSessionId);
          }
          if (harnessRun) {
            await input.harnessStore?.bindRunSession(harnessRun.runId, streamedSessionId);
          }
        }

        if (
          channelContext.channelMode === "session-linked" &&
          input.syncTranscriptUpdates &&
          message.guild
        ) {
          await input.syncTranscriptUpdates({
            guild: message.guild,
            discordChannelId: message.channelId,
            trigger: "on-chat",
            postUpdates: false,
          });
        }

        const responseFailed = promptResponseFailed(response);
        if (harnessRun) {
          await input.harnessStore?.markRunStatus(
            harnessRun.runId,
            responseFailed ? "failed" : "ready",
            responseFailed ? extractAgentResponseFinalMessage(responseForDisplay) : null,
          );
        }
        const resultPayload = formatAgentResultUpdate(codexMessage, responseForDisplay);
        const questionMentionSent = await updateQueuedResultReply({
          message,
          queuedReply,
          fallbackReply: (replyMessage) => reply(replyMessage),
          payload: resultPayload,
          postAsNewMessage: channelContext.discordDeliveryMode === "thread",
          terminalPayload: formatAgentResultPosted({
            agentLabel: "Codex",
            failed: responseFailed,
            intermediate: responseIntermediate,
          }),
          questionMentionRoleIds: message.relayRequest ? [] : channelContext.allowedRoleIds,
        });
        await harnessProgressReporter?.finish(
          responseFailed ? "failed" : "completed",
          responseFailed ? extractAgentResponseFinalMessage(responseForDisplay) : null,
        );
        if (harnessNotice && harnessBuild) {
          const latestBuild = await input.harnessStore?.buildForChannel(message.channelId) ?? harnessBuild;
          await reply(formatHarnessBuilderNotice(harnessNotice, latestBuild));
        }
        await sendAgentRelayCallback({
          message,
          relayControlChannelId: input.relayControlChannelId,
          agentLabel: "Codex",
          response: responseForDisplay,
          resultPayload,
        });
        const completionDelivery = await sendThreadCompletionMention({
          message,
          channelContext,
          agentLabel: "Codex",
          failed: responseFailed,
          intermediate: responseIntermediate,
          deferForPendingRequest: questionMentionSent,
          pendingRequestCount: channelPendingAgentRequestCount(message.channelId, channelContext),
        });

        if (nextSessionId) {
          if (completionDelivery !== "unavailable") {
            await input.markDiscordRequestedCodexSession?.(nextSessionId, {
              discordChannelId: message.channelId,
              completionMentionSent: true,
            });
          } else {
            await input.markDiscordRequestedCodexSession?.(nextSessionId, {
              discordChannelId: message.channelId,
            });
          }
        }
      } catch (error) {
        await progressReporter.finish();
        await harnessProgressReporter?.finish(
          "failed",
          error instanceof Error ? error.message : "Codex prompt failed",
        );
        if (
          channelContext.channelMode === "session-linked" &&
          input.syncTranscriptUpdates &&
          message.guild
        ) {
          await input.syncTranscriptUpdates({
            guild: message.guild,
            discordChannelId: message.channelId,
            trigger: "on-chat",
            postUpdates: false,
          });
        }

        const messageText = error instanceof Error ? error.message : "Codex prompt failed";
        if (harnessRun) {
          await input.harnessStore?.markRunStatus(harnessRun.runId, "failed", messageText);
        }
        const failedResponse = { error: { message: messageText } };
        const resultPayload = formatAgentResultUpdate(codexMessage, failedResponse);
        await updateQueuedResultReply({
          message,
          queuedReply,
          fallbackReply: (replyMessage) => reply(replyMessage),
          payload: resultPayload,
          postAsNewMessage: channelContext.discordDeliveryMode === "thread",
          terminalPayload: formatAgentResultPosted({ agentLabel: "Codex", failed: true }),
          questionMentionRoleIds: channelContext.allowedRoleIds,
        });
        await sendAgentRelayCallback({
          message,
          relayControlChannelId: input.relayControlChannelId,
          agentLabel: "Codex",
          response: failedResponse,
          resultPayload,
        });
        await sendThreadCompletionMention({
          message,
          channelContext,
          agentLabel: "Codex",
          failed: true,
        });
      } finally {
        for (const sessionId of activeStreamingSessionIds) {
          input.setSessionStreaming?.(sessionId, false);
        }
      }
      return;
    }

    if (routed.type === "denied") {
      await reply(formatDenied(routed.reason));
      return;
    }

    if (routed.type === "blocked-command") {
      await reply(formatBlockedCommand(routed));
      return;
    }

    const commandMessage = {
      computerDisplayName: channelContext.computerDisplayName,
      workspaceDisplayName: channelContext.workspaceDisplayName,
      cwd: channelContext.cwd,
      command: routed.command,
      channelMode: channelContext.channelMode,
    };
    const queuedReply = await reply(formatCommandAck(commandMessage));

    try {
      const response = await input.submitCommandJob({
        computerId: channelContext.computerId,
        ...(message.requestId ? { requestId: message.requestId, queueKey: message.channelId } : {}),
        payload: {
          workspaceRoot: channelContext.workspaceRoot,
          cwd: channelContext.cwd,
          command: routed.command,
          timeoutMs: channelContext.timeoutMs,
          confirmedDangerous: routed.confirmedDangerous,
        },
      });
      await recordCommandAudit(input, {
        discordChannelId: message.channelId,
        userId: message.userId,
        cwd: channelContext.cwd,
        rawCommand: routed.command,
        resultStatus: extractResultStatus(response),
      });

      const nextCwd = extractUpdatedCwd(response);

      if (nextCwd) {
        await input.updateChannelCwd({
          discordChannelId: message.channelId,
          cwd: nextCwd,
        });
      }

      await updateQueuedReply(
        queuedReply,
        (replyMessage) => reply(replyMessage),
        formatCommandResultUpdate(commandMessage, response),
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Control API request failed";
      await recordCommandAudit(input, {
        discordChannelId: message.channelId,
        userId: message.userId,
        cwd: channelContext.cwd,
        rawCommand: routed.command,
        resultStatus: "failed",
      });
      await updateQueuedReply(
        queuedReply,
        (replyMessage) => reply(replyMessage),
        formatCommandResultUpdate(commandMessage, { error: { message: messageText } }),
      );
    }
  }

  async function prepareIncomingAttachments(
    incomingMessage: DiscordMessageLike,
  ): Promise<DiscordMessageLike | null> {
    const attachments = incomingMessage.attachments ?? [];
    if (attachments.length === 0 || incomingMessage.restoreOnly) {
      return incomingMessage;
    }

    const channelContext = await input.resolveChannelContext(incomingMessage.channelId);
    if (!channelContext) {
      return incomingMessage;
    }

    if (!hasAllowedRole(incomingMessage.roleIds, channelContext.allowedRoleIds)) {
      return incomingMessage;
    }

    const defaultPrompt = "첨부된 파일을 확인해줘.";
    let messageWithPrompt = {
      ...incomingMessage,
      content: incomingMessage.content.trim() || defaultPrompt,
    };
    let routed = routeMessage(messageWithPrompt, channelContext);

    if (channelContext.channelMode === "shell-admin" && routed.type === "execute-command") {
      messageWithPrompt = {
        ...messageWithPrompt,
        content: `codex ${messageWithPrompt.content}`,
      };
      routed = routeMessage(messageWithPrompt, channelContext);
    }

    if (!acceptsIncomingAttachments(routed.type)) {
      await incomingMessage.reply(
        "첨부파일은 Codex 또는 Claude Code 요청에만 전달할 수 있습니다. " +
        "관리자 채널에서는 `codex <요청>` 또는 `claude <요청>` 형식으로 보내주세요.",
      );
      return null;
    }

    if (!input.materializeIncomingAttachments) {
      await incomingMessage.reply("이 봇 실행 모드에는 Discord 첨부파일 저장 기능이 연결되어 있지 않습니다.");
      return null;
    }

    try {
      const materialized = await input.materializeIncomingAttachments({
        messageId:
          incomingMessage.messageId ??
          incomingMessage.requestId ??
          `${incomingMessage.channelId}-${Date.now()}`,
        attachments,
        content: messageWithPrompt.content,
      });

      return {
        ...messageWithPrompt,
        content: materialized.content,
        attachments: [],
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "알 수 없는 첨부파일 저장 오류";
      await incomingMessage.reply(`첨부파일을 저장하지 못했습니다: ${messageText}`);
      return null;
    }
  }

  const handleDiscordMessage = async (incomingMessage: DiscordMessageLike): Promise<void> => {
    if (incomingMessage.authorBot && !incomingMessage.relayRequest) {
      return;
    }

    if (incomingMessage.relayCancelRequestId) {
      await cancelRelayRequest(incomingMessage);
      return;
    }

    if (incomingMessage.relayRequest) {
      const relayChannelContext = await input.resolveChannelContext(incomingMessage.channelId);
      if (!relayChannelContext || relayChannelContext.channelMode === "shell-admin") {
        return;
      }
    }

    const message = await prepareIncomingAttachments(incomingMessage);
    if (!message) {
      return;
    }

    if (!message.authorBot && input.resolveRelayPresence) {
      const presence = await input.resolveRelayPresence(message.channelId);
      if (presence) {
        const relayChannelContext = await input.resolveChannelContext(message.channelId);
        if (relayChannelContext) {
          const routed = routeMessage(message, relayChannelContext);
          const agentRequest =
            routed.type === "codex-chat" ||
            routed.type === "codex-continue-session" ||
            routed.type === "codex-review" ||
            routed.type === "claude-chat";
          if (
            agentRequest &&
            hasAllowedRole(message.roleIds, relayChannelContext.allowedRoleIds) &&
            presence.activeThreadId !== message.channelId
          ) {
            await message.reply(relayWaitingMessage(input.locale, presence.activeThreadId));
            return;
          }
        }
      }
    }

    const immediateControl = Boolean(
      parseCodexApprovalResponse(message.content) ||
      parseCodexUserInputSelection(message.content) ||
      isImmediateQueueControl(message.content) ||
      (channelWaitingForUserInput(message.channelId) && isCodexUserInputReply(message.content)),
    );

    if ((deferredRestartRequested || restartScheduled) && !immediateControl) {
      await message.reply(formatRestartDrainPending());
      return;
    }

    if (immediateControl) {
      await processDiscordMessage(message);
      return;
    }

    let queue = channelQueues.get(message.channelId);
    let queuedMessage = message;

    if (queue?.activeMessage || isExplicitQueuePrompt(message.content)) {
      const channelContext = await input.resolveChannelContext(message.channelId);

      if (!channelContext) {
        return;
      }

      const routed = routeMessage(message, channelContext);

      if (routed.type === "queue-prompt") {
        queuedMessage = { ...message, content: routed.content };
      } else if (queue?.activeMessage) {
        const sameRequestKind = queue.activeMessage.relayRequest === message.relayRequest;
        const userInterveningInRelay =
          queue.activeMessage.relayRequest === true &&
          !message.relayRequest &&
          !message.authorBot;
        if (
          (sameRequestKind || userInterveningInRelay) &&
          await tryAutoSteerAgentTurn(message, channelContext, queue)
        ) {
          return;
        }
      }
    }

    if (!queuedMessage.requestId && input.persistDurableRequest) {
      const channelContext = await input.resolveChannelContext(queuedMessage.channelId);

      if (!channelContext) {
        return;
      }

      const routed = routeMessage(queuedMessage, channelContext);
      if (isDurableAgentRequest(routed.type)) {
        const persisted = await input.persistDurableRequest({
          channelId: queuedMessage.channelId,
          userId: queuedMessage.userId,
          content: queuedMessage.content,
          roleIds: queuedMessage.roleIds,
          authorBot: queuedMessage.authorBot,
          messageId: queuedMessage.messageId,
          relayRequest: queuedMessage.relayRequest,
          createdAt: queuedMessage.durableQueuedAt,
        });
        queuedMessage = {
          ...queuedMessage,
          requestId: persisted.requestId,
          durableQueuedAt: persisted.createdAt,
        };
      }
    }

    if (!queue) {
      queue = {
        running: false,
        activeMessage: null,
        activeStartedAt: null,
        activeLastActivityAt: null,
        pending: [],
      };
      channelQueues.set(message.channelId, queue);
    }

    if (queuedMessage.restoreOnly) {
      queue.pending.push({
        message: queuedMessage,
        resolve: () => undefined,
        reject: (error) => console.error(
          `discord-bot failed to run restored request ${queuedMessage.requestId ?? "unknown"}`,
          error,
        ),
      });
      queue.pending.sort((left, right) =>
        (left.message.durableQueuedAt ?? "").localeCompare(right.message.durableQueuedAt ?? ""),
      );
      return;
    }

    await new Promise<void>((resolve, reject) => {
      queue?.pending.push({ message: queuedMessage, resolve, reject });
      queue?.pending.sort((left, right) =>
        (left.message.durableQueuedAt ?? "").localeCompare(right.message.durableQueuedAt ?? ""),
      );
      void drainChannelQueue(message.channelId, queue as ChannelQueue);
    });
  };

  handleDiscordMessage.drainRestoredMessages = () => {
    for (const [channelId, queue] of channelQueues) {
      void drainChannelQueue(channelId, queue);
    }
  };

  return handleDiscordMessage;

  async function drainChannelQueue(channelId: string, queue: ChannelQueue): Promise<void> {
    if (queue.running) {
      return;
    }

    queue.running = true;

    try {
      while (queue.pending.length > 0) {
        const entry = queue.pending.shift();

        if (!entry) {
          continue;
        }

        queue.activeMessage = entry.message;
        queue.activeStartedAt = Date.now();
        queue.activeLastActivityAt = queue.activeStartedAt;

        let completed = false;
        try {
          await processDiscordMessage(entry.message);
          completed = true;
          entry.resolve();
        } catch (error) {
          entry.reject(error);
        } finally {
          if (completed) {
            await completeDurableMessage(entry.message);
          }
          queue.activeMessage = null;
          queue.activeStartedAt = null;
          queue.activeLastActivityAt = null;
        }
      }
    } finally {
      queue.running = false;
      if (queue.pending.length === 0 && channelQueues.get(channelId) === queue) {
        channelQueues.delete(channelId);
      }

      await restartAfterQueueDrain();
    }
  }
}

function queueMessageSummary(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized || "(empty message)";
}

function isImmediateQueueControl(content: string): boolean {
  const normalized = content.replace(/\s+/g, " ").trim().replace(/^\/+/, "");
  return /^(?:where|status|context|target|pwd\?|queue-clear|clear-queue|interrupt|stop-current)(?:\s|$)/i.test(normalized)
    || /^(?:queue|queue-status)$/i.test(normalized)
    || /^(?:bot )?reload restart force confirm$/i.test(normalized)
    || /^steer\s+\S/i.test(normalized);
}

function isExplicitQueuePrompt(content: string): boolean {
  return /^\/*queue\s+prompt\s*:\s*\S/i.test(content.trim());
}

function isCodexUserInputReply(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length > 0 && !trimmed.startsWith("/") && !isImmediateQueueControl(trimmed);
}

function isDurableAgentRequest(type: string): boolean {
  return type === "execute-command" ||
    type === "codex-chat" ||
    type === "codex-continue-session" ||
    type === "codex-review" ||
    type === "claude-chat" ||
    type === "harness-command";
}

function acceptsIncomingAttachments(type: string): boolean {
  return type === "codex-chat" ||
    type === "codex-continue-session" ||
    type === "codex-review" ||
    type === "claude-chat" ||
    type === "codex-steer" ||
    type === "queue-prompt";
}
