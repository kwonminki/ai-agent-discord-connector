import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  extractAgentRelayDecision,
  splitDiscordMessageContent,
} from "../../../packages/core/src/index.js";
export { splitDiscordMessageContent } from "../../../packages/core/src/index.js";
import {
  agentSurveyOtherCustomId,
  COMPONENT_IDS,
} from "./componentRouter.js";
import { extractAgentSurveyRequests, type AgentSurveyRequest } from "./agentSurvey.js";
import type { ScheduledCommandState, TranscriptSyncMode } from "./directState.js";
import {
  MAX_DISCORD_ATTACHMENT_BYTES,
  MAX_DISCORD_ATTACHMENT_LABEL,
  MAX_DISCORD_FILES,
} from "./discordAttachmentLimits.js";
import type { ScheduleCommandResult } from "./scheduler.js";

const COLORS = {
  queued: 0xf1c40f,
  codex: 0x3498db,
  neutral: 0x95a5a6,
  success: 0x2ecc71,
  failure: 0xe74c3c,
} as const;

const BUTTON_STYLES = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
} as const;

const MAX_FIELD_VALUE_LENGTH = 1_024;
const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;
const MAX_MESSAGE_CONTENT_LENGTH = 1_900;
const ATTACH_TEXT_THRESHOLD = 1_000;
export const AGENT_PROGRESS_EVENT_LIMIT = 16;

type ChannelMode = "shell-admin" | "session-linked" | "claude-code";

export interface DiscordEmbedFieldPayload {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedPayload {
  title: string;
  color: number;
  description?: string;
  fields?: DiscordEmbedFieldPayload[];
}

export interface DiscordMessagePayload {
  allowedMentions: {
    parse: [];
    roles?: string[];
  };
  content?: string;
  ephemeral?: boolean;
  embeds: DiscordEmbedPayload[];
  components?: DiscordActionRowPayload[];
  files?: DiscordFilePayload[];
}

export interface AgentProgressMessageInput {
  computerDisplayName: string;
  workspaceDisplayName: string;
  cwd: string;
  prompt: string;
  agentLabel?: string;
  permissionSettings?: CodexPermissionSettings;
}

export interface CodexPermissionSettings {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: string;
  networkAccess: string;
}

export interface CodexApprovalRequestMessage {
  title: string;
  message: string;
  kind: string;
  sessionId: string | null;
  cwd?: string | null;
  command?: string | null;
  reason?: string | null;
  details?: Array<{ name: string; value: string }>;
}

export interface CodexUserInputQuestionMessage {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface AgentProgressState {
  status: string;
  sessionId?: string | null;
  latestMessage?: string | null;
  recentEvents?: string[];
}

const agentResultContinuationMessages = new WeakMap<DiscordMessagePayload, DiscordMessagePayload[]>();
const answerCopyTextByPayload = new WeakMap<DiscordMessagePayload, string>();
const agentQuestionPayloads = new WeakSet<DiscordMessagePayload>();

export interface DiscordFilePayload {
  attachment: string | Buffer;
  name?: string;
}

export interface DiscordButtonPayload {
  type: 2;
  custom_id: string;
  label: string;
  style: number;
}

export interface DiscordSelectOptionPayload {
  label: string;
  value: string;
  description?: string;
}

export interface DiscordSelectMenuPayload {
  type: 3;
  custom_id: string;
  placeholder: string;
  min_values: number;
  max_values: number;
  options: DiscordSelectOptionPayload[];
}

export interface DiscordActionRowPayload {
  type: 1;
  components: Array<DiscordButtonPayload | DiscordSelectMenuPayload>;
}

interface FileBrowserUiPayload {
  kind: "file-browser";
  page: number;
  pageSize: number;
  totalEntries: number;
  entries: Array<{
    name: string;
    kind: "directory" | "file" | "other";
  }>;
}

interface FileCardUiPayload {
  kind: "file-card";
  path: string;
  preview: string;
}

type CommandUiPayload = FileBrowserUiPayload | FileCardUiPayload;

function sanitizeInlineDiscordText(value: string): string {
  return value.replace(/\r?\n+/g, " ").replace(/`/g, "'").replace(/@/g, "[at]");
}

function sanitizeBlockDiscordText(value: string): string {
  return value.replace(/```/g, "'''").replace(/`/g, "'").replace(/@/g, "[at]").trimEnd();
}

function sanitizeDiscordMarkdown(value: string): string {
  return value.replace(/@/g, "[at]").trimEnd();
}

function wrapDiscordText(value: string): string {
  return `\`${sanitizeInlineDiscordText(value)}\``;
}

function truncateFieldValue(value: string): string {
  if (value.length <= MAX_FIELD_VALUE_LENGTH) {
    return value;
  }

  const suffix = "\n... (일부만 표시)";
  return `${value.slice(0, MAX_FIELD_VALUE_LENGTH - suffix.length)}${suffix}`;
}

function truncateDescription(value: string): string {
  if (value.length <= MAX_EMBED_DESCRIPTION_LENGTH) {
    return value;
  }

  const suffix = "\n\n... (일부만 표시)";
  return `${value.slice(0, MAX_EMBED_DESCRIPTION_LENGTH - suffix.length)}${suffix}`;
}

function truncateMessageContent(value: string): string {
  if (value.length <= MAX_MESSAGE_CONTENT_LENGTH) {
    return value;
  }

  const suffix = "\n\n... (일부만 표시)";
  return `${value.slice(0, MAX_MESSAGE_CONTENT_LENGTH - suffix.length)}${suffix}`;
}

export function getAgentResultContinuationMessages(
  payload: DiscordMessagePayload,
): DiscordMessagePayload[] {
  return [...(agentResultContinuationMessages.get(payload) ?? [])];
}

export function appendAgentResultContinuationMessages(
  payload: DiscordMessagePayload,
  continuations: DiscordMessagePayload[],
): void {
  if (continuations.length === 0) {
    return;
  }

  agentResultContinuationMessages.set(payload, [
    ...(agentResultContinuationMessages.get(payload) ?? []),
    ...continuations,
  ]);
}

export function isAgentQuestionMessage(payload: DiscordMessagePayload): boolean {
  return agentQuestionPayloads.has(payload);
}

export function registerAnswerCopyText(payload: DiscordMessagePayload, answer: string): void {
  const normalized = answer.trimEnd();

  if (normalized.length > 0) {
    answerCopyTextByPayload.set(payload, normalized);
  }
}

export function getAnswerCopyText(payload: DiscordMessagePayload): string | null {
  return answerCopyTextByPayload.get(payload) ?? null;
}

export function withAnswerCopyButton(payload: DiscordMessagePayload, copyId: string): DiscordMessagePayload {
  const customId = `${COMPONENT_IDS.answerCopyPrefix}${copyId}`;
  const rows = payload.components ?? [];

  if (rows.some((row) => row.components.some((component) => "custom_id" in component && component.custom_id === customId))) {
    return payload;
  }

  const copyButton = button({
    customId,
    label: "답변 복사",
    style: BUTTON_STYLES.secondary,
  });
  const compatibleRow = rows.find((row) =>
    row.components.length < 5 && row.components.every((component) => component.type === 2),
  );

  if (compatibleRow) {
    compatibleRow.components.push(copyButton);
  } else {
    payload.components = [...rows, actionRow([copyButton])];
  }

  return payload;
}

export function discordFileOnlyPayloads(files: DiscordFilePayload[]): DiscordMessagePayload[] {
  const payloads: DiscordMessagePayload[] = [];

  for (let index = 0; index < files.length; index += MAX_DISCORD_FILES) {
    payloads.push({
      allowedMentions: { parse: [] },
      embeds: [],
      files: files.slice(index, index + MAX_DISCORD_FILES),
    });
  }

  return payloads;
}

export function resolveDiscordFileAttachments(references: unknown[]): {
  attachments: DiscordFilePayload[];
  notices: string[];
} {
  const attachments: DiscordFilePayload[] = [];
  const notices: string[] = [];
  const seenPaths = new Set<string>();

  for (const rawReference of references) {
    const reference = normalizeCodexSendFileReference(rawReference);

    if (!reference) {
      notices.push("절대경로 또는 file:// URL인 첨부 파일만 처리했습니다.");
      continue;
    }

    if (seenPaths.has(reference.filePath)) {
      continue;
    }

    seenPaths.add(reference.filePath);
    const result = codexSendFileAttachment(reference);

    if (result.attachment) {
      attachments.push(result.attachment);
    }

    if (result.notice) {
      notices.push(result.notice);
    }
  }

  return { attachments, notices };
}

export function formatAgentSurveyMessages(input: {
  agent: "codex" | "claude";
  survey: AgentSurveyRequest;
  response:
    | { kind: "followup" }
    | { kind: "user-input"; token: string; context?: string | null };
}): DiscordMessagePayload[] {
  const fileOutputs = resolveDiscordFileAttachments(input.survey.files);
  const optionPayloads = input.survey.options.map((option, index) => {
    const label = sanitizeInlineDiscordText(option.label).slice(0, 90);
    return {
      label,
      value: `${index}:${label}`,
      ...(option.description
        ? { description: sanitizeInlineDiscordText(option.description).slice(0, 100) }
        : {}),
    };
  });
  const customId = input.response.kind === "user-input"
    ? `${COMPONENT_IDS.codexUserInputSurveyPrefix}${input.response.token}`
    : `${COMPONENT_IDS.agentSurveyPrefix}${input.agent}`;
  const otherCustomId = agentSurveyOtherCustomId(
    input.response.kind === "user-input"
      ? { kind: "user-input", token: input.response.token }
      : { kind: "agent", agent: input.agent },
  );
  const details = [
    input.response.kind === "user-input" ? input.response.context : null,
    input.survey.message,
    `**${sanitizeDiscordMarkdown(input.survey.question)}**`,
    ...fileOutputs.notices.map((notice) => `주의: ${notice}`),
    input.response.kind === "user-input"
      ? "선택 메뉴 또는 이 스레드의 일반 메시지로 답할 수 있습니다."
      : "선택하면 같은 agent 세션의 다음 작업으로 전달됩니다.",
  ].filter((line): line is string => Boolean(line?.trim()));
  const payload: DiscordMessagePayload = {
    allowedMentions: { parse: [] },
    embeds: [{
      title: input.response.kind === "user-input" ? "Agent 질문" : "미디어 설문",
      color: input.agent === "claude" ? 0x8e44ad : COLORS.codex,
      description: truncateDescription(details.join("\n\n")),
    }],
    components: [
      actionRow([{
        type: 3,
        custom_id: customId,
        placeholder: input.survey.multiple ? "하나 이상 선택" : "하나 선택",
        min_values: 1,
        max_values: input.survey.multiple ? optionPayloads.length : 1,
        options: optionPayloads,
      }]),
      actionRow([{
        type: 2,
        custom_id: otherCustomId,
        label: "기타...",
        style: BUTTON_STYLES.secondary,
      }]),
    ],
    ...(fileOutputs.attachments.length > 0
      ? { files: fileOutputs.attachments.slice(0, MAX_DISCORD_FILES) }
      : {}),
  };
  agentQuestionPayloads.add(payload);

  return [
    payload,
    ...discordFileOnlyPayloads(fileOutputs.attachments.slice(MAX_DISCORD_FILES)),
  ];
}

export function formatAgentSurveySelectionResult(input: {
  accepted: boolean;
  answers: string[];
}): DiscordMessagePayload {
  return messagePayload({
    title: input.accepted ? "설문 응답 전달됨" : "설문 응답 만료됨",
    color: input.accepted ? COLORS.success : COLORS.failure,
    description: input.accepted
      ? input.answers.map((answer) => `- ${sanitizeDiscordMarkdown(answer)}`).join("\n")
      : "현재 실행 중인 질문과 연결되지 않습니다. 필요하면 agent에게 다시 질문을 요청하세요.",
  });
}

function codeBlock(value: string, language: string): string {
  const sanitizedValue = sanitizeBlockDiscordText(value);
  const body = sanitizedValue.length > 0 ? sanitizedValue : "(no output)";
  const fence = `\`\`\`${language}\n`;
  const closingFence = "\n```";
  const availableBodyLength = MAX_FIELD_VALUE_LENGTH - fence.length - closingFence.length;
  const clippedBody =
    body.length <= availableBodyLength
      ? body
      : `${body.slice(0, availableBodyLength - "\n... (일부만 표시)".length)}\n... (일부만 표시)`;

  return `${fence}${clippedBody}${closingFence}`;
}

function textAttachment(name: string, content: string): DiscordFilePayload {
  return {
    attachment: Buffer.from(content, "utf8"),
    name,
  };
}

function previewCodeBlockWithAttachmentNotice(input: {
  value: string;
  language: string;
  attachmentName: string;
  label: string;
}): string {
  const notice = `\n${input.label}은 첨부 파일 \`${input.attachmentName}\`에서 확인하세요.`;
  const sanitizedValue = sanitizeBlockDiscordText(input.value);
  const fence = `\`\`\`${input.language}\n`;
  const closingFence = "\n```";
  const maxBodyLength = Math.max(0, MAX_FIELD_VALUE_LENGTH - fence.length - closingFence.length - notice.length);
  const previewBody = sanitizedValue.length <= maxBodyLength ? sanitizedValue : sanitizedValue.slice(0, maxBodyLength).trimEnd();

  return `${fence}${previewBody || "(no output)"}${closingFence}${notice}`;
}

function messagePayload(embed: DiscordEmbedPayload, components?: DiscordActionRowPayload[]): DiscordMessagePayload {
  const payload: DiscordMessagePayload = {
    allowedMentions: { parse: [] },
    embeds: [embed],
  };

  if (components && components.length > 0) {
    payload.components = components;
  }

  return payload;
}

function uniqueRoleIds(roleIds: Iterable<string>): string[] {
  return [...new Set([...roleIds].map((roleId) => roleId.trim()).filter(Boolean))];
}

function roleMentionLine(roleIds: string[]): string {
  return roleIds.map((roleId) => `<@&${roleId}>`).join(" ");
}

export function withRoleMentions(
  message: string | DiscordMessagePayload,
  roleIds: Iterable<string>,
): string | DiscordMessagePayload {
  const uniqueRoles = uniqueRoleIds(roleIds);

  if (uniqueRoles.length === 0) {
    return message;
  }

  const mentionLine = roleMentionLine(uniqueRoles);

  if (typeof message === "string") {
    return {
      allowedMentions: { parse: [], roles: uniqueRoles },
      content: message.trim().length > 0 ? `${mentionLine}\n${message}` : mentionLine,
      embeds: [],
    };
  }

  if (message.ephemeral) {
    return message;
  }

  message.allowedMentions = {
    ...message.allowedMentions,
    roles: uniqueRoles,
  };

  if (!message.content?.startsWith(mentionLine)) {
    message.content = message.content ? `${mentionLine}\n${message.content}` : mentionLine;
  }

  return message;
}

function isImageReference(value: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(value);
}

function isLocalMediaAttachmentReference(value: string): boolean {
  return /\.(?:mp4|mov|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg)(?:[?#].*)?$/i.test(value);
}

function normalizeLocalImagePath(reference: string): string | null {
  if (reference.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(reference).pathname);
    } catch {
      return null;
    }
  }

  return path.isAbsolute(reference) ? reference : null;
}

function normalizeLocalAttachmentPath(reference: string): string | null {
  if (reference.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(reference).pathname);
    } catch {
      return null;
    }
  }

  return path.isAbsolute(reference) ? reference : null;
}

function sanitizeDiscordFileName(name: string): string | null {
  const cleaned = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 128) : null;
}

function normalizeCodexSendFileReference(value: unknown): { filePath: string; name: string | null } | null {
  if (typeof value === "string") {
    const filePath = normalizeLocalAttachmentPath(value.trim());
    return filePath ? { filePath, name: null } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawPath = record.path ?? record.file ?? record.attachment;

  if (typeof rawPath !== "string") {
    return null;
  }

  const filePath = normalizeLocalAttachmentPath(rawPath.trim());

  if (!filePath) {
    return null;
  }

  const rawName = record.name;
  const name = typeof rawName === "string" ? sanitizeDiscordFileName(rawName) : null;

  return { filePath, name };
}

function codexSendFileAttachment(
  reference: { filePath: string; name: string | null },
): { attachment: DiscordFilePayload | null; notice: string | null } {
  if (!existsSync(reference.filePath)) {
    return { attachment: null, notice: `첨부 파일을 찾지 못했습니다: ${reference.filePath}` };
  }

  let stat;

  try {
    stat = statSync(reference.filePath);
  } catch {
    return { attachment: null, notice: `첨부 파일 상태를 읽지 못했습니다: ${reference.filePath}` };
  }

  if (!stat.isFile()) {
    return { attachment: null, notice: `일반 파일만 첨부할 수 있습니다: ${reference.filePath}` };
  }

  if (stat.size > MAX_DISCORD_ATTACHMENT_BYTES) {
    const sizeMb = Math.ceil(stat.size / 1024 / 1024);
    return {
      attachment: null,
      notice: `첨부 파일이 너무 큽니다: ${reference.filePath} (${sizeMb}MiB, 최대 ${MAX_DISCORD_ATTACHMENT_LABEL})`,
    };
  }

  return {
    attachment: {
      attachment: reference.filePath,
      name: reference.name ?? (path.basename(reference.filePath) || "codex-file"),
    },
    notice: null,
  };
}

function fileReferencesFromCodexSendPayload(payload: Record<string, unknown>): unknown[] {
  const values = [payload.files, payload.attachments, payload.file].filter((value) => value !== undefined);
  const references: unknown[] = [];

  for (const value of values) {
    if (Array.isArray(value)) {
      references.push(...value);
    } else {
      references.push(value);
    }
  }

  return references;
}

export function extractCodexDiscordSendOutputs(text: string): {
  cleanedText: string;
  attachments: DiscordFilePayload[];
  messages: string[];
  notices: string[];
  hadBlocks: boolean;
} {
  const attachments: DiscordFilePayload[] = [];
  const messages: string[] = [];
  const notices: string[] = [];
  const seenPaths = new Set<string>();
  const blocks: string[] = [];
  const blockPattern = /```(?:codex-discord-send|discord-send)\s*([\s\S]*?)```/gi;

  for (const match of text.matchAll(blockPattern)) {
    const block = match[0] ?? "";
    const rawJson = (match[1] ?? "").trim();
    blocks.push(block);

    let parsed: unknown;

    try {
      parsed = JSON.parse(rawJson);
    } catch {
      notices.push("codex-discord-send 블록의 JSON을 읽지 못했습니다.");
      continue;
    }

    const payloads = Array.isArray(parsed) ? parsed : [parsed];

    for (const payload of payloads) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        notices.push("codex-discord-send 항목은 JSON object여야 합니다.");
        continue;
      }

      const record = payload as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message.trim() : "";

      if (message) {
        messages.push(message);
      }

      for (const rawReference of fileReferencesFromCodexSendPayload(record)) {
        const reference = normalizeCodexSendFileReference(rawReference);

        if (!reference) {
          notices.push("절대경로 또는 file:// URL인 첨부 파일만 처리했습니다.");
          continue;
        }

        if (seenPaths.has(reference.filePath)) {
          continue;
        }

        seenPaths.add(reference.filePath);
        const result = codexSendFileAttachment(reference);

        if (result.attachment) {
          attachments.push(result.attachment);
        }

        if (result.notice) {
          notices.push(result.notice);
        }
      }
    }
  }

  if (blocks.length === 0) {
    return {
      cleanedText: text,
      attachments,
      messages,
      notices,
      hadBlocks: false,
    };
  }

  let cleanedText = text;

  for (const block of blocks) {
    cleanedText = cleanedText.replace(block, "");
  }

  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, "\n\n").trim(),
    attachments,
    messages,
    notices,
    hadBlocks: true,
  };
}

export function extractLocalMediaLinkOutputs(text: string): {
  attachments: DiscordFilePayload[];
  notices: string[];
} {
  const attachments: DiscordFilePayload[] = [];
  const notices: string[] = [];
  const seenPaths = new Set<string>();
  const markdownLinkPattern = /(?<!!)\[([^\]]*)]\(([^)]+)\)/g;

  for (const match of text.matchAll(markdownLinkPattern)) {
    const label = (match[1] ?? "").trim();
    const rawReference = (match[2] ?? "").trim().replace(/^<|>$/g, "");

    if (!rawReference || /^https?:\/\//i.test(rawReference) || !isLocalMediaAttachmentReference(rawReference)) {
      continue;
    }

    const filePath = normalizeLocalAttachmentPath(rawReference);

    if (!filePath || seenPaths.has(filePath)) {
      continue;
    }

    seenPaths.add(filePath);
    const result = codexSendFileAttachment({
      filePath,
      name: isLocalMediaAttachmentReference(label) ? sanitizeDiscordFileName(label) : null,
    });

    if (result.attachment) {
      attachments.push(result.attachment);
    }

    if (result.notice) {
      notices.push(result.notice);
    }
  }

  return { attachments, notices };
}

function extractImageOutputs(text: string): { attachments: DiscordFilePayload[]; remoteUrls: string[] } {
  const attachments: DiscordFilePayload[] = [];
  const remoteUrls: string[] = [];
  const seenReferences = new Set<string>();
  const markdownImagePattern = /!\[[^\]]*]\(([^)]+)\)/g;

  for (const match of text.matchAll(markdownImagePattern)) {
    const rawReference = (match[1] ?? "").trim().replace(/^<|>$/g, "");

    if (!rawReference || seenReferences.has(rawReference) || !isImageReference(rawReference)) {
      continue;
    }

    seenReferences.add(rawReference);

    if (/^https?:\/\//i.test(rawReference)) {
      remoteUrls.push(rawReference);
      continue;
    }

    const localPath = normalizeLocalImagePath(rawReference);

    if (localPath && existsSync(localPath)) {
      attachments.push({
        attachment: localPath,
        name: path.basename(localPath) || "codex-image.png",
      });
    }
  }

  return { attachments, remoteUrls };
}

function deduplicateDiscordFiles(files: DiscordFilePayload[]): DiscordFilePayload[] {
  const seen = new Set<string>();
  const deduped: DiscordFilePayload[] = [];

  for (const file of files) {
    const key = typeof file.attachment === "string" ? file.attachment : file.name ?? `buffer-${deduped.length}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(file);
  }

  return deduped;
}

function stripAttachedLocalImageMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*]\(([^)]+)\)/g, (match, reference: string) => {
      const rawReference = String(reference ?? "").trim().replace(/^<|>$/g, "");

      if (/^https?:\/\//i.test(rawReference)) {
        return match;
      }

      const localPath = normalizeLocalImagePath(rawReference);
      return localPath && existsSync(localPath) ? "" : match;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textPayload(content: string): DiscordMessagePayload {
  return {
    allowedMentions: { parse: [] },
    content: truncateMessageContent(sanitizeDiscordMarkdown(content)),
    embeds: [],
  };
}

function button(input: { customId: string; label: string; style: number }): DiscordButtonPayload {
  return {
    type: 2,
    custom_id: input.customId,
    label: input.label,
    style: input.style,
  };
}

function truncateSelectText(value: string, limit = 100): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function selectMenu(input: {
  customId: string;
  placeholder: string;
  options: DiscordSelectOptionPayload[];
  minValues?: number;
  maxValues?: number;
}): DiscordSelectMenuPayload {
  return {
    type: 3,
    custom_id: input.customId,
    placeholder: input.placeholder,
    min_values: input.minValues ?? 1,
    max_values: input.maxValues ?? 1,
    options: input.options,
  };
}

function actionRow(components: Array<DiscordButtonPayload | DiscordSelectMenuPayload>): DiscordActionRowPayload {
  return {
    type: 1,
    components,
  };
}

function commandPaletteActions(channelMode: ChannelMode): DiscordActionRowPayload {
  const adminOptions: DiscordSelectOptionPayload[] = [
    { label: "현재 채널 상태", value: "where" },
    { label: "파일 탐색", value: "browse" },
    { label: "동기화 상태", value: "sync-status" },
    { label: "봇 명령어 재등록", value: "reload-commands" },
    { label: "Git 상태", value: "git-status" },
    { label: "Git 변경 요약", value: "git-diff" },
    { label: "Git 충돌 점검", value: "git-conflicts" },
    { label: "테스트 실행", value: "test" },
  ];
  const sessionOptions: DiscordSelectOptionPayload[] = [
    { label: "현재 채널 상태", value: "where" },
    { label: "파일 탐색", value: "browse" },
    { label: "Git 상태", value: "git-status" },
    { label: "Git 변경 요약", value: "git-diff" },
    { label: "Git 충돌 점검", value: "git-conflicts" },
    { label: "테스트 실행", value: "test" },
    { label: "Codex 프로젝트 요약", value: "codex-summary" },
    { label: "Codex 변경 리뷰", value: "codex-review" },
    { label: "Codex 테스트 수정", value: "fix-tests" },
  ];
  const claudeOptions: DiscordSelectOptionPayload[] = [
    { label: "현재 채널 상태", value: "where" },
    { label: "파일 탐색", value: "browse" },
    { label: "Git 상태", value: "git-status" },
    { label: "Git 변경 요약", value: "git-diff" },
    { label: "Git 충돌 점검", value: "git-conflicts" },
    { label: "테스트 실행", value: "test" },
  ];
  const options =
    channelMode === "shell-admin"
      ? adminOptions
      : channelMode === "claude-code"
        ? claudeOptions
        : sessionOptions;

  return actionRow([
    selectMenu({
      customId: COMPONENT_IDS.palette,
      placeholder: "작업 선택",
      options,
    }),
  ]);
}

function adminQuickActions(): DiscordActionRowPayload[] {
  return [
    actionRow([
      button({
        customId: COMPONENT_IDS.newGeneralChat,
        label: "새 일반 채팅",
        style: BUTTON_STYLES.primary,
      }),
      button({
        customId: COMPONENT_IDS.newCurrentFolderChat,
        label: "현재 폴더 채팅",
        style: BUTTON_STYLES.primary,
      }),
      button({
        customId: COMPONENT_IDS.syncDefault,
        label: "세션 선택 동기화",
        style: BUTTON_STYLES.primary,
      }),
      button({
        customId: COMPONENT_IDS.fileSystemRefresh,
        label: "파일 탐색",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.maintenancePanel,
        label: "유지보수",
        style: BUTTON_STYLES.secondary,
      }),
    ]),
    actionRow([
      button({
        customId: COMPONENT_IDS.syncAllDefault,
        label: "전체 동기화",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.deletePreview,
        label: "삭제 미리보기",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.reloadCommands,
        label: "명령어 재등록",
        style: BUTTON_STYLES.secondary,
      }),
    ]),
    commandPaletteActions("shell-admin"),
  ];
}

function syncResultActions(): DiscordActionRowPayload[] {
  return [
    actionRow([
      button({
        customId: COMPONENT_IDS.syncDefault,
        label: "세션 선택",
        style: BUTTON_STYLES.primary,
      }),
      button({
        customId: COMPONENT_IDS.syncAllDefault,
        label: "전체 다시 동기화",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.deletePreview,
        label: "삭제 미리보기",
        style: BUTTON_STYLES.secondary,
      }),
    ]),
  ];
}

function transcriptSyncModeActions(): DiscordActionRowPayload {
  return actionRow([
    button({
      customId: COMPONENT_IDS.syncModeOnChat,
      label: "채팅 시작 시 동기화",
      style: BUTTON_STYLES.primary,
    }),
    button({
      customId: COMPONENT_IDS.syncModeRealtime,
      label: "실시간 동기화",
      style: BUTTON_STYLES.success,
    }),
  ]);
}

function deletePreviewActions(input?: {
  mode?: "all" | "channels" | "session";
  sessionId?: string | null;
  channelOptions?: Array<{
    sessionId: string;
    channelName: string;
    workspaceDisplayName: string;
    updatedAt: string;
  }>;
}): DiscordActionRowPayload[] {
  if (input?.mode === "session" && input.sessionId) {
    return [
      actionRow([
        button({
          customId: `cdc:delete:session:${input.sessionId}:confirm`,
          label: "이 채널 삭제",
          style: BUTTON_STYLES.danger,
        }),
      ]),
    ];
  }

  const actions: DiscordActionRowPayload[] = [
    actionRow([
      button({
        customId: COMPONENT_IDS.deleteChannelsConfirm,
        label: "채널만 삭제",
        style: BUTTON_STYLES.danger,
      }),
      button({
        customId: COMPONENT_IDS.deleteAllConfirm,
        label: "채널+카테고리 삭제",
        style: BUTTON_STYLES.danger,
      }),
    ]),
  ];
  const options =
    input?.channelOptions?.slice(0, 25).map((channel) => ({
      label: truncateSelectText(channel.channelName),
      value: channel.sessionId,
      description: truncateSelectText(`${channel.workspaceDisplayName} · ${channel.updatedAt}`, 100),
    })) ?? [];

  if (options.length > 0) {
    actions.push(
      actionRow([
        selectMenu({
          customId: COMPONENT_IDS.deleteSessionSelected,
          placeholder: "삭제할 채널 하나 선택",
          minValues: 1,
          maxValues: 1,
          options,
        }),
      ]),
    );
  }

  return actions;
}

function archiveSessionActions(): DiscordActionRowPayload[] {
  return [
    actionRow([
      button({
        customId: COMPONENT_IDS.archiveCurrentConfirm,
        label: "이 세션 보관",
        style: BUTTON_STYLES.danger,
      }),
    ]),
  ];
}

function sessionHelpActions(channelMode: Extract<ChannelMode, "session-linked" | "claude-code">): DiscordActionRowPayload[] {
  if (channelMode === "claude-code") {
    return [
      actionRow([
        button({
          customId: COMPONENT_IDS.fileSystemRefresh,
          label: "파일 보기",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.gitStatus,
          label: "Git 상태",
          style: BUTTON_STYLES.secondary,
        }),
        button({
          customId: COMPONENT_IDS.testRun,
          label: "테스트 실행",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.gitConflicts,
          label: "충돌 점검",
          style: BUTTON_STYLES.secondary,
        }),
        button({
          customId: COMPONENT_IDS.maintenancePanel,
          label: "유지보수",
          style: BUTTON_STYLES.secondary,
        }),
      ]),
      commandPaletteActions("claude-code"),
    ];
  }

  return [
    actionRow([
      button({
        customId: COMPONENT_IDS.codexAsk,
        label: "Codex에게 요청",
        style: BUTTON_STYLES.success,
      }),
      button({
        customId: COMPONENT_IDS.fileSystemRefresh,
        label: "파일 보기",
        style: BUTTON_STYLES.primary,
      }),
      button({
        customId: COMPONENT_IDS.gitStatus,
        label: "Git 상태",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.testRun,
        label: "테스트 실행",
        style: BUTTON_STYLES.primary,
      }),
      button({
        customId: COMPONENT_IDS.archiveCurrentConfirm,
        label: "이 세션 보관",
        style: BUTTON_STYLES.danger,
      }),
    ]),
    actionRow([
      button({
        customId: COMPONENT_IDS.gitReview,
        label: "Codex 리뷰",
        style: BUTTON_STYLES.success,
      }),
      button({
        customId: COMPONENT_IDS.testFix,
        label: "테스트 수정",
        style: BUTTON_STYLES.success,
      }),
      button({
        customId: COMPONENT_IDS.gitConflicts,
        label: "충돌 점검",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.maintenancePanel,
        label: "유지보수",
        style: BUTTON_STYLES.secondary,
      }),
    ]),
    commandPaletteActions("session-linked"),
  ];
}

function isLikelyFileSystemListCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "ls" || trimmed.startsWith("ls ") || trimmed.startsWith("__cdc_ls");
}

function parseFileSystemOptions(stdout: string): DiscordSelectOptionPayload[] {
  const seen = new Set<string>();
  const options: DiscordSelectOptionPayload[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const value = rawLine.trim();

    if (
      value.length === 0 ||
      value.length > 100 ||
      value === "." ||
      value === ".." ||
      /[\0\r\n`$;&|<>/]/.test(value.replace(/\/$/, ""))
    ) {
      continue;
    }

    const normalizedValue = value.replace(/\/$/, "");

    if (seen.has(normalizedValue)) {
      continue;
    }

    seen.add(normalizedValue);
    options.push({
      label: value.slice(0, 100),
      value: normalizedValue,
    });

    if (options.length >= 25) {
      break;
    }
  }

  return options;
}

function fileBrowserOptions(ui: FileBrowserUiPayload): DiscordSelectOptionPayload[] {
  return ui.entries.slice(0, 25).map((entry) => ({
    label: `${entry.name}${entry.kind === "directory" ? "/" : ""}`.slice(0, 100),
    value: entry.name.slice(0, 100),
  }));
}

function fileBrowserPaginationActions(ui: FileBrowserUiPayload): DiscordActionRowPayload | null {
  const totalPages = Math.max(1, Math.ceil(ui.totalEntries / Math.max(1, ui.pageSize)));
  const buttons: DiscordButtonPayload[] = [];

  if (ui.page > 0) {
    buttons.push(
      button({
        customId: `cdc:fs:page:${ui.page - 1}`,
        label: "이전 페이지",
        style: BUTTON_STYLES.secondary,
      }),
    );
  }

  if (ui.page < totalPages - 1) {
    buttons.push(
      button({
        customId: `cdc:fs:page:${ui.page + 1}`,
        label: "다음 페이지",
        style: BUTTON_STYLES.secondary,
      }),
    );
  }

  return buttons.length > 0 ? actionRow(buttons) : null;
}

function fileCardActions(ui: FileCardUiPayload, channelMode: ChannelMode): DiscordActionRowPayload[] {
  const navigationButtons: DiscordButtonPayload[] = [
    button({
      customId: COMPONENT_IDS.newHereChat,
      label: "여기서 새 채팅",
      style: BUTTON_STYLES.primary,
    }),
    button({
      customId: COMPONENT_IDS.fileSystemUp,
      label: "상위 폴더",
      style: BUTTON_STYLES.secondary,
    }),
    button({
      customId: COMPONENT_IDS.fileSystemRefresh,
      label: "목록으로",
      style: BUTTON_STYLES.primary,
    }),
  ];

  if (channelMode === "session-linked") {
    navigationButtons.push(
      button({
        customId: COMPONENT_IDS.codexAsk,
        label: "Codex에게 요청",
        style: BUTTON_STYLES.success,
      }),
    );
  }

  const rows: DiscordActionRowPayload[] = [actionRow(navigationButtons)];

  if (channelMode !== "session-linked") {
    return rows;
  }

  return [
    ...rows,
    actionRow([
      selectMenu({
        customId: COMPONENT_IDS.fileSystemSummarize,
        placeholder: "이 파일을 Codex로 요약",
        options: [{ label: ui.path.slice(0, 100), value: ui.path.slice(0, 100) }],
      }),
    ]),
    actionRow([
      selectMenu({
        customId: COMPONENT_IDS.fileSystemEdit,
        placeholder: "이 파일을 Codex로 개선/수정",
        options: [{ label: ui.path.slice(0, 100), value: ui.path.slice(0, 100) }],
      }),
    ]),
  ];
}

function fileSystemActions(input: {
  command: string;
  stdout: string;
  failed: boolean;
  ui: CommandUiPayload | null;
  channelMode: ChannelMode;
}): DiscordActionRowPayload[] | undefined {
  if (input.failed) {
    return undefined;
  }

  if (input.ui?.kind === "file-card") {
    return fileCardActions(input.ui, input.channelMode);
  }

  if (!input.ui && !isLikelyFileSystemListCommand(input.command)) {
    return undefined;
  }

  const options = input.ui?.kind === "file-browser" ? fileBrowserOptions(input.ui) : parseFileSystemOptions(input.stdout);
  const navigationButtons: DiscordButtonPayload[] = [
    button({
      customId: COMPONENT_IDS.fileSystemUp,
      label: "상위 폴더",
      style: BUTTON_STYLES.secondary,
    }),
    button({
      customId: COMPONENT_IDS.fileSystemRefresh,
      label: "새로고침",
      style: BUTTON_STYLES.primary,
    }),
  ];

  if (input.channelMode === "session-linked") {
    navigationButtons.push(
      button({
        customId: COMPONENT_IDS.codexAsk,
        label: "Codex에게 요청",
        style: BUTTON_STYLES.success,
      }),
    );
  }

  const rows: DiscordActionRowPayload[] = [actionRow(navigationButtons)];
  const paginationRow = input.ui?.kind === "file-browser" ? fileBrowserPaginationActions(input.ui) : null;

  if (paginationRow) {
    rows.push(paginationRow);
  }

  if (options.length > 0) {
    rows.push(
      actionRow([
        selectMenu({
          customId: COMPONENT_IDS.fileSystemOpen,
          placeholder: "항목 열기",
          options,
        }),
      ]),
    );
  }

  return rows;
}

function commandWorkflowActions(command: string, failed: boolean, channelMode: ChannelMode): DiscordActionRowPayload[] | undefined {
  const normalizedCommand = command.trim();
  const isTestCommand = /^(?:pnpm|npm|yarn|bun)\s+(?:test|vitest)(?:\s|$)/.test(normalizedCommand);

  if (!failed && /^git\s+status(?:\s+--short)?$/.test(normalizedCommand)) {
    const buttons = [
      button({
        customId: COMPONENT_IDS.gitDiff,
        label: "Diff 보기",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.testRun,
        label: "테스트 실행",
        style: BUTTON_STYLES.primary,
      }),
    ];

    if (channelMode === "session-linked") {
      buttons.splice(
        1,
        0,
        button({
          customId: COMPONENT_IDS.gitReview,
          label: "Codex 리뷰",
          style: BUTTON_STYLES.success,
        }),
      );
    }

    return [actionRow(buttons)];
  }

  if (isTestCommand) {
    const buttons = [
      button({
        customId: COMPONENT_IDS.testRun,
        label: "테스트 다시 실행",
        style: BUTTON_STYLES.primary,
      }),
    ];

    if (channelMode === "session-linked") {
      buttons.push(
        button({
          customId: COMPONENT_IDS.testFix,
          label: "Codex에게 수정 요청",
          style: BUTTON_STYLES.success,
        }),
      );
    }

    return [actionRow(buttons)];
  }

  return undefined;
}

function normalizeCommandUi(ui: unknown): CommandUiPayload | null {
  if (typeof ui !== "object" || ui === null || !("kind" in ui)) {
    return null;
  }

  const maybeUi = ui as {
    kind?: unknown;
    page?: unknown;
    pageSize?: unknown;
    totalEntries?: unknown;
    entries?: unknown;
    path?: unknown;
    preview?: unknown;
  };

  if (
    maybeUi.kind === "file-browser" &&
    typeof maybeUi.page === "number" &&
    typeof maybeUi.pageSize === "number" &&
    typeof maybeUi.totalEntries === "number" &&
    Array.isArray(maybeUi.entries)
  ) {
    const entries = maybeUi.entries
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return null;
        }

        const candidate = entry as { name?: unknown; kind?: unknown };

        if (
          typeof candidate.name !== "string" ||
          (candidate.kind !== "directory" && candidate.kind !== "file" && candidate.kind !== "other")
        ) {
          return null;
        }

        return {
          name: candidate.name,
          kind: candidate.kind,
        };
      })
      .filter((entry): entry is FileBrowserUiPayload["entries"][number] => entry !== null);

    return {
      kind: "file-browser",
      page: maybeUi.page,
      pageSize: maybeUi.pageSize,
      totalEntries: maybeUi.totalEntries,
      entries,
    };
  }

  if (maybeUi.kind === "file-card" && typeof maybeUi.path === "string" && typeof maybeUi.preview === "string") {
    return {
      kind: "file-card",
      path: maybeUi.path,
      preview: maybeUi.preview,
    };
  }

  return null;
}

export function formatCommandAck(input: {
  computerDisplayName: string;
  workspaceDisplayName: string;
  cwd: string;
  command: string;
}): DiscordMessagePayload {
  return messagePayload({
    title: "Command queued",
    color: COLORS.queued,
    fields: [
      ...formatCommandHeaderFields(input.cwd, input),
      {
        name: "Status",
        value: wrapDiscordText("queued"),
        inline: true,
      },
    ],
  });
}

function formatCommandHeaderFields(
  cwd: string,
  input: {
    computerDisplayName: string;
    workspaceDisplayName: string;
    command: string;
  },
): DiscordEmbedFieldPayload[] {
  return [
    {
      name: "Target",
      value: `${wrapDiscordText(input.computerDisplayName)} / ${wrapDiscordText(input.workspaceDisplayName)}`,
      inline: false,
    },
    {
      name: "Working directory",
      value: wrapDiscordText(cwd),
      inline: false,
    },
    {
      name: "Command",
      value: codeBlock(input.command, "bash"),
      inline: false,
    },
  ];
}

export function formatDenied(reason: string): DiscordMessagePayload {
  return messagePayload({
    title: "Permission denied",
    color: COLORS.failure,
    description: truncateFieldValue(wrapDiscordText(reason)),
  });
}

export function formatBlockedCommand(input: { reason: string; guidance: string }): DiscordMessagePayload {
  return messagePayload({
    title: "이 채널에서는 실행할 수 없습니다",
    color: COLORS.neutral,
    description: input.reason,
    fields: [
      {
        name: "다음 단계",
        value: input.guidance,
        inline: false,
      },
    ],
  });
}

export function formatQueueStatus(input: {
  active: string | null;
  pending: string[];
}): DiscordMessagePayload {
  const pendingPreview = input.pending.length > 0
    ? input.pending.slice(0, 10).map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "(none)";

  return messagePayload({
    title: "Channel queue",
    color: input.active || input.pending.length > 0 ? COLORS.queued : COLORS.neutral,
    description: input.active
      ? "현재 작업이 실행 중이며, 아래 요청들이 순서대로 대기하고 있습니다."
      : "현재 실행 중인 작업이 없습니다.",
    fields: [
      {
        name: "Active",
        value: truncateFieldValue(wrapDiscordText(input.active ?? "(none)")),
        inline: false,
      },
      {
        name: `Pending (${input.pending.length})`,
        value: truncateFieldValue(wrapDiscordText(pendingPreview)),
        inline: false,
      },
    ],
  });
}

export function formatQueueClearResult(input: {
  clearedCount: number;
  active: boolean;
}): DiscordMessagePayload {
  return messagePayload({
    title: "Queue cleared",
    color: COLORS.success,
    description: input.active
      ? "현재 실행 중인 작업은 유지하고 대기 요청만 삭제했습니다."
      : "대기 요청을 삭제했습니다.",
    fields: [
      {
        name: "Removed",
        value: String(input.clearedCount),
        inline: true,
      },
      {
        name: "Active job",
        value: input.active ? "running" : "none",
        inline: true,
      },
    ],
  });
}

export function formatCodexTurnControlResult(input: {
  action: "steer" | "interrupt";
  status: "accepted" | "no-active-turn" | "unsupported" | "failed";
  message: string;
  agentLabel?: "Codex" | "Claude Code";
  threadId?: string;
  turnId?: string;
}): DiscordMessagePayload {
  const fields: DiscordEmbedFieldPayload[] = [
    {
      name: "Status",
      value: wrapDiscordText(input.status),
      inline: true,
    },
  ];

  if (input.threadId) {
    fields.push({ name: "Session", value: wrapDiscordText(input.threadId), inline: false });
  }

  if (input.turnId) {
    fields.push({ name: "Turn", value: wrapDiscordText(input.turnId), inline: false });
  }

  return messagePayload({
    title: input.status === "unsupported"
      ? input.action === "steer" ? "Steering not supported" : "Interrupt not supported"
      : input.action === "steer"
        ? `${input.agentLabel ?? "Codex"} steering`
        : `${input.agentLabel ?? "Codex"} interrupt`,
    color: input.status === "accepted"
      ? COLORS.success
      : input.status === "failed"
        ? COLORS.failure
        : COLORS.neutral,
    description: truncateDescription(wrapDiscordText(input.message)),
    fields,
  });
}

function codexApprovalCustomId(token: string, decision: "accept" | "accept-session" | "decline" | "cancel"): string {
  return `${COMPONENT_IDS.codexApprovalPrefix}${token}:${decision}`;
}

export function formatCodexApprovalRequest(input: {
  token: string;
  request: CodexApprovalRequestMessage;
}): DiscordMessagePayload {
  const fields: DiscordEmbedFieldPayload[] = [
    {
      name: "Type",
      value: wrapDiscordText(input.request.kind),
      inline: true,
    },
  ];

  if (input.request.sessionId) {
    fields.push({
      name: "Session",
      value: wrapDiscordText(input.request.sessionId),
      inline: true,
    });
  }

  if (input.request.cwd) {
    fields.push({
      name: "Working directory",
      value: wrapDiscordText(input.request.cwd),
      inline: false,
    });
  }

  if (input.request.command) {
    fields.push({
      name: "Command",
      value: codeBlock(input.request.command, "bash"),
      inline: false,
    });
  }

  if (input.request.reason) {
    fields.push({
      name: "Reason",
      value: truncateFieldValue(sanitizeDiscordMarkdown(input.request.reason)),
      inline: false,
    });
  }

  for (const detail of input.request.details?.slice(0, 5) ?? []) {
    fields.push({
      name: detail.name,
      value: truncateFieldValue(codeBlock(detail.value, "json")),
      inline: false,
    });
  }

  return messagePayload(
    {
      title: input.request.title,
      color: COLORS.queued,
      description: truncateDescription(sanitizeDiscordMarkdown(input.request.message)),
      fields,
    },
    [
      actionRow([
        button({
          customId: codexApprovalCustomId(input.token, "accept"),
          label: "이번만 허용",
          style: BUTTON_STYLES.success,
        }),
        button({
          customId: codexApprovalCustomId(input.token, "accept-session"),
          label: "세션 동안 허용",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: codexApprovalCustomId(input.token, "decline"),
          label: "거부",
          style: BUTTON_STYLES.danger,
        }),
        button({
          customId: codexApprovalCustomId(input.token, "cancel"),
          label: "취소",
          style: BUTTON_STYLES.secondary,
        }),
      ]),
    ],
  );
}

export function formatCodexApprovalDecision(input: {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  accepted: boolean;
  found: boolean;
}): DiscordMessagePayload {
  if (!input.found) {
    return messagePayload({
      title: "권한 요청을 찾을 수 없습니다",
      color: COLORS.neutral,
      description: "이미 처리되었거나 봇이 재시작된 요청입니다.",
    });
  }

  const labels = {
    accept: "이번만 허용",
    acceptForSession: "세션 동안 허용",
    decline: "거부",
    cancel: "취소",
  } as const;

  return messagePayload({
    title: input.accepted ? "권한 응답 전달됨" : "권한 요청 거부됨",
    color: input.accepted ? COLORS.success : COLORS.failure,
    description: `Codex에 \`${labels[input.decision]}\` 결정을 전달했습니다.`,
  });
}

export function formatCodexUserInputRequest(input: {
  question: CodexUserInputQuestionMessage;
  index: number;
  total: number;
  autoResolutionMs?: number | null;
}): DiscordMessagePayload {
  const options = input.question.options ?? [];
  const fields: DiscordEmbedFieldPayload[] = [];

  if (options.length > 0) {
    fields.push({
      name: "선택지",
      value: truncateFieldValue(options
        .map((option, index) => `**${index + 1}. ${sanitizeBlockDiscordText(option.label)}**\n${sanitizeBlockDiscordText(option.description)}`)
        .join("\n\n")),
      inline: false,
    });
  }

  const instructions = [
    options.length > 0
      ? "이 스레드에 번호, 선택지 이름 또는 직접 답변을 보내세요."
      : "이 스레드에 답변을 보내세요.",
    input.question.isSecret
      ? "주의: Discord 메시지는 비밀 입력창이 아닙니다. 토큰이나 비밀번호는 보내지 마세요."
      : "",
    input.autoResolutionMs && input.autoResolutionMs > 0
      ? `${Math.ceil(input.autoResolutionMs / 1_000)}초 안에 답하지 않으면 첫 번째 선택지로 자동 진행합니다.`
      : "",
  ].filter(Boolean).join("\n\n");

  return messagePayload({
    title: `Codex 질문 · ${input.index + 1}/${input.total} · ${sanitizeInlineDiscordText(input.question.header)}`,
    color: COLORS.queued,
    description: truncateDescription(`${sanitizeDiscordMarkdown(input.question.question)}\n\n${instructions}`),
    fields,
  });
}

export function formatCodexUserInputReceived(input: {
  answer: string;
  autoResolved?: boolean;
}): DiscordMessagePayload {
  return messagePayload({
    title: input.autoResolved ? "Codex 질문 자동 응답" : "Codex에 답변 전달됨",
    color: input.autoResolved ? COLORS.neutral : COLORS.success,
    description: input.autoResolved
      ? `응답 시간이 지나 첫 번째 선택지 ${wrapDiscordText(input.answer || "(응답 없음)")}로 계속 진행합니다.`
      : wrapDiscordText(input.answer || "(응답 없음)"),
  });
}

export function formatHelp(channelMode: ChannelMode): DiscordMessagePayload {
  const adminSlashCommandField: DiscordEmbedFieldPayload = {
    name: "Admin slash commands",
    value: codeBlock(
      "/where 또는 /status\n/settings\n/model model:<이름 또는 default>\n/effort level:<단계>\n/browse\n/shell command:pwd\n/diff\n/schedule action:create mode:every every:10m command:shell pwd\n/schedule action:list\n/schedule action:delete id:<id>\n/sync limit:25\n/sync-select limit:25\n/sync-all limit:25\n/sync-status\n/sync-mode mode:realtime\n/sync-delete mode:preview\n/sync-delete mode:session session_id:<id> confirm:true\n/sync-archive session_id:<id> confirm:true\n/chat-new name:새 작업 cwd:/path/to/project category:true\n/reload mode:commands",
      "text",
    ),
    inline: false,
  };
  const sessionSlashCommandField: DiscordEmbedFieldPayload = {
    name: "Session slash commands",
    value: codeBlock(
      "/codex prompt:README 요약해줘\n/fork\n/steer prompt:현재 작업 방향 수정\n/interrupt\n/queue prompt:현재 작업 뒤에 테스트 실행\n/queue\n/queue-clear\n/review prompt:보안 위험 위주\n/fix-tests\n/summarize target:현재 채널\n/howtouse\n/compact prompt:이번 작업 맥락 정리\n/skill name:frontend-design prompt:UI 개선해줘\n/model model:<이름 또는 default>\n/effort level:<단계 또는 default>\n/settings\n/fast\n/task\n/codex-mode mode:default\n/schedule action:create mode:daily at:09:30 command:codex 오늘 계획 정리\n/archive\n/where 또는 /status\n/browse\n/shell command:pwd\n/diff",
      "text",
    ),
    inline: false,
  };
  const claudeCodeFields: DiscordEmbedFieldPayload[] = [
    {
      name: "Primary flow",
      value: codeBlock("현재 GPU 사용량 봐봐\n이 파일 분석해줘\n버그 고치고 테스트 돌려줘\n/model model:sonnet\n/effort level:max\n/settings\n/fork", "text"),
      inline: false,
    },
    {
      name: "Shell in this channel",
      value: codeBlock("!pwd\n!cd /path/to/project\n!git status --short\n!nvidia-smi", "bash"),
      inline: false,
    },
    {
      name: "Claude Code",
      value: "이 채널의 자연어 메시지는 Claude Code headless 실행으로 전달됩니다. `/model`, `/effort`, `/settings`로 main 기본값 또는 현재 thread override를 관리합니다. 같은 Discord 채널에서는 Claude session ID를 기억해서 다음 요청에 resume합니다. 연결된 Claude Code thread에서 `/fork`를 실행하면 새 이름을 입력하고 분기 thread를 만들 수 있습니다. 실행 중 일반 메시지는 현재 Claude Code turn에 즉시 steering됩니다. 다음 turn으로 남기려면 `/queue prompt:<요청>`을 사용하세요. prompt 없는 `/queue`는 상태를 보여주며, `/steer`는 명시적 steering 별칭이고 `/interrupt`는 현재 turn을 중단합니다.",
      inline: false,
    },
    {
      name: "Attachments",
      value: "메시지에 이미지, 영상, 오디오 또는 일반 파일을 첨부하면 봇이 서버의 임시 저장소에 내려받고 그 로컬 경로를 Claude Code 요청에 전달합니다. 파일만 보내도 기본 확인 요청으로 처리됩니다.",
      inline: false,
    },
    {
      name: "Channel boundary",
      value: "이 채널은 Claude Code 전용입니다. Codex와 대화하거나 Codex 세션을 동기화하려면 AI agent/admin 채널 또는 session 채널을 사용하세요.",
      inline: false,
    },
  ];
  const shellAdminFields: DiscordEmbedFieldPayload[] = [
    {
      name: "Start here",
      value: codeBlock(
        "where\nbrowse\nchat new name:새 작업\nsync\nsync status",
        "text",
      ),
      inline: false,
    },
    {
      name: "Codex chat workflow",
      value: codeBlock(
        "chat new name:README 정리\n새 채팅 채널에서: README에 사용법 추가해줘\nsync 또는 sync all 25",
        "text",
      ),
      inline: false,
    },
    {
      name: "Workspace operations",
      value: codeBlock("ls\npwd\ncd apps\ncat README.md\ngit status --short\npnpm test", "bash"),
      inline: false,
    },
    adminSlashCommandField,
    {
      name: "Careful operations",
      value: codeBlock(
        "schedule list\nschedule every 10m command:shell pwd\nschedule daily at 09:30 command:codex 오늘 계획 정리\nschedule weekly mon,wed,fri at 09:30 command:shell pnpm test\nschedule delete <id>\nsync all 25\nsync delete preview\nsync delete session <session-id>\nsync delete session <session-id> confirm\nsync delete all confirm\nreload restart confirm\nreload restart force confirm\nconfirm rm path/to/file",
        "text",
      ),
      inline: false,
    },
    {
      name: "Attachments",
      value: "이미지, 영상, 오디오 또는 일반 파일을 메시지에 첨부하면 Codex 요청으로 전달합니다. 설명 없이 파일만 보내도 되며, Claude Code로 보내려면 `claude <요청>`을 본문에 적으세요.",
      inline: false,
    },
    {
      name: "Channel boundary",
      value: "main/admin 채널은 운영 전용입니다. 이 채널의 `/model`, `/effort`, `/settings`는 Codex 기본값을 관리하며, 대화·리뷰·테스트 수정은 새 채팅 또는 동기화된 session 채널에서 실행하세요.",
      inline: false,
    },
  ];
  const sessionLinkedFields: DiscordEmbedFieldPayload[] = [
    {
      name: "Primary flow",
      value: codeBlock("그 파일 구조 설명해줘\n이 버그 고쳐줘\n테스트까지 돌려줘", "text"),
      inline: false,
    },
    {
      name: "Shell in this session",
      value: codeBlock("!ls\n!pwd\n!cd apps\n!cat README.md", "bash"),
      inline: false,
    },
    sessionSlashCommandField,
    {
      name: "Session controls",
      value: codeBlock(
        "model gpt-5.4\neffort xhigh\nsettings\nmodel default\neffort default\nfast\ntask\nmode default\nclaude README 요약해줘\nreview 보안 위험 위주\nfix-tests\nsummarize 이번 채널\ncompact 이번 작업 맥락 정리\nskill frontend-design UI 개선해줘\nschedule list\nschedule every 10m command:shell pwd\nschedule daily at 09:30 command:codex 오늘 계획 정리\narchive\narchive confirm\nstatus\ndiff\nbrowse\nshell pwd\ncodex-command mcp list",
        "text",
      ),
      inline: false,
    },
    {
      name: "Attachments",
      value: "메시지에 이미지, 영상, 오디오 또는 일반 파일을 첨부하면 봇이 서버의 임시 저장소에 내려받고 그 로컬 경로를 현재 Codex 요청에 전달합니다. 파일만 보내도 기본 확인 요청으로 처리됩니다.",
      inline: false,
    },
    {
      name: "Claude Code",
      value: "`claude <요청>`으로 현재 session 채널의 작업 디렉터리에서 Claude Code headless 실행을 시작합니다. 같은 Discord 채널에서는 Claude session ID를 기억해서 다음 `claude ...` 요청에 resume합니다.",
      inline: false,
    },
    {
      name: "Codex reasoning",
      value: "`default`와 `task`는 extra high reasoning(`xhigh`)으로 실행합니다. 빠른 확인이 필요할 때만 `fast`를 사용하면 low reasoning으로 낮춥니다.",
      inline: false,
    },
    {
      name: "Channel boundary",
      value: "session 채널은 Codex 대화 전용입니다. 세션 동기화, 새 채팅 생성, 봇 재등록/재시작은 main/admin 채널에서 실행하세요.",
      inline: false,
    },
  ];

  return messagePayload(
    {
      title: "Codex 운영 콘솔 사용법",
      color: COLORS.neutral,
      description:
        channelMode === "shell-admin"
          ? "main/admin 채널은 운영 전용입니다. 파일 탐색, 세션 생성/동기화, 봇 관리만 수행하고 Codex 대화는 session 채널에서 진행합니다."
          : channelMode === "claude-code"
            ? "이 채널은 Claude Code 전용입니다. 자연어는 Claude Code로 보내고, shell 명령은 `!` 접두어를 붙입니다."
          : "이 채널은 Codex 세션과 연결되어 있습니다. 자연어는 Codex로 보내고, shell 명령은 `!` 접두어를 붙입니다.",
      fields:
        channelMode === "shell-admin"
          ? shellAdminFields
          : channelMode === "claude-code"
            ? claudeCodeFields
            : sessionLinkedFields,
    },
    channelMode === "shell-admin" ? adminQuickActions() : sessionHelpActions(channelMode),
  );
}

export function formatMaintenancePanel(channelMode: ChannelMode): DiscordMessagePayload {
  const isSessionLinked = channelMode === "session-linked";
  const secondRow: DiscordButtonPayload[] = isSessionLinked
    ? [
        button({
          customId: COMPONENT_IDS.gitReview,
          label: "Codex 리뷰",
          style: BUTTON_STYLES.success,
        }),
        button({
          customId: COMPONENT_IDS.testFix,
          label: "테스트 수정",
          style: BUTTON_STYLES.success,
        }),
      ]
    : channelMode === "shell-admin"
      ? [
          button({
            customId: COMPONENT_IDS.reloadCommands,
            label: "명령어 재등록",
            style: BUTTON_STYLES.secondary,
          }),
          button({
            customId: COMPONENT_IDS.reloadRestartConfirm,
            label: "봇 재시작",
            style: BUTTON_STYLES.danger,
          }),
        ]
      : [];
  const maintenanceDescription =
    channelMode === "shell-admin"
      ? "버튼으로 Git 상태, Diff, 충돌 점검, 테스트 실행, 명령어 재등록과 봇 재시작을 처리합니다."
      : channelMode === "claude-code"
        ? "버튼으로 Git 상태, Diff, 충돌 점검, 테스트 실행을 이어갑니다."
        : "버튼으로 Git 상태, Diff, 충돌 점검, 테스트 실행, Codex 리뷰와 테스트 수정을 이어갑니다.";
  const recommendedOrder =
    channelMode === "shell-admin"
      ? "Git 상태 → 충돌 점검 → 테스트 실행 → 필요 시 명령어 재등록"
      : channelMode === "claude-code"
        ? "Git 상태 → 충돌 점검 → 테스트 실행"
        : "Git 상태 → 충돌 점검 → 테스트 실행 → Codex 리뷰/수정";

  return messagePayload(
    {
      title: "유지보수 패널",
      color: COLORS.neutral,
      description: maintenanceDescription,
      fields: [
        {
          name: "권장 순서",
          value: recommendedOrder,
          inline: false,
        },
      ],
    },
    [
      actionRow([
        ...(channelMode === "shell-admin"
          ? [
              button({
                customId: COMPONENT_IDS.selfDevChat,
                label: "봇 개발 채팅",
                style: BUTTON_STYLES.primary,
              }),
            ]
          : []),
        button({
          customId: COMPONENT_IDS.gitStatus,
          label: "Git 상태",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.gitDiff,
          label: "Diff 보기",
          style: BUTTON_STYLES.secondary,
        }),
        button({
          customId: COMPONENT_IDS.gitConflicts,
          label: "충돌 점검",
          style: BUTTON_STYLES.secondary,
        }),
      ]),
      actionRow([
        button({
          customId: COMPONENT_IDS.verifyTypecheck,
          label: "타입체크",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.testRun,
          label: "테스트 실행",
          style: BUTTON_STYLES.primary,
        }),
        ...secondRow,
      ].slice(0, 5)),
    ],
  );
}

export function formatChannelStatus(input: {
  channelMode: string;
  computerDisplayName: string;
  workspaceDisplayName: string;
  workspaceRoot: string;
  cwd: string;
  codexSessionId?: string | null;
  claudeSessionId?: string | null;
  agentSettings?: {
    model: string | null;
    effort: string;
    modelSource: string;
    effortSource: string;
  };
  timeoutMs: number;
  execution?: {
    active: boolean;
    activeRequest?: string | null;
    startedAt?: number | null;
    lastActivityAt?: number | null;
    pendingCount: number;
    waitingForApproval?: boolean;
    waitingForUserInput?: boolean;
    nowMs?: number;
  };
}): DiscordMessagePayload {
  const isClaudeCodeChannel = input.channelMode === "claude-code";
  const execution = input.execution ?? { active: false, pendingCount: 0 };
  const nowMs = execution.nowMs ?? Date.now();
  const agentName = isClaudeCodeChannel ? "Claude Code" : "Codex";
  const executionState = execution.waitingForUserInput
    ? "waiting-for-user-input"
    : execution.waitingForApproval
      ? "waiting-for-approval"
      : execution.active
        ? "running"
        : "idle";
  const executionFields: DiscordEmbedFieldPayload[] = [
    {
      name: "Agent state",
      value: wrapDiscordText(`${agentName} ${executionState}`),
      inline: true,
    },
    {
      name: "Queue",
      value: wrapDiscordText(`${execution.pendingCount} pending`),
      inline: true,
    },
  ];

  if (execution.active) {
    if (execution.activeRequest) {
      executionFields.push({
        name: "Active request",
        value: wrapDiscordText(execution.activeRequest),
        inline: false,
      });
    }

    if (execution.startedAt) {
      executionFields.push({
        name: "Started",
        value: `<t:${Math.floor(execution.startedAt / 1_000)}:F>\n${wrapDiscordText(`${formatElapsedTime(nowMs - execution.startedAt)} elapsed`)}`,
        inline: true,
      });
    }

    if (execution.lastActivityAt) {
      executionFields.push({
        name: "Last activity",
        value: `<t:${Math.floor(execution.lastActivityAt / 1_000)}:R>\n${wrapDiscordText(`${formatElapsedTime(nowMs - execution.lastActivityAt)} ago`)}`,
        inline: true,
      });
    }
  }
  const agentSettings = input.agentSettings ?? {
    model: null,
    effort: isClaudeCodeChannel ? "max" : "xhigh",
    modelSource: "CLI default",
    effortSource: "main default",
  };
  const modelSetting = agentSettings.model
    ? `${agentSettings.model} (${agentSettings.modelSource})`
    : "CLI default";
  const sessionFields: DiscordEmbedFieldPayload[] = isClaudeCodeChannel
    ? [
        {
          name: "Claude session",
          value: wrapDiscordText(input.claudeSessionId ?? "(not linked yet)"),
          inline: false,
        },
        {
          name: "Model",
          value: wrapDiscordText(modelSetting),
          inline: true,
        },
        {
          name: "Effort",
          value: wrapDiscordText(`${agentSettings.effort} (${agentSettings.effortSource})`),
          inline: true,
        },
      ]
    : [
        {
          name: "Codex session",
          value: wrapDiscordText(input.codexSessionId ?? "(not linked yet)"),
          inline: false,
        },
        {
          name: "Model",
          value: wrapDiscordText(modelSetting),
          inline: true,
        },
        {
          name: "Effort",
          value: wrapDiscordText(`${agentSettings.effort} (${agentSettings.effortSource})`),
          inline: true,
        },
      ];

  return messagePayload(
    {
      title: "Current channel target",
      color: execution.active ? COLORS.codex : COLORS.neutral,
      description: execution.active
        ? "이 채널의 agent 요청이 아직 실행 중입니다. 마지막 활동 시각으로 장시간 대기 여부를 확인할 수 있습니다."
        : "이 Discord 채널이 현재 어디에 연결되어 있는지 보여줍니다. 현재 실행 중인 agent 요청은 없습니다.",
      fields: [
        {
          name: "Mode",
          value: wrapDiscordText(input.channelMode),
          inline: true,
        },
        {
          name: "Timeout",
          value: wrapDiscordText(`${Math.round(input.timeoutMs / 1_000)}s`),
          inline: true,
        },
        ...executionFields,
        {
          name: "Target",
          value: `${wrapDiscordText(input.computerDisplayName)} / ${wrapDiscordText(input.workspaceDisplayName)}`,
          inline: false,
        },
        {
          name: "Workspace root",
          value: wrapDiscordText(input.workspaceRoot),
          inline: false,
        },
        {
          name: "Working directory",
          value: wrapDiscordText(input.cwd),
          inline: false,
        },
        ...sessionFields,
      ],
    },
    [
      actionRow([
        button({
          customId: COMPONENT_IDS.fileSystemRefresh,
          label: "파일 보기",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.codexAsk,
          label: "Codex에게 요청",
          style: BUTTON_STYLES.success,
        }),
      ]),
    ],
  );
}

function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function formatAgentSettingsResult(input: {
  agent: "codex" | "claude";
  scope: "main default" | "thread override";
  model: string | null;
  effort: string;
  modelSource: string;
  effortSource: string;
  updated?: "model" | "effort";
}): DiscordMessagePayload {
  const agentLabel = input.agent === "claude" ? "Claude Code" : "Codex";
  const modelSetting = input.model ? `${input.model} (${input.modelSource})` : "CLI default";

  return messagePayload({
    title: input.updated ? `${agentLabel} settings updated` : `${agentLabel} settings`,
    color: COLORS.success,
    description: input.scope === "main default"
      ? "이 컴퓨터의 main 기본값입니다. 별도 override가 없는 모든 세션에 적용되며 봇 재시작 후에도 유지됩니다."
      : "현재 스레드에 적용되는 값입니다. `default`로 설정하면 main 기본값을 다시 상속합니다.",
    fields: [
      {
        name: "Model",
        value: wrapDiscordText(modelSetting),
        inline: true,
      },
      {
        name: "Effort",
        value: wrapDiscordText(`${input.effort} (${input.effortSource})`),
        inline: true,
      },
      {
        name: "Scope",
        value: wrapDiscordText(input.scope),
        inline: true,
      },
    ],
  });
}

export function formatCodexRunModeResult(input: {
  mode: "default" | "fast" | "task";
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
}): DiscordMessagePayload {
  return messagePayload({
    title: "Codex mode updated",
    color: COLORS.success,
    description:
      input.mode === "default"
        ? "이 Discord 채널의 Codex 실행 모드를 기본 설정으로 되돌렸습니다. 기본 모드는 extra high reasoning입니다."
        : "이 Discord 채널의 이후 Codex 요청에 선택한 실행 모드를 사용합니다. 봇이 재시작되면 기본 모드로 돌아갑니다.",
    fields: [
      {
        name: "Mode",
        value: wrapDiscordText(input.mode),
        inline: true,
      },
      {
        name: "Reasoning",
        value: wrapDiscordText(input.reasoningEffort),
        inline: true,
      },
    ],
  });
}

export function formatSyncStatus(input: {
  workspaceCount: number;
  sessionChannelCount: number;
  archivedSessionCount: number;
  contextPostedCount: number;
  transcriptSyncMode: TranscriptSyncMode;
  transcriptSyncedChannelCount: number;
}): DiscordMessagePayload {
  return messagePayload(
    {
      title: "Codex sync status",
      color: COLORS.neutral,
      description: "현재 브리지 상태 파일에 기록된 동기화 요약입니다.",
      fields: [
        {
          name: "Categories",
          value: wrapDiscordText(String(input.workspaceCount)),
          inline: true,
        },
        {
          name: "Session channels",
          value: wrapDiscordText(String(input.sessionChannelCount)),
          inline: true,
        },
        {
          name: "Archived sessions",
          value: wrapDiscordText(String(input.archivedSessionCount)),
          inline: true,
        },
        {
          name: "Context previews posted",
          value: wrapDiscordText(String(input.contextPostedCount)),
          inline: true,
        },
        {
          name: "Transcript sync mode",
          value: wrapDiscordText(input.transcriptSyncMode),
          inline: true,
        },
        {
          name: "Transcript markers",
          value: wrapDiscordText(String(input.transcriptSyncedChannelCount)),
          inline: true,
        },
      ],
    },
    [
      actionRow([
        button({
          customId: COMPONENT_IDS.syncSelectDefault,
          label: "세션 선택 동기화",
          style: BUTTON_STYLES.secondary,
        }),
        button({
          customId: COMPONENT_IDS.syncAllDefault,
          label: "전체 동기화",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.deletePreview,
          label: "삭제 미리보기",
          style: BUTTON_STYLES.secondary,
        }),
      ]),
      transcriptSyncModeActions(),
    ],
  );
}

export function formatSyncModeResult(input: { mode: TranscriptSyncMode }): DiscordMessagePayload {
  return messagePayload(
    {
      title: "Transcript sync mode updated",
      color: COLORS.success,
      description:
        input.mode === "realtime"
          ? "동기화된 Codex 세션 채널을 주기적으로 확인해 새 desktop 대화 내용을 Discord에 반영합니다."
          : "실시간 폴링은 끄고, 동기화된 세션 채널에서 다시 채팅을 시작할 때 최신 desktop 대화 내용을 먼저 반영합니다.",
      fields: [
        {
          name: "Mode",
          value: wrapDiscordText(input.mode),
          inline: true,
        },
      ],
    },
    [transcriptSyncModeActions()],
  );
}

export function formatReloadConfirmation(): DiscordMessagePayload {
  return messagePayload(
    {
      title: "Bot restart confirmation",
      color: COLORS.queued,
      description:
        "기본 재시작은 실행 중 작업과 대기열이 끝날 때까지 기다립니다. 강제 재시작은 Codex/Claude와 그 하위 프로세스를 중단할 수 있습니다.",
      fields: [
        {
          name: "Safer option",
          value: codeBlock("reload commands", "text"),
          inline: false,
        },
        {
          name: "Restart command",
          value: codeBlock("reload restart confirm", "text"),
          inline: false,
        },
      ],
    },
    [
      actionRow([
        button({
          customId: COMPONENT_IDS.reloadCommands,
          label: "명령어만 재등록",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.reloadRestartConfirm,
          label: "작업 후 재시작",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: COMPONENT_IDS.reloadRestartForceConfirm,
          label: "강제 재시작",
          style: BUTTON_STYLES.danger,
        }),
      ]),
    ],
  );
}

export function formatReloadAck(input: { mode: "commands" | "restart"; force?: boolean }): DiscordMessagePayload {
  return messagePayload({
    title: "Bot reload started",
    color: COLORS.queued,
    description:
      input.mode === "restart"
        ? input.force
          ? "Discord slash command를 재등록한 뒤 실행 중 작업을 무시하고 봇을 강제로 재시작합니다."
          : "Discord slash command를 재등록한 뒤, 기존 작업이 모두 끝나면 봇을 재시작합니다."
        : "Discord slash command를 현재 실행 중인 봇 코드 기준으로 다시 등록합니다.",
    fields: [
      {
        name: "Mode",
        value: wrapDiscordText(input.mode),
        inline: true,
      },
    ],
  });
}

export function formatReloadResult(response: {
  result?: {
    mode: "commands" | "restart";
    commandCount: number;
    restarting: boolean;
    deferred?: boolean;
    forced?: boolean;
    activeCount?: number;
    pendingCount?: number;
    startedAt: string;
  };
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Bot reload failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown reload failure")),
    });
  }

  if (response.result.deferred) {
    return messagePayload({
      title: "Bot restart deferred",
      color: COLORS.queued,
      description:
        "실행 중이거나 대기 중인 Discord 작업이 있어 재시작을 보류했습니다. 새 작업은 받지 않고 기존 대기열이 모두 끝나면 자동으로 재시작합니다.",
      fields: [
        {
          name: "Active",
          value: wrapDiscordText(String(response.result.activeCount ?? 0)),
          inline: true,
        },
        {
          name: "Pending",
          value: wrapDiscordText(String(response.result.pendingCount ?? 0)),
          inline: true,
        },
        {
          name: "Process started",
          value: wrapDiscordText(response.result.startedAt),
          inline: false,
        },
      ],
    });
  }

  return messagePayload({
    title: "Bot reload complete",
    color: COLORS.success,
    description: response.result.restarting
      ? response.result.forced
        ? "강제 재시작 요청을 보냈습니다. 실행 중 작업과 대기 요청은 중단될 수 있습니다."
        : "재시작 요청을 보냈습니다. `pnpm connect start`로 실행 중이면 곧 새 프로세스로 돌아옵니다."
      : "Discord slash command 재등록이 완료되었습니다.",
    fields: [
      {
        name: "Mode",
        value: wrapDiscordText(response.result.mode),
        inline: true,
      },
      {
        name: "Slash commands",
        value: wrapDiscordText(String(response.result.commandCount)),
        inline: true,
      },
      {
        name: "Restarting",
        value: wrapDiscordText(response.result.restarting ? "yes" : "no"),
        inline: true,
      },
      ...(response.result.mode === "restart"
        ? [{
            name: "Forced",
            value: wrapDiscordText(response.result.forced ? "yes" : "no"),
            inline: true,
          }]
        : []),
      {
        name: "Process started",
        value: wrapDiscordText(response.result.startedAt),
        inline: false,
      },
    ],
  });
}

export function formatRestartDrainPending(): DiscordMessagePayload {
  return messagePayload({
    title: "Bot restart pending",
    color: COLORS.queued,
    description:
      "기존 작업이 끝난 뒤 봇을 재시작하도록 예약되어 있어 새 작업을 받을 수 없습니다. `/status`, `/queue`, `/interrupt`와 권한 응답은 계속 사용할 수 있습니다.",
  });
}

export function formatClearResult(response: {
  result?: {
    deletedCount: number;
    requestedCount?: number | null;
  };
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Message clear failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown message deletion failure")),
    });
  }

  return messagePayload({
    title: "Messages cleared",
    color: COLORS.success,
    fields: [
      {
        name: "Deleted",
        value: wrapDiscordText(String(response.result.deletedCount)),
        inline: true,
      },
      {
        name: "Requested",
        value: wrapDiscordText(
          response.result.requestedCount === null || response.result.requestedCount === undefined
            ? "all available"
            : String(response.result.requestedCount),
        ),
        inline: true,
      },
    ],
  });
}

export function formatClearConfirmation(): DiscordMessagePayload {
  return messagePayload({
    title: "Clear confirmation required",
    color: COLORS.queued,
    description: "관리자 채널의 가능한 최근 메시지를 모두 삭제하려면 확인 명령을 다시 실행하세요.",
    fields: [
      {
        name: "Confirm command",
        value: codeBlock("clear all confirm", "text"),
        inline: false,
      },
    ],
  });
}

export function formatNewChatAck(input: {
  name: string | null;
  cwd: string | null;
  useCategory: boolean;
  initialPrompt: string | null;
  channelMode?: ChannelMode;
}): DiscordMessagePayload {
  const agentLabel = input.channelMode === "claude-code" ? "Claude Code" : "Codex";

  return messagePayload({
    title: `Creating ${agentLabel} chat`,
    color: COLORS.codex,
    description:
      input.cwd || input.useCategory
        ? `지정한 작업 위치에 연결된 새 ${agentLabel} 스레드를 만드는 중입니다.`
        : `카테고리 없는 일반 ${agentLabel} 채팅 스레드를 만드는 중입니다.`,
    fields: [
      {
        name: "Name",
        value: wrapDiscordText(input.name ?? "(auto)"),
        inline: true,
      },
      {
        name: "Category",
        value: wrapDiscordText(input.useCategory ? "folder category" : "none"),
        inline: true,
      },
      {
        name: "Working directory",
        value: wrapDiscordText(input.cwd ?? "(default workspace)"),
        inline: false,
      },
      {
        name: "Initial prompt",
        value: wrapDiscordText(input.initialPrompt ? "provided" : "none"),
        inline: true,
      },
    ],
  });
}

export function formatNewChatResult(response: {
  result?: {
    discordChannelId: string;
    discordCategoryId: string | null;
    channelName: string;
    threadName: string;
    cwd: string;
    workspaceRoot: string;
    workspaceDisplayName: string;
    pendingSession: boolean;
    initialPrompt: string | null;
    discordDeliveryMode?: "channel" | "thread";
    channelMode?: ChannelMode;
  };
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Codex chat channel creation failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown new chat failure")),
    });
  }

  const targetLabel = response.result.discordDeliveryMode === "thread" ? "Thread" : "Channel";
  const agentLabel = response.result.channelMode === "claude-code" ? "Claude Code" : "Codex";

  const actions =
    response.result.channelMode === "claude-code"
      ? [
          actionRow([
            button({
              customId: COMPONENT_IDS.newGeneralChat,
              label: "일반 채팅 하나 더",
              style: BUTTON_STYLES.secondary,
            }),
          ]),
        ]
      : [
          actionRow([
            button({
              customId: COMPONENT_IDS.newGeneralChat,
              label: "일반 채팅 하나 더",
              style: BUTTON_STYLES.secondary,
            }),
            button({
              customId: COMPONENT_IDS.syncSelectDefault,
              label: "기존 세션 선택",
              style: BUTTON_STYLES.primary,
            }),
          ]),
        ];

  return messagePayload(
    {
      title: `${agentLabel} chat ${targetLabel.toLowerCase()} ready`,
      color: COLORS.success,
      description:
        response.result.discordDeliveryMode === "thread"
          ? response.result.channelMode === "claude-code"
            ? "새 Discord thread가 Claude Code 대화로 연결되었습니다. 그 thread에서 바로 메시지를 보내면 Claude Code로 이어집니다."
            : "새 Discord thread가 Codex 대기 세션으로 연결되었습니다. 그 thread에서 바로 메시지를 보내면 첫 응답 때 실제 Codex 세션 ID가 자동으로 붙습니다."
          : response.result.channelMode === "claude-code"
            ? "새 Discord 채널이 Claude Code 대화로 연결되었습니다. 그 채널에서 바로 메시지를 보내면 Claude Code로 이어집니다."
            : "새 Discord 채널이 Codex 대기 세션으로 연결되었습니다. 그 채널에서 바로 메시지를 보내면 첫 응답 때 실제 Codex 세션 ID가 자동으로 붙습니다.",
      fields: [
        {
          name: targetLabel,
          value: `<#${response.result.discordChannelId}>`,
          inline: true,
        },
        {
          name: "Category",
          value: wrapDiscordText(response.result.discordCategoryId ?? "none"),
          inline: true,
        },
        {
          name: "Name",
          value: wrapDiscordText(response.result.channelName),
          inline: true,
        },
        {
          name: "Workspace",
          value: wrapDiscordText(response.result.workspaceDisplayName),
          inline: true,
        },
        {
          name: "Working directory",
          value: wrapDiscordText(response.result.cwd),
          inline: false,
        },
        {
          name: "Next step",
          value: response.result.initialPrompt
            ? codeBlock(response.result.initialPrompt, "text")
            : codeBlock("새 채널에서 자연어로 바로 대화하세요. 예: 이 프로젝트 구조 설명해줘", "text"),
          inline: false,
        },
      ],
    },
    actions,
  );
}

export function formatForkSessionAck(input: {
  name: string;
  channelMode: ChannelMode;
  sourceSessionId: string | null;
}): DiscordMessagePayload {
  const agentLabel = input.channelMode === "claude-code" ? "Claude Code" : "Codex";

  return messagePayload({
    title: `${agentLabel} fork 준비 중`,
    color: COLORS.codex,
    description: "현재 세션을 새 Discord thread로 분기하는 중입니다.",
    fields: [
      {
        name: "New thread",
        value: wrapDiscordText(input.name),
        inline: true,
      },
      {
        name: "Source session",
        value: wrapDiscordText(input.sourceSessionId ?? "(not linked yet)"),
        inline: false,
      },
    ],
  });
}

export function formatForkSessionResult(response: {
  result?: {
    discordChannelId: string;
    threadName: string;
    cwd: string;
    workspaceDisplayName: string;
    channelMode?: ChannelMode;
  };
  sourceSessionId?: string | null;
  forkSessionId?: string | null;
  finalMessage?: string | null;
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Session fork failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown fork failure")),
    });
  }

  const agentLabel = response.result.channelMode === "claude-code" ? "Claude Code" : "Codex";
  const fields: DiscordEmbedFieldPayload[] = [
    {
      name: "Thread",
      value: `<#${response.result.discordChannelId}>`,
      inline: true,
    },
    {
      name: "Name",
      value: wrapDiscordText(response.result.threadName),
      inline: true,
    },
    {
      name: "Source session",
      value: wrapDiscordText(response.sourceSessionId ?? "(unknown)"),
      inline: false,
    },
    {
      name: "Fork session",
      value: wrapDiscordText(response.forkSessionId ?? "(pending)"),
      inline: false,
    },
    {
      name: "Working directory",
      value: wrapDiscordText(response.result.cwd),
      inline: false,
    },
  ];

  if (response.finalMessage?.trim()) {
    fields.push({
      name: `${agentLabel} response`,
      value: wrapDiscordText(response.finalMessage.trim()),
      inline: false,
    });
  }

  return messagePayload({
    title: `${agentLabel} fork ready`,
    color: COLORS.success,
    description: "새 Discord thread가 분기된 세션으로 연결되었습니다. 대화 맥락은 분리되지만 작업 디렉터리는 원본과 공유하므로, 두 thread에서 같은 파일을 동시에 수정하면 충돌할 수 있습니다.",
    fields,
  });
}

export function formatForkedSessionThreadNotice(input: {
  channelMode?: ChannelMode;
  sourceChannelId: string;
  sourceSessionId: string | null;
  forkSessionId: string | null;
  finalMessage?: string | null;
}): DiscordMessagePayload {
  const agentLabel = input.channelMode === "claude-code" ? "Claude Code" : "Codex";
  const fields: DiscordEmbedFieldPayload[] = [
    {
      name: "Forked from",
      value: `<#${input.sourceChannelId}>`,
      inline: true,
    },
    {
      name: "Source session",
      value: wrapDiscordText(input.sourceSessionId ?? "(unknown)"),
      inline: false,
    },
    {
      name: "Fork session",
      value: wrapDiscordText(input.forkSessionId ?? "(pending)"),
      inline: false,
    },
  ];

  if (input.finalMessage?.trim()) {
    fields.push({
      name: `${agentLabel} response`,
      value: wrapDiscordText(input.finalMessage.trim()),
      inline: false,
    });
  }

  return messagePayload({
    title: `${agentLabel} fork 연결됨`,
    color: COLORS.success,
    description: `이 스레드에 메시지를 보내면 분기된 ${agentLabel} 세션으로 이어집니다. 대화 맥락은 분리되지만 원본과 같은 작업 디렉터리를 사용합니다.`,
    fields,
  });
}

export function formatSyncAck(input: { limit: number }): DiscordMessagePayload {
  return messagePayload({
    title: "Codex session sync started",
    color: COLORS.codex,
    description: "Codex 세션을 읽고 Discord 카테고리/채널을 생성하는 중입니다.",
    fields: [
      {
        name: "Session limit",
        value: wrapDiscordText(String(input.limit)),
        inline: true,
      },
    ],
  });
}

export function formatSyncSelectionAck(input: { limit: number }): DiscordMessagePayload {
  return messagePayload({
    title: "Loading Codex session picker",
    color: COLORS.codex,
    description: "동기화할 Codex 세션 목록을 불러오는 중입니다.",
    fields: [
      {
        name: "Selection limit",
        value: wrapDiscordText(String(input.limit)),
        inline: true,
      },
    ],
  });
}

export interface SelectableCodexSession {
  id: string;
  threadName: string;
  updatedAt: string;
  workspaceDisplayName: string;
}

function truncateOptionText(value: string, fallback: string): string {
  const normalizedValue = value.trim() || fallback;
  return normalizedValue.slice(0, 100);
}

function sessionSelectionOptions(sessions: SelectableCodexSession[]): DiscordSelectOptionPayload[] {
  return sessions.slice(0, 25).map((session) => ({
    label: truncateOptionText(session.threadName, "Codex session"),
    value: session.id,
    description: truncateOptionText(`${session.workspaceDisplayName} · ${session.updatedAt}`, session.updatedAt),
  }));
}

function syncSelectionActions(sessions: SelectableCodexSession[]): DiscordActionRowPayload[] | undefined {
  const options = sessionSelectionOptions(sessions);

  if (options.length === 0) {
    return [
      actionRow([
        button({
          customId: COMPONENT_IDS.syncSelectDefault,
          label: "목록 새로고침",
          style: BUTTON_STYLES.secondary,
        }),
      ]),
    ];
  }

  return [
    actionRow([
      selectMenu({
        customId: COMPONENT_IDS.syncSelected,
        placeholder: "동기화할 Codex 세션 선택",
        minValues: 1,
        maxValues: options.length,
        options,
      }),
    ]),
    actionRow([
      button({
        customId: COMPONENT_IDS.syncSelectDefault,
        label: "목록 새로고침",
        style: BUTTON_STYLES.secondary,
      }),
      button({
        customId: COMPONENT_IDS.syncAllDefault,
        label: "전체 활성 세션 동기화",
        style: BUTTON_STYLES.primary,
      }),
    ]),
  ];
}

export function formatSyncSelection(input: {
  sessions: SelectableCodexSession[];
  totalAvailable: number;
  limit: number;
}): DiscordMessagePayload {
  return messagePayload(
    {
      title: "Select Codex sessions to sync",
      color: COLORS.codex,
      description:
        input.sessions.length > 0
          ? "드롭다운에서 가져올 Codex 세션을 여러 개 선택하세요. 선택한 세션만 Discord 채널로 생성됩니다."
          : "동기화할 활성 Codex 세션이 없습니다.",
      fields: [
        {
          name: "Shown sessions",
          value: wrapDiscordText(`${input.sessions.length} / ${input.totalAvailable}`),
          inline: true,
        },
        {
          name: "Selection limit",
          value: wrapDiscordText(String(input.limit)),
          inline: true,
        },
      ],
    },
    syncSelectionActions(input.sessions),
  );
}

export function formatSyncResultUpdate(response: {
  result?: {
    createdCategories: number;
    existingCategories: number;
    createdChannels: number;
    existingChannels: number;
    skippedSessions: number;
  };
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Codex session sync failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown sync failure")),
    });
  }

  return messagePayload(
    {
      title: "Codex session sync complete",
      color: COLORS.success,
      description: "Codex 폴더는 Discord 카테고리로, Codex 세션은 Discord 채널로 매핑되었습니다.",
      fields: [
        {
          name: "Created categories",
          value: wrapDiscordText(String(response.result.createdCategories)),
          inline: true,
        },
        {
          name: "Existing categories",
          value: wrapDiscordText(String(response.result.existingCategories)),
          inline: true,
        },
        {
          name: "Created channels",
          value: wrapDiscordText(String(response.result.createdChannels)),
          inline: true,
        },
        {
          name: "Existing channels",
          value: wrapDiscordText(String(response.result.existingChannels)),
          inline: true,
        },
        {
          name: "Skipped sessions",
          value: wrapDiscordText(String(response.result.skippedSessions)),
          inline: true,
        },
      ],
    },
    syncResultActions(),
  );
}

export function formatSyncProgressUpdate(progress: {
  phase: "syncing" | "complete";
  processedSessions: number;
  totalSessions: number;
  filteredSessions: number;
  currentSessionName?: string;
  createdCategories: number;
  existingCategories: number;
  createdChannels: number;
  existingChannels: number;
  skippedSessions: number;
}): DiscordMessagePayload {
  const fields: DiscordEmbedFieldPayload[] = [
    {
      name: "Progress",
      value: wrapDiscordText(`${progress.processedSessions} / ${progress.totalSessions}`),
      inline: true,
    },
    {
      name: "Filtered out",
      value: wrapDiscordText(String(progress.filteredSessions)),
      inline: true,
    },
    {
      name: "Created channels",
      value: wrapDiscordText(String(progress.createdChannels)),
      inline: true,
    },
    {
      name: "Existing channels",
      value: wrapDiscordText(String(progress.existingChannels)),
      inline: true,
    },
  ];

  if (progress.currentSessionName) {
    fields.push({
      name: "Current session",
      value: wrapDiscordText(progress.currentSessionName),
      inline: false,
    });
  }

  return messagePayload({
    title: "Codex session sync in progress",
    color: COLORS.codex,
    description: "활성 Codex 세션만 Discord 채널로 동기화하는 중입니다.",
    fields,
  });
}

export function formatDeletePreview(input: {
  mode: "all" | "channels" | "session";
  sessionId?: string | null;
  channelCount: number;
  categoryCount: number;
  channelNames: string[];
  categoryNames: string[];
  channelOptions?: Array<{
    sessionId: string;
    channelName: string;
    workspaceDisplayName: string;
    updatedAt: string;
  }>;
}): DiscordMessagePayload {
  const command =
    input.mode === "session" && input.sessionId
      ? `sync delete session ${input.sessionId} confirm`
      : input.mode === "channels"
        ? "sync delete channels confirm"
        : "sync delete all confirm";

  return messagePayload(
    {
      title: "Synced channel delete preview",
      color: COLORS.queued,
      description: `삭제될 Discord 리소스를 확인하세요. 아래 버튼으로 확정할 수 있습니다. Codex 세션 파일은 삭제하지 않습니다. 텍스트 명령은 \`${command}\` 입니다.`,
      fields: [
        {
          name: "Channels",
          value: wrapDiscordText(String(input.channelCount)),
          inline: true,
        },
        {
          name: "Categories",
          value: wrapDiscordText(String(input.categoryCount)),
          inline: true,
        },
        {
          name: "Channel names",
          value: codeBlock(input.channelNames.slice(0, 25).join("\n") || "(none)", "text"),
          inline: false,
        },
        {
          name: "Category names",
          value: codeBlock(input.categoryNames.slice(0, 25).join("\n") || "(none)", "text"),
          inline: false,
        },
      ],
    },
    deletePreviewActions(input),
  );
}

export function formatDeleteResult(response: {
  result?: {
    mode: "all" | "channels" | "session";
    sessionId?: string | null;
    deletedChannels: number;
    deletedCategories: number;
    missingChannels: number;
    missingCategories: number;
  };
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Synced channel delete failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown delete failure")),
    });
  }

  return messagePayload({
    title: "Synced channels deleted",
    color: COLORS.success,
    description: "Discord에 생성했던 동기화 채널을 삭제했습니다. 로컬 Codex 세션 파일은 그대로 유지됩니다.",
    fields: [
      {
        name: "Deleted channels",
        value: wrapDiscordText(String(response.result.deletedChannels)),
        inline: true,
      },
      {
        name: "Deleted categories",
        value: wrapDiscordText(String(response.result.deletedCategories)),
        inline: true,
      },
      {
        name: "Already missing channels",
        value: wrapDiscordText(String(response.result.missingChannels)),
        inline: true,
      },
      {
        name: "Already missing categories",
        value: wrapDiscordText(String(response.result.missingCategories)),
        inline: true,
      },
    ],
  });
}

export function formatDeleteAck(input: { mode: "all" | "channels" | "session" }): DiscordMessagePayload {
  return messagePayload({
    title: "Deleting synced channels",
    color: COLORS.queued,
    description:
      input.mode === "all"
        ? "동기화로 생성된 Discord 채널과 카테고리를 삭제하는 중입니다. Codex 세션 파일은 삭제하지 않습니다."
        : input.mode === "session"
          ? "선택한 동기화 세션 채널만 삭제하는 중입니다. 카테고리와 Codex 세션 파일은 유지합니다."
          : "동기화로 생성된 Discord 채널만 삭제하는 중입니다. 카테고리와 Codex 세션 파일은 유지합니다.",
    fields: [
      {
        name: "Mode",
        value: wrapDiscordText(input.mode),
        inline: true,
      },
    ],
  });
}

export function formatArchiveAck(input: { confirmed: boolean; sessionId?: string | null }): DiscordMessagePayload {
  return messagePayload(
    {
      title: input.confirmed ? "Archiving Codex session" : "Archive confirmation required",
      color: input.confirmed ? COLORS.queued : COLORS.neutral,
      description: input.confirmed
        ? "이 세션을 브리지 보관 목록에 추가하고 연결된 Discord 채널 매핑을 정리하는 중입니다. 로컬 Codex 세션 파일은 건드리지 않습니다."
        : "정말 보관하려면 아래 버튼을 누르거나 `archive confirm` 또는 `sync archive <session-id> confirm`을 사용하세요. 보관은 브리지 상태에 기록되어 다음 sync부터 제외됩니다.",
      fields: input.sessionId
        ? [
            {
              name: "Session",
              value: wrapDiscordText(input.sessionId),
              inline: true,
            },
          ]
        : [],
    },
    input.confirmed ? undefined : archiveSessionActions(),
  );
}

export function formatArchiveResult(response: {
  result?: {
    codexSessionId: string;
    deletedChannel: boolean;
    removedChannelMapping: boolean;
    wasAlreadyArchived: boolean;
  };
  error?: { message: string };
}): DiscordMessagePayload {
  if (response.error || !response.result) {
    return messagePayload({
      title: "Archive failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error?.message ?? "Unknown archive failure")),
    });
  }

  return messagePayload({
    title: "Codex session archived",
    color: COLORS.success,
    description: "이 세션은 다음 동기화부터 제외됩니다. 로컬 Codex 원본 세션 파일은 이동하거나 삭제하지 않았습니다.",
    fields: [
      {
        name: "Session",
        value: wrapDiscordText(response.result.codexSessionId),
        inline: true,
      },
      {
        name: "Discord channel deleted",
        value: wrapDiscordText(String(response.result.deletedChannel)),
        inline: true,
      },
      {
        name: "Already archived",
        value: wrapDiscordText(String(response.result.wasAlreadyArchived)),
        inline: true,
      },
    ],
  });
}

export function formatAgentAck(input: {
  computerDisplayName: string;
  workspaceDisplayName: string;
  cwd: string;
  prompt: string;
  agentLabel?: string;
}): DiscordMessagePayload {
  const progress = { status: "thinking" };
  return textPayload(agentProgressText(input, progress, `${agentLabel(input)} 작업 시작`));
}

function agentLabel(input: { agentLabel?: string }): string {
  return input.agentLabel?.trim() || "Codex";
}

function agentStatusLabel(status: string): string {
  switch (status) {
    case "thinking":
      return "요청 접수됨";
    case "session opened":
    case "thread.started":
      return "세션 연결됨";
    case "writing answer":
      return "답변 작성 중";
    case "turn.started":
    case "response.started":
      return "요청 분석 중";
    case "item.started":
      return "작업 단계 실행 중";
    case "item.completed":
      return "작업 단계 완료";
    case "turn.completed":
    case "response.completed":
      return "응답 정리 중";
    case "error":
      return "오류 확인 중";
    default:
      return /[._]/.test(status) ? "작업 중" : status;
  }
}

function compactMultiline(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function agentActivitySummary(status: string): string {
  const label = agentStatusLabel(status);

  if (label === "요청 접수됨") {
    return "생각중...";
  }

  if (label === "파일 탐색 중") {
    return "파일 탐색중...";
  }

  if (label === "파일 수정 중") {
    return "파일 편집중...";
  }

  return `${label}...`;
}

function filenameOnly(value: string): string {
  return path.basename(value.trim().replace(/^`|`$/g, "")) || value;
}

function renderProgressEvent(event: string): string {
  const trimmedEvent = event.trim();
  const fileEditMatch = trimmedEvent.match(/^편집함\s+(.+?)\s+\+(\d+)\s+-(\d+)$/);

  if (fileEditMatch) {
    const fileName = filenameOnly(fileEditMatch[1] ?? "");
    const additions = fileEditMatch[2] ?? "0";
    const deletions = fileEditMatch[3] ?? "0";
    return [`편집함 \`${fileName}\``, "```diff", `+${additions}`, `-${deletions}`, "```"].join("\n");
  }

  return trimmedEvent;
}

function agentProgressText(
  input: AgentProgressMessageInput,
  progress: AgentProgressState,
  title = "Codex 작업 중",
): string {
  const prompt = compactMultiline(input.prompt);
  const lines = [`**${title}**`, `진행: ${agentStatusLabel(progress.status)}`];

  if (prompt.length > 0) {
    lines.push("", "**요청**", `>>> ${prompt}`);
  }

  if (input.permissionSettings) {
    lines.push(
      "",
      "**권한 설정**",
      `approval=${input.permissionSettings.approvalPolicy}, reviewer=${input.permissionSettings.approvalsReviewer}, sandbox=${input.permissionSettings.sandbox}, network=${input.permissionSettings.networkAccess}`,
    );
  }

  const recentEvents =
    progress.recentEvents?.filter((event) => event.trim().length > 0).slice(-AGENT_PROGRESS_EVENT_LIMIT) ?? [];

  const latestEvent = recentEvents.at(-1);
  lines.push("", agentActivitySummary(progress.status));
  if (
    latestEvent &&
    latestEvent !== agentActivitySummary(progress.status)
  ) {
    lines.push(renderProgressEvent(latestEvent));
  }

  return lines.join("\n");
}

export function formatAgentProgressUpdate(
  input: AgentProgressMessageInput,
  progress: AgentProgressState,
): DiscordMessagePayload {
  return textPayload(agentProgressText(input, progress, `${agentLabel(input)} 작업 중`));
}

export function formatClaudeResumeSelection(input: {
  sessions: Array<{ id: string; firstUserMessage: string | null; cwd: string; updatedAt: string }>;
}): DiscordMessagePayload {
  if (input.sessions.length === 0) {
    return textPayload([
      "**클로드 세션 다시 열기**",
      "다시 열 수 있는 Claude Code 세션이 없습니다.",
    ].join("\n"));
  }

  const options = input.sessions.slice(0, 25).map((session) => {
    const title =
      session.firstUserMessage?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ||
      `세션 ${session.id.slice(0, 8)}`;
    const folder = session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd;
    const updated = session.updatedAt.replace("T", " ").slice(0, 16);

    return {
      label: title.slice(0, 95),
      value: session.id,
      description: `${folder} · ${updated}`.slice(0, 95),
    };
  });

  return {
    allowedMentions: { parse: [] },
    content: [
      "**클로드 세션 다시 열기**",
      `최근 세션 ${options.length}개 중에서 선택하면 Claude Code 채널 아래에 스레드로 다시 연결됩니다.`,
      "스레드를 지웠어도 세션 기록이 남아 있으면 대화가 그대로 이어집니다.",
    ].join("\n"),
    embeds: [],
    components: [
      actionRow([
        selectMenu({
          customId: COMPONENT_IDS.chatResumeSelected,
          placeholder: "다시 열 세션 선택...",
          options,
        }),
      ]),
    ],
  };
}

export function formatAgentMainChannelGuidance(input: {
  agentLabel: "Codex" | "Claude Code";
}): DiscordMessagePayload {
  return {
    allowedMentions: { parse: [] },
    content: [
      "**메인 채널에서는 바로 대화를 시작할 수 없습니다**",
      `${input.agentLabel} 세션은 스레드 단위로 관리됩니다. 아래 버튼으로 새 채팅을 만들어 거기서 대화해주세요.`,
      "지웠던 세션을 다시 열려면 `/chat-resume`을 사용하세요.",
    ].join("\n"),
    embeds: [],
    components: [
      actionRow([
        button({
          customId: COMPONENT_IDS.newCurrentFolderChat,
          label: "새 채팅 만들기",
          style: BUTTON_STYLES.primary,
        }),
        button({
          customId: "cdc:cwdpick:open",
          label: "📁 폴더 골라서 만들기",
          style: BUTTON_STYLES.secondary,
        }),
      ]),
    ],
  };
}

export function formatClaudeResumeAck(): DiscordMessagePayload {
  return textPayload("**클로드 세션 다시 열기**\n세션 스레드를 다시 여는 중...");
}

export function formatClaudeResumeResult(
  input:
    | { status: "created"; channelId: string; threadName: string }
    | { status: "already-linked"; channelId: string }
    | { status: "not-found" }
    | { status: "error"; message: string },
): DiscordMessagePayload {
  switch (input.status) {
    case "created":
      return textPayload([
        "**클로드 세션 스레드를 다시 열었습니다**",
        `<#${input.channelId}> 에서 이어서 대화하세요.`,
      ].join("\n"));
    case "already-linked":
      return textPayload([
        "**이미 연결된 스레드가 있습니다**",
        `<#${input.channelId}> 에서 이어서 대화하세요.`,
      ].join("\n"));
    case "not-found":
      return textPayload([
        "**세션을 찾을 수 없습니다**",
        "세션 기록이 삭제되었거나 다른 컴퓨터의 세션일 수 있습니다. `/chat-resume`로 목록을 다시 확인하세요.",
      ].join("\n"));
    default:
      return textPayload([
        "**세션 다시 열기 실패**",
        input.message,
      ].join("\n"));
  }
}

export function formatLiveAgentProgress(input: {
  agentLabel: "Codex" | "Claude Code";
  text: string;
  kind?: "message" | "thought";
  continued?: boolean;
}): DiscordMessagePayload {
  const heading = input.kind === "thought" ? "생각" : "진행";
  const suffix = input.continued ? " (계속)" : "";
  return textPayload(`**${input.agentLabel} ${heading}${suffix}**\n${input.text}`);
}

export function formatAgentResultPosted(input: {
  agentLabel: "Codex" | "Claude Code";
  failed: boolean;
}): DiscordMessagePayload {
  return textPayload([
    `**${input.agentLabel} 요청 처리 ${input.failed ? "실패" : "완료"}**`,
    input.failed ? "오류 내용을 아래 새 메시지에 표시했습니다." : "최종 답변을 아래 새 메시지에 표시했습니다.",
  ].join("\n"));
}

function getResultDetails(response: {
  result?: unknown;
  error?: { message: string };
}): {
  title: string;
  color: number;
  status: string;
  exitCode: string;
  stdout: string;
  stderr: string;
  cwd: string | null;
  ui: CommandUiPayload | null;
} {
  if (response.error) {
    return {
      title: "Command failed",
      color: COLORS.failure,
      status: "failed",
      exitCode: "",
      stdout: "",
      stderr: response.error.message,
      cwd: null,
      ui: null,
    };
  }

  const result = response.result as {
    status?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    cwd?: unknown;
    ui?: unknown;
  };
  const status = String(result.status ?? "unknown");
  const exitCode = String(result.exitCode ?? "");
  const failed = status === "failed" || (typeof result.exitCode === "number" && result.exitCode !== 0);

  return {
    title: failed ? "Command failed" : "Command completed",
    color: failed ? COLORS.failure : COLORS.success,
    status,
    exitCode,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    cwd: typeof result.cwd === "string" && result.cwd.length > 0 ? result.cwd : null,
    ui: normalizeCommandUi(result.ui),
  };
}

function commandUiFields(ui: CommandUiPayload | null): DiscordEmbedFieldPayload[] {
  if (!ui) {
    return [];
  }

  if (ui.kind === "file-browser") {
    const totalPages = Math.max(1, Math.ceil(ui.totalEntries / Math.max(1, ui.pageSize)));

    return [
      {
        name: "Browser page",
        value: wrapDiscordText(`${ui.page + 1} / ${totalPages}`),
        inline: true,
      },
      {
        name: "Entries",
        value: wrapDiscordText(String(ui.totalEntries)),
        inline: true,
      },
    ];
  }

  return [
    {
      name: "File",
      value: wrapDiscordText(ui.path),
      inline: false,
    },
  ];
}

export function formatCommandResultUpdate(
  input: {
    computerDisplayName: string;
    workspaceDisplayName: string;
    cwd: string;
    command: string;
    channelMode?: ChannelMode;
  },
  response: {
    result?: unknown;
    error?: { message: string };
  },
): DiscordMessagePayload {
  const result = getResultDetails(response);
  const outputFields: DiscordEmbedFieldPayload[] = [];
  const attachments: DiscordFilePayload[] = [];
  const failed = result.color === COLORS.failure;
  const channelMode = input.channelMode ?? "session-linked";

  if (result.stdout.trimEnd().length > 0) {
    const stdout = result.stdout.trimEnd();
    const attachmentName = "command-output.txt";
    const shouldAttach = stdout.length > ATTACH_TEXT_THRESHOLD;

    if (shouldAttach) {
      attachments.push(textAttachment(attachmentName, stdout));
    }

    outputFields.push({
      name: shouldAttach ? "Output preview" : "Output",
      value: shouldAttach
        ? previewCodeBlockWithAttachmentNotice({
            value: stdout,
            language: "text",
            attachmentName,
            label: "전체 출력",
          })
        : codeBlock(stdout, "text"),
      inline: false,
    });
  } else if (result.stderr.trimEnd().length === 0) {
    outputFields.push({
      name: "Output",
      value: wrapDiscordText("No output"),
      inline: false,
    });
  }

  if (result.stderr.trimEnd().length > 0) {
    const stderr = result.stderr.trimEnd();
    const attachmentName = "command-error.txt";
    const shouldAttach = stderr.length > ATTACH_TEXT_THRESHOLD;

    if (shouldAttach) {
      attachments.push(textAttachment(attachmentName, stderr));
    }

    outputFields.push({
      name: shouldAttach ? "Error preview" : "Errors",
      value: shouldAttach
        ? previewCodeBlockWithAttachmentNotice({
            value: stderr,
            language: "text",
            attachmentName,
            label: "전체 오류 출력",
          })
        : codeBlock(stderr, "text"),
      inline: false,
    });
  }

  const payload = messagePayload({
    title: result.title,
    color: result.color,
    fields: [
      ...formatCommandHeaderFields(result.cwd ?? input.cwd, input),
      {
        name: "Status",
        value: wrapDiscordText(result.status),
        inline: true,
      },
      {
        name: "Exit code",
        value: wrapDiscordText(result.exitCode),
        inline: true,
      },
      ...commandUiFields(result.ui),
      ...outputFields,
    ],
  }, [
    ...(fileSystemActions({
      command: input.command,
      stdout: result.stdout,
      failed,
      ui: result.ui,
      channelMode,
    }) ?? []),
    ...(commandWorkflowActions(input.command, failed, channelMode) ?? []),
  ]);

  if (attachments.length > 0) {
    payload.files = attachments;
  }

  return payload;
}

export function formatCommandResult(response: {
  result?: unknown;
  error?: { message: string };
}): DiscordMessagePayload {
  return formatCommandResultUpdate(
    {
      computerDisplayName: "Unknown computer",
      workspaceDisplayName: "Unknown workspace",
      cwd: "Unknown directory",
      command: "Unknown command",
    },
    response,
  );
}

export function formatAgentResultUpdate(
  input: AgentProgressMessageInput,
  response: {
    result?: unknown;
    error?: { message: string };
  },
): DiscordMessagePayload {
  const result = response.result as {
    status?: unknown;
    finalMessage?: unknown;
    sessionId?: unknown;
    stderr?: unknown;
    errorCode?: unknown;
  } | undefined;
  const failed = Boolean(response.error) || result?.status === "failed";
  const resultFinalMessage = typeof result?.finalMessage === "string" && result.finalMessage.trim().length > 0
    ? result.finalMessage
    : null;
  const resultStderr = typeof result?.stderr === "string" && result.stderr.trim().length > 0 ? result.stderr : null;
  const finalMessage = response.error?.message ?? resultFinalMessage ?? resultStderr ?? `${agentLabel(input)} did not return a final message.`;
  const sessionId = typeof result?.sessionId === "string" && result.sessionId.length > 0 ? result.sessionId : null;
  const errorCode = typeof result?.errorCode === "string" && result.errorCode.length > 0 ? result.errorCode : null;
  const fields: DiscordEmbedFieldPayload[] = [
    {
      name: "Target",
      value: `${wrapDiscordText(input.computerDisplayName)} / ${wrapDiscordText(input.workspaceDisplayName)}`,
      inline: false,
    },
    {
      name: "Working directory",
      value: wrapDiscordText(input.cwd),
      inline: false,
    },
    {
      name: "Prompt",
      value: codeBlock(input.prompt, "text"),
      inline: false,
    },
    {
      name: "Status",
      value: wrapDiscordText(failed ? "failed" : String(result?.status ?? "completed")),
      inline: true,
    },
  ];

  if (sessionId) {
    fields.push({
      name: "Session",
      value: wrapDiscordText(sessionId),
      inline: true,
    });
  }

  if (failed && errorCode) {
    fields.push({
      name: "Error code",
      value: wrapDiscordText(errorCode),
      inline: true,
    });
  }

  if (input.permissionSettings) {
    fields.push({
      name: "Permission settings",
      value: wrapDiscordText(
        `approval=${input.permissionSettings.approvalPolicy}, reviewer=${input.permissionSettings.approvalsReviewer}, sandbox=${input.permissionSettings.sandbox}, network=${input.permissionSettings.networkAccess}`,
      ),
      inline: false,
    });
  }

  const currentAgentLabel = agentLabel(input);
  const relayOutput = failed
    ? { cleanedText: finalMessage }
    : extractAgentRelayDecision(finalMessage);
  const surveyOutputs = failed
    ? { cleanedText: finalMessage, surveys: [], notices: [], hadBlocks: false }
    : extractAgentSurveyRequests(relayOutput.cleanedText);
  const discordSendOutputs = failed
    ? { cleanedText: finalMessage, attachments: [], messages: [], notices: [], hadBlocks: false }
    : extractCodexDiscordSendOutputs(surveyOutputs.cleanedText);
  const messageAfterDiscordSendBlocks = discordSendOutputs.cleanedText;
  const imageOutputs = failed ? { attachments: [], remoteUrls: [] } : extractImageOutputs(messageAfterDiscordSendBlocks);
  const mediaLinkOutputs = failed ? { attachments: [], notices: [] } : extractLocalMediaLinkOutputs(messageAfterDiscordSendBlocks);
  const visibleFinalMessage = stripAttachedLocalImageMarkdown(messageAfterDiscordSendBlocks);

  if (!failed) {
    const attachedFileCount =
      imageOutputs.attachments.length + discordSendOutputs.attachments.length + mediaLinkOutputs.attachments.length;
    const finalContent = [
      visibleFinalMessage,
      ...discordSendOutputs.messages,
      ...surveyOutputs.notices.map((notice) => `주의: ${notice}`),
      ...discordSendOutputs.notices.map((notice) => `주의: ${notice}`),
      ...mediaLinkOutputs.notices.map((notice) => `주의: ${notice}`),
      ...imageOutputs.remoteUrls,
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n") || (
        surveyOutputs.surveys.length > 0
          ? "아래 설문에서 선택해주세요."
          : attachedFileCount > 0
            ? "첨부 파일을 보냈습니다."
            : finalMessage
      );
    const finalTextChunks = splitDiscordMessageContent(finalContent);
    const finalTextForDiscord = finalTextChunks[0] ?? finalContent;
    const answerColor = currentAgentLabel === "Claude Code" ? 0x8e44ad : COLORS.codex;
    const continuationPayloads = finalTextChunks.slice(1).map((chunk) =>
      messagePayload({
        title: "답변 (계속)",
        color: answerColor,
        description: chunk,
      }),
    );
    const finalFiles = deduplicateDiscordFiles([
      ...discordSendOutputs.attachments,
      ...mediaLinkOutputs.attachments,
      ...imageOutputs.attachments,
    ]);
    const surveyPayloads = surveyOutputs.surveys.flatMap((survey) =>
      formatAgentSurveyMessages({
        agent: currentAgentLabel === "Claude Code" ? "claude" : "codex",
        survey,
        response: { kind: "followup" },
      }),
    );
    const metadataLines = [
      `**${currentAgentLabel} 작업 완료**`,
      `위치: ${wrapDiscordText(input.cwd)}`,
      sessionId
        ? `${currentAgentLabel === "Claude Code" ? "Claude session" : "세션 ID"}: ${wrapDiscordText(sessionId)}`
        : null,
    ].filter((line): line is string => Boolean(line));
    const payload: DiscordMessagePayload = {
      allowedMentions: { parse: [] },
      content: metadataLines.join("\n"),
      embeds: [
        {
          title: "답변",
          color: answerColor,
          description: finalTextForDiscord,
        },
      ],
    };

    registerAnswerCopyText(payload, finalContent);
    appendAgentResultContinuationMessages(payload, [
      ...continuationPayloads,
      ...discordFileOnlyPayloads(finalFiles),
      ...surveyPayloads,
    ]);

    return payload;
  }

  const payload = messagePayload({
    title: `${agentLabel(input)} failed`,
    color: COLORS.failure,
    description: truncateDescription(sanitizeDiscordMarkdown(finalMessage)),
    fields,
  });

  return payload;
}

function scheduleDescription(schedule: ScheduledCommandState): string {
  const spec = schedule.schedule;

  switch (spec.type) {
    case "once":
      return `once at ${spec.runAt}`;
    case "interval":
      return `every ${Math.round(spec.everyMs / 60_000)}m`;
    case "daily":
      return `daily at ${spec.time}`;
    case "weekly":
      return `weekly ${spec.weekdays.join(",")} at ${spec.time}`;
  }
}

export function formatScheduleResult(
  response: ScheduleCommandResult | { error: { message: string } },
): DiscordMessagePayload {
  if ("error" in response) {
    return messagePayload({
      title: "Schedule failed",
      color: COLORS.failure,
      description: truncateDescription(wrapDiscordText(response.error.message)),
    });
  }

  if (response.status === "listed") {
    return messagePayload({
      title: "Scheduled commands",
      color: COLORS.neutral,
      description:
        response.schedules.length === 0
          ? "등록된 schedule이 없습니다."
          : response.schedules
              .map((schedule) => `${schedule.id} · ${scheduleDescription(schedule)} · next ${schedule.nextRunAt}\n${schedule.command}`)
              .join("\n\n"),
    });
  }

  if (response.status === "deleted") {
    return messagePayload({
      title: response.deleted ? "Schedule deleted" : "Schedule not found",
      color: response.deleted ? COLORS.success : COLORS.neutral,
      fields: [
        {
          name: "ID",
          value: wrapDiscordText(response.id),
          inline: true,
        },
      ],
    });
  }

  return messagePayload({
    title: "Schedule created",
    color: COLORS.success,
    fields: [
      {
        name: "ID",
        value: wrapDiscordText(response.schedule.id),
        inline: true,
      },
      {
        name: "Next run",
        value: wrapDiscordText(response.schedule.nextRunAt),
        inline: true,
      },
      {
        name: "Schedule",
        value: wrapDiscordText(scheduleDescription(response.schedule)),
        inline: false,
      },
      {
        name: "Command",
        value: codeBlock(response.schedule.command, "text"),
        inline: false,
      },
    ],
  });
}
