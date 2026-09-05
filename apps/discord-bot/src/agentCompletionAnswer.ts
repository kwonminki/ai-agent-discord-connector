import {
  extractCodexDiscordSendOutputs,
  extractLocalMediaLinkOutputs,
  formatAgentSurveyMessages,
  type DiscordFilePayload,
  type DiscordMessagePayload,
} from "./responses.js";
import { extractAgentSurveyRequests } from "./agentSurvey.js";
import {
  splitDiscordMessageContent,
  stripHarnessBuilderBlocks,
} from "../../../packages/core/src/index.js";

const DEFAULT_MAX_PREVIEW_CHARS = 3_800;

function sanitizeDiscordText(value: string): string {
  return value.replace(/@/g, "[at]").trimEnd();
}

export interface AgentCompletionAnswer {
  answer: string;
  description: string;
  continuationDescriptions: string[];
  files: DiscordFilePayload[];
  surveyMessages: DiscordMessagePayload[];
  clipped: boolean;
}

export function prepareAgentCompletionAnswer(input: {
  answer: string;
  agent: "codex" | "claude";
  attachmentName: string;
  maxPreviewChars?: number;
}): AgentCompletionAnswer {
  const answerWithoutHarnessBlocks = stripHarnessBuilderBlocks(input.answer);
  const visibleInputAnswer = answerWithoutHarnessBlocks || (
    answerWithoutHarnessBlocks !== input.answer
      ? "Harness Builder가 설계 상태를 갱신했습니다."
      : input.answer
  );
  const surveyOutputs = extractAgentSurveyRequests(visibleInputAnswer);
  const discordSendOutputs = extractCodexDiscordSendOutputs(surveyOutputs.cleanedText);
  const mediaLinkOutputs = extractLocalMediaLinkOutputs(discordSendOutputs.cleanedText);
  const extractedFiles = [...discordSendOutputs.attachments, ...mediaLinkOutputs.attachments];
  const answer = !surveyOutputs.hadBlocks && !discordSendOutputs.hadBlocks && mediaLinkOutputs.notices.length === 0
    ? visibleInputAnswer
    : [
        discordSendOutputs.cleanedText,
        ...surveyOutputs.notices.map((notice) => `주의: ${notice}`),
        ...discordSendOutputs.messages,
        ...discordSendOutputs.notices.map((notice) => `주의: ${notice}`),
        ...mediaLinkOutputs.notices.map((notice) => `주의: ${notice}`),
      ]
        .filter((line) => line.trim().length > 0)
        .join("\n") || (
          surveyOutputs.surveys.length > 0
            ? "아래 설문에서 선택해주세요."
            : extractedFiles.length > 0
              ? "첨부 파일을 보냈습니다."
              : visibleInputAnswer
        );
  const sanitizedAnswer = sanitizeDiscordText(answer);
  const maxPreviewChars = input.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS;
  const chunks = splitDiscordMessageContent(sanitizedAnswer, maxPreviewChars);
  const description = chunks[0] ?? "응답 내용이 없습니다.";
  const continuationDescriptions = chunks.slice(1);
  const clipped = continuationDescriptions.length > 0;
  const files = extractedFiles;
  const surveyMessages = surveyOutputs.surveys.flatMap((survey) =>
    formatAgentSurveyMessages({
      agent: input.agent,
      survey,
      response: { kind: "followup" },
    }),
  );

  return { answer, description, continuationDescriptions, files, surveyMessages, clipped };
}
