import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DiscordActionRowPayload,
  DiscordMessagePayload,
  DiscordSelectOptionPayload,
} from "./responses.js";

// Directory picker for the new-chat flow: the current path and page live in
// the message content itself, so navigation stays stateless across bot
// restarts — each interaction parses the state back out of the message.

export const CWD_PICKER_IDS = {
  open: "cdc:cwdpick:open",
  enter: "cdc:cwdpick:enter",
  up: "cdc:cwdpick:up",
  home: "cdc:cwdpick:home",
  pagePrev: "cdc:cwdpick:page:prev",
  pageNext: "cdc:cwdpick:page:next",
  confirm: "cdc:cwdpick:confirm",
  cancel: "cdc:cwdpick:cancel",
} as const;

const CWD_PICKER_PREFIX = "cdc:cwdpick:";
const PAGE_SIZE = 20;
const MAX_OPTION_NAME_CHARS = 80;

export function isCwdPickerComponent(customId: string): boolean {
  return customId.startsWith(CWD_PICKER_PREFIX);
}

export interface CwdPickerState {
  path: string;
  page: number;
  name: string | null;
  prompt: string | null;
}

const MAX_ENCODED_OPTIONS_CHARS = 1_200;

function encodeCwdPickerOptions(input: { name?: string | null; prompt?: string | null }): {
  line: string | null;
  promptDropped: boolean;
} {
  const name = input.name?.trim() || null;
  const prompt = input.prompt?.trim() || null;

  if (!name && !prompt) {
    return { line: null, promptDropped: false };
  }

  const fullEncoding = encodeURIComponent(JSON.stringify({ name, prompt }));

  if (fullEncoding.length <= MAX_ENCODED_OPTIONS_CHARS) {
    return { line: `-# cdc-opts:${fullEncoding}`, promptDropped: false };
  }

  const nameOnlyEncoding = encodeURIComponent(JSON.stringify({ name, prompt: null }));
  return {
    line: name && nameOnlyEncoding.length <= MAX_ENCODED_OPTIONS_CHARS
      ? `-# cdc-opts:${nameOnlyEncoding}`
      : null,
    promptDropped: Boolean(prompt),
  };
}

function decodeCwdPickerOptions(content: string | null | undefined): {
  name: string | null;
  prompt: string | null;
} {
  const optionsMatch = content?.match(/-# cdc-opts:(\S+)/);

  if (!optionsMatch?.[1]) {
    return { name: null, prompt: null };
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(optionsMatch[1])) as {
      name?: unknown;
      prompt?: unknown;
    };
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      prompt: typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : null,
    };
  } catch {
    return { name: null, prompt: null };
  }
}

export function parseCwdPickerState(content: string | null | undefined): CwdPickerState | null {
  const pathMatch = content?.match(/📁 `([^`]+)`/);

  if (!pathMatch?.[1]?.trim()) {
    return null;
  }

  const pageMatch = content?.match(/페이지 (\d+)\/(\d+)/);
  const page = Number.parseInt(pageMatch?.[1] ?? "1", 10);

  return {
    path: pathMatch[1].trim(),
    page: Number.isFinite(page) && page > 0 ? page : 1,
    ...decodeCwdPickerOptions(content),
  };
}

export function cwdPickerHomePath(): string {
  return os.homedir();
}

export function cwdPickerParentPath(currentPath: string): string {
  return path.dirname(path.resolve(currentPath));
}

export function cwdPickerChildPath(currentPath: string, childName: string): string {
  const child = path.basename(childName.trim());

  if (!child || child === "." || child === "..") {
    return path.resolve(currentPath);
  }

  return path.join(path.resolve(currentPath), child);
}

export async function listCwdPickerSubdirectories(targetPath: string): Promise<{
  dirs: string[];
  error: string | null;
}> {
  try {
    const entries = await readdir(path.resolve(targetPath), { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name.length <= MAX_OPTION_NAME_CHARS)
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));

    return { dirs, error: null };
  } catch (error) {
    return {
      dirs: [],
      error: error instanceof Error ? error.message : "폴더를 읽을 수 없습니다.",
    };
  }
}

function pickerButton(customId: string, label: string, style: number): DiscordActionRowPayload["components"][number] {
  return { type: 2, custom_id: customId, label, style };
}

export async function buildCwdPickerPayload(input: {
  path: string;
  page?: number;
  name?: string | null;
  prompt?: string | null;
}): Promise<DiscordMessagePayload> {
  const resolvedPath = path.resolve(input.path);
  const { dirs, error } = await listCwdPickerSubdirectories(resolvedPath);
  const totalPages = Math.max(1, Math.ceil(dirs.length / PAGE_SIZE));
  const page = Math.min(Math.max(input.page ?? 1, 1), totalPages);
  const visibleDirs = dirs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const options = encodeCwdPickerOptions({ name: input.name, prompt: input.prompt });
  const trimmedName = input.name?.trim();

  const contentLines = [
    "**새 채팅 폴더 선택**",
    `📁 \`${resolvedPath}\``,
    `하위 폴더 ${dirs.length}개 · 페이지 ${page}/${totalPages}`,
    ...(trimmedName ? [`이름: ${trimmedName}`] : []),
    ...(options.promptDropped ? ["⚠️ 첫 프롬프트가 너무 길어 제외했습니다. 채팅 생성 후 직접 보내주세요."] : []),
    error
      ? `⚠️ ${error}`
      : visibleDirs.length > 0
        ? "메뉴에서 하위 폴더로 이동하거나, 이 폴더로 결정하세요."
        : "이동할 하위 폴더가 없습니다. 이 폴더로 결정하거나 상위로 이동하세요.",
    ...(options.line ? [options.line] : []),
  ];

  const navigationSelect: DiscordActionRowPayload[] = visibleDirs.length > 0
    ? [{
        type: 1,
        components: [{
          type: 3,
          custom_id: CWD_PICKER_IDS.enter,
          placeholder: "하위 폴더로 이동...",
          min_values: 1,
          max_values: 1,
          options: visibleDirs.map((name): DiscordSelectOptionPayload => ({
            label: `📁 ${name}`.slice(0, 100),
            value: name,
          })),
        }],
      }]
    : [];

  const navigationButtons: DiscordActionRowPayload = {
    type: 1,
    components: [
      pickerButton(CWD_PICKER_IDS.up, "⬆️ 상위 폴더", 2),
      pickerButton(CWD_PICKER_IDS.home, "🏠 홈", 2),
      ...(totalPages > 1
        ? [
            pickerButton(CWD_PICKER_IDS.pagePrev, "◀ 이전", 2),
            pickerButton(CWD_PICKER_IDS.pageNext, "다음 ▶", 2),
          ]
        : []),
    ],
  };

  const decisionButtons: DiscordActionRowPayload = {
    type: 1,
    components: [
      pickerButton(CWD_PICKER_IDS.confirm, "✅ 이 폴더로 새 채팅", 3),
      pickerButton(CWD_PICKER_IDS.cancel, "취소", 2),
    ],
  };

  return {
    allowedMentions: { parse: [] },
    content: contentLines.join("\n"),
    embeds: [],
    components: [...navigationSelect, navigationButtons, decisionButtons],
  };
}
