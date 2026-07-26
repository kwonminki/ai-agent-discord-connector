import type { ClaudeSessionNotificationRecord } from "../../local-agent/src/directWorkerStore.js";
import { prepareAgentCompletionAnswer } from "./agentCompletionAnswer.js";
import type { DiscordGuildSurface } from "./codexSessionSync.js";
import {
  appendAgentResultContinuationMessages,
  discordFileOnlyPayloads,
  getAgentResultContinuationMessages,
  isAgentQuestionMessage,
  registerAnswerCopyText,
  type DiscordMessagePayload,
} from "./responses.js";

const CLAUDE_ANSWER_EMBED_COLOR = 0x8e44ad;
const CODEX_ANSWER_EMBED_COLOR = 0x2ecc71;

export interface ClaudeIdleNotificationSource {
  readPendingClaudeSessionNotifications(): Promise<Array<{
    controlKey: string;
    records: ClaudeSessionNotificationRecord[];
    totalCount: number;
  }>>;
  ackClaudeSessionNotifications(controlKey: string, deliveredCount: number): Promise<void>;
}

export interface DeliverClaudeIdleNotificationsInput {
  guild: Pick<DiscordGuildSurface, "sendTextMessage">;
  source: ClaudeIdleNotificationSource;
  mentionRoleIds?: string[];
}

export interface DeliverClaudeIdleNotificationsResult {
  pendingChannels: number;
  deliveredNotifications: number;
}

export function formatClaudeIdleNotification(
  record: ClaudeSessionNotificationRecord,
): DiscordMessagePayload {
  const agent = record.agent === "codex" ? "codex" : "claude";
  const agentName = agent === "codex" ? "Codex" : "Claude Code";
  const preparedAnswer = prepareAgentCompletionAnswer({
    agent,
    answer: record.message,
    attachmentName: `${agent}-answer.txt`,
  });
  const lines = [
    record.isError
      ? `**${agentName} 세션 알림 (오류)** — 예약·백그라운드 작업`
      : `**${agentName} 세션 알림** — 예약·백그라운드 작업이 결과를 보냈습니다`,
    ...(record.sessionId ? [`${agentName} session: \`${record.sessionId}\``] : []),
  ];

  const payload: DiscordMessagePayload = {
    allowedMentions: { parse: [] },
    content: lines.join("\n"),
    embeds: [
      {
        title: "알림 내용",
        color: agent === "codex" ? CODEX_ANSWER_EMBED_COLOR : CLAUDE_ANSWER_EMBED_COLOR,
        description: preparedAnswer.description,
      },
    ],
    components: [],
  };

  registerAnswerCopyText(payload, preparedAnswer.answer);

  if (preparedAnswer.files.length > 0) {
    appendAgentResultContinuationMessages(payload, discordFileOnlyPayloads(preparedAnswer.files));
  }

  if (preparedAnswer.surveyMessages.length > 0) {
    appendAgentResultContinuationMessages(payload, preparedAnswer.surveyMessages);
  }

  return payload;
}

export async function deliverClaudeIdleNotifications(
  input: DeliverClaudeIdleNotificationsInput,
): Promise<DeliverClaudeIdleNotificationsResult> {
  if (!input.guild.sendTextMessage) {
    return { pendingChannels: 0, deliveredNotifications: 0 };
  }

  const pending = await input.source.readPendingClaudeSessionNotifications();
  let deliveredNotifications = 0;

  for (const channelBatch of pending) {
    const alreadyDelivered = channelBatch.totalCount - channelBatch.records.length;
    let deliveredInChannel = 0;

    try {
      for (const record of channelBatch.records) {
        const notification = formatClaudeIdleNotification(record);
        const continuations = getAgentResultContinuationMessages(notification);
        const mentionRoleIds =
          input.mentionRoleIds?.filter((roleId) => roleId.trim().length > 0) ?? [];

        if (mentionRoleIds.length > 0) {
          await input.guild.sendTextMessage(record.controlKey, notification, { mentionRoleIds });
        } else {
          await input.guild.sendTextMessage(record.controlKey, notification);
        }

        for (const continuation of continuations) {
          if (isAgentQuestionMessage(continuation) && mentionRoleIds.length > 0) {
            await input.guild.sendTextMessage(record.controlKey, continuation, { mentionRoleIds });
          } else {
            await input.guild.sendTextMessage(record.controlKey, continuation);
          }
        }

        deliveredInChannel += 1;
        deliveredNotifications += 1;
      }
    } finally {
      if (deliveredInChannel > 0) {
        await input.source
          .ackClaudeSessionNotifications(channelBatch.controlKey, alreadyDelivered + deliveredInChannel)
          .catch((error) => {
            console.warn("failed to ack Claude idle notifications", error);
          });
      }
    }
  }

  return { pendingChannels: pending.length, deliveredNotifications };
}
