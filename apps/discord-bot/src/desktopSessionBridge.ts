import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectorLocale } from "../../../packages/core/src/index.js";
import type { OrcaBridge } from "./orcaBridge.js";
import type { DesktopSessionClient } from "./desktopSessionClient.js";

const TTL = 7 * 24 * 60 * 60 * 1000;
const schema = z.object({ version: z.literal(1), receipts: z.record(z.object({ at: z.number(), status: z.enum(["pending", "accepted", "unknown"]) })) });
export function createDesktopSessionBridge(options: { client: DesktopSessionClient; file: string; locale?: ConnectorLocale; now?: () => number }): OrcaBridge {
  let tail: Promise<unknown> = Promise.resolve();
  const now = options.now ?? Date.now;
  const t = (ko: string, en: string) => options.locale === "en" ? en : ko;
  async function save(state: z.infer<typeof schema>) {
    await mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 });
    const temp = `${options.file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(state) + "\n", { mode: 0o600 }); await rename(temp, options.file); }
    finally { await rm(temp, { force: true }); }
  }
  return {
    handle(message, context, busy) {
      // Slash commands keep their normal route. Never replay restored jobs or
      // send a relay/bot message into a user's Desktop conversation.
      if (context.channelMode !== "session-linked" || !context.codexSessionId || message.authorBot || message.relayRequest || message.restoreOnly || message.durableQueuedAt ||
          message.connectorCommand || /^\s*(\/|__cdc_)/.test(message.content) ||
          (context.allowedRoleIds.length > 0 && !context.allowedRoleIds.some(role => message.roleIds.includes(role)))) return Promise.resolve(false);
      const threadId = context.codexSessionId;
      const process = async () => {
        if (busy()) return false;
        const reply = (description: string) => message.reply({ allowedMentions: { parse: [] }, embeds: [{ title: "ChatGPT / Codex", description, color: 0x3498db }] });
        let session;
        try {
          // Consult receipts even if the app has since closed: a delivered
          // Discord message must never fall through into a new worker turn.
          let state: z.infer<typeof schema>;
          try { state = schema.parse(JSON.parse(await readFile(options.file, "utf8"))); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(t("앱 전송 기록을 읽을 수 없습니다. 복구 전에는 전송하지 않습니다.", "Cannot read Desktop delivery records. Repair them before sending.")); state = { version: 1, receipts: {} }; }
          const key = `${message.channelId}:${message.messageId}`;
          if (state.receipts[key]) { await reply(t("이미 전송을 시도한 메시지입니다. 앱에서 확인해 주세요. 다시 보내지 않았습니다.", "Delivery was already attempted. Check the app; it was not resent.")); return true; }
          session = await options.client.open(threadId);
          if (!session) return false;
          if (busy()) throw new Error(t("이 스레드의 봇 요청 처리가 끝난 뒤 다시 보내 주세요.", "Wait for this thread's connector jobs to finish."));
          if (message.attachments?.length) throw new Error(t("앱으로는 텍스트만 전달할 수 있습니다. 첨부 파일은 앱에서 보내 주세요.", "Desktop forwarding supports text only. Attach files in the app."));
          if (!message.messageId || !message.content.trim() || message.content.length > 8000) throw new Error(t("전송 ID와 1~8,000자의 텍스트가 필요합니다.", "A delivery ID and 1–8,000 characters of text are required."));
          if (/^\d{16,22}$/.test(message.messageId) && Number((BigInt(message.messageId) >> 22n) + 1420070400000n) < now() - TTL) throw new Error(t("7일 이상 지난 메시지는 전달하지 않습니다. 새 메시지를 보내 주세요.", "Messages older than seven days are not forwarded."));
          for (const [id, receipt] of Object.entries(state.receipts)) if (receipt.at < now() - TTL) delete state.receipts[id];
          state.receipts[key] = { at: now(), status: "pending" };
          await save(state);
          let result: "steered" | "started";
          try { result = await session.send(message.content, message.messageId); }
          catch { state.receipts[key].status = "unknown"; await save(state); throw new Error(t("앱 전송 결과를 확인하지 못했습니다. 중복 입력을 막기 위해 재전송하지 않았습니다. 앱에서 반영 여부를 확인해 주세요.", "Desktop delivery is unconfirmed. It was not retried. Check the app before sending again.")); }
          state.receipts[key].status = "accepted";
          await save(state);
          await reply(result === "steered" ? t("앱에서 진행 중인 같은 대화에 전달했습니다.", "Sent to the same active conversation in the app.") : t("앱의 같은 대화에서 이어서 시작했습니다.", "Continued the same conversation in the app."));
          return true;
        } catch (error) { await reply(error instanceof Error ? error.message : t("앱에 연결할 수 없습니다.", "Desktop unavailable.")); return true; }
        finally { session?.close(); }
      };
      const result = tail.then(process); tail = result.catch(() => undefined); return result;
    },
  };
}
