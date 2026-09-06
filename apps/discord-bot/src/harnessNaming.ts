import { sanitizeDiscordThreadName } from "./codexSessionSync.js";

const MAX_DISCORD_THREAD_NAME_LENGTH = 100;
const NAME_SEPARATOR = " · ";

function automaticHarnessThreadName(sourceName: string | null | undefined, suffix: string): string {
  const safeSource = sanitizeDiscordThreadName(sourceName ?? "", "작업");
  const safeSuffix = sanitizeDiscordThreadName(suffix, "Harness");
  const sourceLimit = Math.max(
    1,
    MAX_DISCORD_THREAD_NAME_LENGTH - NAME_SEPARATOR.length - safeSuffix.length,
  );
  const clippedSource = safeSource.slice(0, sourceLimit).trim();
  return sanitizeDiscordThreadName(
    `${clippedSource || "작업"}${NAME_SEPARATOR}${safeSuffix}`,
    safeSuffix,
  );
}

export function harnessBuilderThreadName(input: {
  sourceName?: string | null;
  requestedName?: string | null;
}): string {
  const requestedName = input.requestedName?.trim();
  return requestedName
    ? sanitizeDiscordThreadName(requestedName, "Harness Builder")
    : automaticHarnessThreadName(input.sourceName, "🧩 Harness Builder");
}

export function harnessRunThreadName(input: {
  sourceName?: string | null;
  harnessName: string;
  version: string;
  requestedName?: string | null;
}): string {
  const requestedName = input.requestedName?.trim();
  if (requestedName) {
    return sanitizeDiscordThreadName(requestedName, "Harness Run");
  }

  const harnessName = sanitizeDiscordThreadName(input.harnessName, "Harness");
  return automaticHarnessThreadName(
    input.sourceName,
    `🧰 ${harnessName} v${input.version}`,
  );
}
