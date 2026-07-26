import {
  localizeConnectorText,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";
import type {
  DiscordActionRowPayload,
  DiscordMessagePayload,
  DiscordSelectMenuPayload,
} from "./responses.js";

const ANSWER_TITLES = new Set([
  "답변",
  "답변 (계속)",
  "중간 답변",
  "중간 답변 (계속)",
  "Answer",
  "Answer (continued)",
  "Intermediate answer",
  "Intermediate answer (continued)",
  "中间答复",
  "中间答复（续）",
  "中間回答",
  "中間回答（続き）",
]);
const RAW_FIELD_NAMES = new Set([
  "Prompt",
  "Command",
  "Output",
  "Error output",
  "Standard output",
  "Standard error",
]);

function isAgentSurvey(component: DiscordSelectMenuPayload): boolean {
  return component.custom_id.startsWith("cdc:agent:survey:") ||
    component.custom_id.startsWith("cdc:codex:user-input:");
}

function hasAgentAuthoredDescription(title: string): boolean {
  return ANSWER_TITLES.has(title) ||
    title.endsWith(" failed") ||
    title.endsWith(" 작업 실패") ||
    title.startsWith("Codex 질문") ||
    title.startsWith("Codex question");
}

function localizeComponents(rows: DiscordActionRowPayload[] | undefined, locale: ConnectorLocale): void {
  for (const row of rows ?? []) {
    for (const component of row.components) {
      if (component.type === 2) {
        component.label = localizeConnectorText(component.label, locale);
        continue;
      }

      component.placeholder = localizeConnectorText(component.placeholder, locale);
      if (isAgentSurvey(component)) {
        continue;
      }

      for (const option of component.options) {
        option.label = localizeConnectorText(option.label, locale);
        if (option.description) {
          option.description = localizeConnectorText(option.description, locale);
        }
      }
    }
  }
}

export function localizeDiscordPayload(
  payload: DiscordMessagePayload,
  locale: ConnectorLocale,
): DiscordMessagePayload {
  if (locale === "ko") {
    return payload;
  }

  if (payload.content) {
    payload.content = localizeConnectorText(payload.content, locale);
  }

  for (const embed of payload.embeds) {
    const originalTitle = embed.title;
    embed.title = localizeConnectorText(embed.title, locale);

    if (
      embed.description &&
      !hasAgentAuthoredDescription(originalTitle)
    ) {
      embed.description = localizeConnectorText(embed.description, locale);
    }

    for (const field of embed.fields ?? []) {
      const originalName = field.name;
      field.name = localizeConnectorText(field.name, locale);
      if (!RAW_FIELD_NAMES.has(originalName)) {
        field.value = localizeConnectorText(field.value, locale);
      }
    }
  }

  localizeComponents(payload.components, locale);
  return payload;
}

export function localizeDiscordOutgoing(
  message: string | DiscordMessagePayload,
  locale: ConnectorLocale,
): string | DiscordMessagePayload {
  return typeof message === "string"
    ? localizeConnectorText(message, locale)
    : localizeDiscordPayload(message, locale);
}

export function localizeDiscordModal<T>(modal: T, locale: ConnectorLocale): T {
  if (locale === "ko" || typeof modal !== "object" || modal === null) {
    return modal;
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value !== "object" || value === null) {
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["title", "label", "placeholder"]) {
      if (typeof record[key] === "string") {
        record[key] = localizeConnectorText(record[key] as string, locale);
      }
    }

    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  visit(modal);
  return modal;
}
