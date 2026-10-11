import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ConnectorLocale } from "../../../packages/core/src/index.js";
import type { ManagedDiscordChannelContext } from "./channelContext.js";
import type { DiscordMessageLike } from "./messageHandler.js";
import type { DiscordMessagePayload } from "./responses.js";
import { isOrcaAgent, sameOrcaTarget, type OrcaClient, type OrcaTarget } from "./orcaClient.js";

const targetSchema = z.object({
  runtimeId: z.string(), handle: z.string(), incarnationId: z.string(), executionHostId: z.string(),
  agentIdentity: z.string(), title: z.string(), worktreePath: z.string(),
  connected: z.boolean(), writable: z.boolean(), orphaned: z.boolean(),
});
const stateSchema = z.object({
  version: z.literal(1),
  bindings: z.record(targetSchema),
  receipts: z.record(z.object({ at: z.number(), status: z.enum(["pending", "accepted", "unknown", "rejected"]) })),
});
type State = z.infer<typeof stateSchema>;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_EPOCH = 1420070400000n;

export type OrcaCommand = { action: "list" | "status" | "read" | "disconnect" | "connect" | "select" | "send" | "invalid"; value?: string };
export function parseOrcaCommand(content: string): OrcaCommand | null {
  const match = content.trim().match(/^\/?orca(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const action = (match[1] ?? "list").toLowerCase();
  const value = match[2]?.trim();
  if (["list", "status", "read", "disconnect"].includes(action) && !value) return { action: action as OrcaCommand["action"] };
  if (action === "connect" && /^term_[A-Za-z0-9_-]{1,100}$/.test(value ?? "")) return { action, value };
  if (action === "select" && /^[a-f0-9-]{36}$/.test(value ?? "")) return { action, value };
  if (action === "send" && value) return { action, value };
  return { action: "invalid" };
}

export interface OrcaBridge {
  handle(message: DiscordMessageLike, context: ManagedDiscordChannelContext, busy: () => boolean): Promise<boolean>;
}

export function createOrcaBridge(input: {
  client?: OrcaClient;
  file: string;
  locale?: ConnectorLocale;
  now?: () => number;
}): OrcaBridge {
  const now = input.now ?? Date.now;
  const t = (ko: string, en: string) => input.locale === "en" ? en : ko;
  let tail: Promise<unknown> = Promise.resolve();
  const selections = new Map<string, { channelId: string; userId: string; expires: number; target: OrcaTarget }>();
  async function read(): Promise<State> {
    try { return stateSchema.parse(JSON.parse(await readFile(input.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bindings: {}, receipts: {} };
      throw new Error(t("Orca 연결 파일을 읽을 수 없습니다. 복구 전에는 입력을 보내지 않습니다.", "Cannot read Orca bindings. Input is blocked until the state file is repaired."));
    }
  }
  async function save(state: State) {
    await mkdir(path.dirname(input.file), { recursive: true, mode: 0o700 });
    const temporary = `${input.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, input.file);
    } finally { await rm(temporary, { force: true }); }
  }
  function panel(description: string, refresh = false): DiscordMessagePayload {
    return {
      allowedMentions: { parse: [] },
      embeds: [{ title: "Orca", color: 0x3498db, description }],
      ...(refresh ? { components: [{ type: 1 as const, components: [
        { type: 2 as const, style: 2, label: t("화면 확인", "Read screen"), custom_id: "cdc:orca:read" },
        { type: 2 as const, style: 2, label: t("연결 해제", "Disconnect"), custom_id: "cdc:orca:disconnect" },
      ] }] } : {}),
    };
  }
  function label(target: OrcaTarget) {
    return `**${target.title.replace(/[*`\n\r]/g, "").slice(0, 100)}**\n\`${target.handle}\` · ${target.agentIdentity}\n${target.executionHostId}`;
  }
  async function checked(target: OrcaTarget) {
    const live = await input.client!.show(target.handle);
    if (!isOrcaAgent(live) || !sameOrcaTarget(target, live)) {
      throw new Error(t("터미널이 종료되거나 바뀌었습니다. /orca에서 다시 선택하세요. 자동 재연결하지 않았습니다.", "The terminal ended or changed. Select it again with /orca. It was not automatically rebound."));
    }
    return live;
  }
  async function process(message: DiscordMessageLike, context: ManagedDiscordChannelContext, busy: () => boolean): Promise<boolean> {
    const command = parseOrcaCommand(message.content);
    const state = await read();
    const bound = state.bindings[message.channelId];
    if (!command && !bound) return false;
    const reply = (text: string, refresh = false) => message.reply(panel(text, refresh));
    if (message.authorBot || message.relayRequest) {
      await reply(t("Orca 연결 채널은 사람의 직접 입력만 받습니다.", "Orca-bound channels accept direct human input only."));
      return true;
    }
    if (context.allowedRoleIds.length && !context.allowedRoleIds.some((role) => message.roleIds.includes(role))) {
      await reply(t("이 채널을 조작할 권한이 없습니다.", "You do not have an allowed role for this channel."));
      return true;
    }
    if (command?.action === "disconnect") {
      delete state.bindings[message.channelId];
      await save(state);
      await reply(t("Orca 연결을 해제했습니다. 다음 입력은 일반 봇으로 처리됩니다.", "Orca disconnected. Subsequent messages use the regular connector."));
      return true;
    }
    if (!input.client) {
      await reply(t("Orca 연결은 Direct 모드에서 사용할 수 있습니다. CONNECT_ORCA_ENABLED=false이면 설정을 켜고 Gateway를 재시작하세요.", "Orca requires Direct mode. If CONNECT_ORCA_ENABLED=false, enable it and restart the gateway."));
      return true;
    }
    if (command?.action === "invalid") {
      await reply("/orca · /orca connect <terminal> · /orca status · /orca read · /orca disconnect · /orca send <text>");
      return true;
    }
    if (command?.action === "list") {
      const listed = await input.client.list();
      const available = listed.terminals.filter(isOrcaAgent).slice(0, 25);
      for (const [key, entry] of selections) if (entry.expires < now() || entry.channelId === message.channelId) selections.delete(key);
      const payload = panel(t("이 채널에서 답변할 Codex / Claude 터미널을 선택하세요. 연결 후 일반 메시지가 그 터미널에 입력됩니다. 이 채널의 허용 역할을 가진 사람들과 화면/입력을 공유합니다.", "Choose the Codex / Claude terminal for this channel. Ordinary messages will be typed there. Screen and input access are shared with this channel’s allowed roles.") +
        (bound ? `\n\n${t("현재 연결", "Current binding")}:\n${label(bound)}` : "") +
        (!available.length ? `\n\n${t("연결 가능한 터미널이 없습니다. Orca에서 Codex 또는 Claude를 실행하세요.", "No eligible terminals. Start Codex or Claude in Orca.")}` : "") +
        (listed.truncated || listed.terminals.filter(isOrcaAgent).length > 25 ? `\n\n${t("처음 25개만 표시합니다. 나머지는 /orca connect <handle>로 연결하세요.", "Showing up to 25. Use /orca connect <handle> for other terminals.")}` : ""));
      if (available.length) payload.components = [{ type: 1, components: [{
        type: 3, custom_id: "cdc:orca:select", placeholder: t("Orca 터미널 선택", "Select an Orca terminal"), min_values: 1, max_values: 1,
        options: available.map((target) => {
          const token = randomUUID();
          selections.set(token, { target, channelId: message.channelId, userId: message.userId, expires: now() + 5 * 60_000 });
          return { label: (target.title || target.handle).slice(0, 100), value: token,
            description: `${target.agentIdentity} · ${target.executionHostId} · ${target.worktreePath || target.handle}`.slice(0, 100) };
        }),
      }] }];
      await message.reply(payload);
      return true;
    }
    if (command?.action === "connect" || command?.action === "select") {
      if (busy()) throw new Error(t("이 채널의 봇 작업이 끝난 뒤 연결하세요. 다른 채널에서도 연결할 수 있습니다.", "Wait for this channel’s connector jobs to finish, or use another channel."));
      let target: OrcaTarget;
      if (command.action === "select") {
        const selected = selections.get(command.value!);
        if (!selected || selected.channelId !== message.channelId || selected.userId !== message.userId || selected.expires < now()) {
          throw new Error(t("선택 메뉴가 만료되었거나 다른 사용자의 메뉴입니다. /orca를 다시 여세요.", "This menu expired or belongs to another user. Open /orca again."));
        }
        target = await checked(selected.target);
      } else {
        target = await input.client.show(command.value!);
        if (!isOrcaAgent(target)) throw new Error(t("실행 중인 Codex / Claude 터미널만 연결할 수 있습니다.", "Only connected, writable Codex / Claude terminals can be bound."));
      }
      if (Object.entries(state.bindings).some(([channel, value]) => channel !== message.channelId && sameOrcaTarget(value, target))) {
        throw new Error(t("이미 다른 Discord 채널에 연결된 터미널입니다. 기존 채널에서 먼저 해제하세요.", "This terminal is already bound to another Discord channel. Disconnect it there first."));
      }
      await input.client.screen(target);
      await checked(target);
      if (busy()) throw new Error(t("연결 확인 중 이 채널에 다른 요청이 도착했습니다. 처리가 끝난 뒤 다시 연결하세요.", "Another request arrived during binding. Wait for it to finish, then reconnect."));
      state.bindings[message.channelId] = targetSchema.parse(target);
      await save(state);
      await reply(`${label(target)}\n\n${t("연결했습니다. 아래 ‘화면 확인’으로 현재 질문을 읽고, 일반 메시지로 답변하세요. 터미널의 현재 입력란에 Enter와 함께 전달되므로 로컬 입력과 동시에 작성하지 마세요.", "Connected. Read the current question below, then reply with an ordinary message. Input goes to the terminal’s current composer with Enter; avoid typing locally at the same time.")}`, true);
      return true;
    }
    if (!bound) {
      await reply(t("먼저 /orca에서 터미널을 선택하세요.", "Select a terminal with /orca first."));
      return true;
    }
    if (command?.action === "status" || command?.action === "read") {
      const target = await checked(bound);
      const screen = command.action === "read" ? await input.client.screen(target) : "";
      await checked(target);
      await reply(`${label(target)}${screen ? `\n\n\`\`\`text\n${screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/`/g, "ˋ").slice(-3200)}\n\`\`\`` : ""}`, true);
      return true;
    }
    if (busy()) throw new Error(t("이 채널의 기존 봇 작업이 아직 실행 중이거나 재시작 대기 중입니다. 종료 후 다시 보내세요.", "A connector job or restart is pending in this channel. Wait for it to finish."));
    if (message.restoreOnly || message.durableQueuedAt) throw new Error(t("이전에 대기 중이던 봇 요청은 Orca에 자동 전달하지 않습니다. 새 메시지로 보내세요.", "Restored connector jobs are not automatically forwarded to Orca. Send a new message."));
    if (message.attachments?.length) throw new Error(t("Orca 입력은 텍스트만 지원합니다. 파일은 Orca에서 직접 첨부하세요.", "Orca forwarding supports text only. Attach files in Orca."));
    if (!command && (message.connectorCommand || /^\s*(\/|__cdc_)/.test(message.content))) {
      throw new Error(t("Orca 연결 중에는 일반 메시지 또는 /orca send를 사용하세요. 봇 명령은 /orca disconnect 후 사용할 수 있습니다.", "Use ordinary messages or /orca send while connected. Disconnect first to use other connector commands."));
    }
    const text = (command?.value ?? message.content).replace(/\r\n/g, "\n");
    if (!text.trim() || text.length > 8000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      throw new Error(t("비어 있거나 8,000자를 넘거나 제어 문자가 있는 입력은 보낼 수 없습니다.", "Input must be nonempty, at most 8,000 characters, and contain no terminal control characters."));
    }
    const id = message.messageId;
    if (!id) throw new Error(t("중복 전송 방지용 Discord ID가 없습니다. 새 메시지로 보내세요.", "Missing Discord delivery ID. Send a new message."));
    if (/^\d{16,22}$/.test(id) && Number((BigInt(id) >> 22n) + DISCORD_EPOCH) < now() - RECEIPT_TTL_MS) {
      throw new Error(t("7일 이상 지난 입력은 재전송하지 않습니다. 새 메시지로 보내세요.", "Messages older than seven days are not replayed. Send a new message."));
    }
    const receiptId = `${message.channelId}:${id}`;
    const previous = state.receipts[receiptId];
    if (previous) {
      await reply(previous.status === "accepted" ? t("이미 접수된 메시지입니다. 다시 보내지 않았습니다.", "This message was already accepted; it was not sent again.") :
        t("이 메시지는 이미 전송을 시도했습니다. 화면에서 반영 여부를 확인하세요. 자동 재전송하지 않았습니다.", "Delivery was already attempted. Check the screen; it was not automatically resent."), true);
      return true;
    }
    const target = await checked(bound);
    await input.client.screen(target, true); // Read current UI before typing; refuse unavailable/stopped screens.
    await checked(target);
    for (const [key, receipt] of Object.entries(state.receipts)) if (receipt.at < now() - RECEIPT_TTL_MS) delete state.receipts[key];
    state.receipts[receiptId] = { at: now(), status: "pending" };
    await save(state); // Write-ahead receipt prevents duplicate submission after a crash/timeout.
    let result;
    try { result = await input.client.send(target, text); }
    catch {
      state.receipts[receiptId].status = "unknown";
      await save(state);
      await reply(t("전송 결과를 확인하지 못했습니다. 중복 실행을 막기 위해 재전송하지 않았습니다. ‘화면 확인’에서 확인한 뒤 필요한 경우 새 메시지를 보내세요.", "Delivery could not be confirmed. It was not retried. Check the screen before sending a new message."), true);
      return true;
    }
    state.receipts[receiptId].status = result.accepted ? "accepted" : "rejected";
    await save(state);
    await reply(result.accepted
      ? result.turnStarted ? t("Orca가 입력을 받고 작업 시작을 확인했습니다.", "Orca accepted the input and observed the turn start.")
        : t("Orca가 입력을 접수했습니다. 작업 시작이나 답변 완료는 아직 확인되지 않았습니다.", "Orca accepted the input. Turn start and completion have not been confirmed.")
      : t("Orca가 입력을 거절했습니다. 화면을 확인하세요.", "Orca rejected the input. Check the screen."), true);
    return true;
  }
  return {
    handle(message, context, busy) {
      const result = tail.then(async () => {
        try { return await process(message, context, busy); }
        catch (error) {
          // Fail closed, including damaged state: never fall through to a second agent writer.
          const detail = error instanceof z.ZodError ? t("Orca 응답 형식을 확인할 수 없습니다. Orca를 업데이트하세요.", "Unsupported Orca response. Update Orca.") :
            error instanceof Error ? error.message : "Orca unavailable";
          await message.reply(panel(detail));
          return true;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
