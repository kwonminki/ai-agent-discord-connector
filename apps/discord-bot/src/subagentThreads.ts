import { syncCodexTranscriptProgress } from "./codexTranscriptProgress.js";
import { createHash } from "node:crypto";
import type { DiscoveredCodexSession } from "../../../packages/codex-adapter/src/index.js";
import { sanitizeDiscordThreadName, syncCodexSessionsToDiscord, type DiscordGuildSurface } from "./codexSessionSync.js";
import type { ControlApiClient } from "./controlApiClient.js";
import type { DirectSyncStateStore, SyncedSessionChannelState } from "./directState.js";
import type { DiscordMessagePayload } from "./responses.js";

const queues = new WeakMap<DirectSyncStateStore, Promise<unknown>>();
function payload(key: string, content: string, users: string[] = []): DiscordMessagePayload {
  return { content, embeds: [], allowedMentions: { parse: [], users },
    nonce: createHash("sha256").update(key).digest("hex").slice(0, 24), enforceNonce: true };
}
export function subagentRoot(id: string, sessions: Map<string, DiscoveredCodexSession>): string | null {
  const seen = new Set<string>();
  let current = id;
  while (sessions.get(current)?.subagent) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = sessions.get(current)!.subagent!.parentSessionId;
  }
  return seen.has(current) ? null : current;
}
export function subagentThreadName(session: DiscoveredCodexSession): string {
  const relation = session.subagent!;
  const task = relation.agentPath?.split("/").filter(Boolean).at(-1);
  const label = [task, relation.name].filter(Boolean).join(" · ") || "Codex subagent";
  return `${sanitizeDiscordThreadName(label).slice(0, 83)} · ${session.id.slice(-12)}`;
}
export async function syncSubagentThreads(input: {
  guild: DiscordGuildSurface; stateStore: DirectSyncStateStore;
  controlApi: Pick<ControlApiClient, "createCategoryMapping" | "createManagedChannel" | "linkCodexSession">;
  sessions: DiscoveredCodexSession[]; adminChannelId: string;
  computerId: string; computerDisplayName: string; defaultWorkspaceRoot: string; mentionRoleIds: string[];
  now?: number;
}): Promise<void> {
  const run = async () => {
    if (!input.guild.createThread || !input.guild.sendTextMessage || !input.guild.ensureSubagentContainer) return;
    let state = await input.stateStore.read();
    const sessions = new Map(input.sessions.map(session => [session.id, session]));
    // Retain proven Orca relationships after the terminal exits.
    for (const channel of state.sessionChannels) {
      const session = channel.codexSessionId ? sessions.get(channel.codexSessionId) : undefined;
      if (session && !session.subagent && channel.subagent) session.subagent = channel.subagent;
    }
    const save = async (channel: SyncedSessionChannelState) => {
      state = await input.stateStore.update(latest => ({ ...latest, sessionChannels: [
        ...latest.sessionChannels.filter(row => row.discordChannelId !== channel.discordChannelId), {
          ...channel,
          ...Object.fromEntries(Object.entries(latest.sessionChannels.find(row => row.discordChannelId === channel.discordChannelId) ?? {})
            .filter(([key]) => key.startsWith("lastTranscript") || key === "transcriptProgress")),
        },
      ] }));
    };
    let container: { id: string } | undefined;
    for (const session of input.sessions.filter(session => session.subagent)) {
      const rootId = subagentRoot(session.id, sessions);
      if (!rootId || rootId === session.id || state.archivedCodexSessionIds.includes(rootId) || state.archivedCodexSessionIds.includes(session.id)) continue;
      let root = state.sessionChannels.find(channel => channel.codexSessionId === rootId && !channel.channelPurpose);
      let child = state.sessionChannels.find(channel => channel.codexSessionId === session.id && !channel.channelPurpose);
      if (!child && (input.now ?? Date.now()) - Date.parse(session.updatedAt) > 7 * 86400_000) continue;
      if (!root) {
        const rootSession = sessions.get(rootId);
        if (!rootSession || (input.now ?? Date.now()) - Date.parse(session.updatedAt) > 7 * 86400_000) continue;
        await syncCodexSessionsToDiscord({ ...input, sessions: [rootSession], limit: 1, sessionThreadParentChannelId: input.adminChannelId, mentionRoleIds: [] });
        state = await input.stateStore.read();
        root = state.sessionChannels.find(channel => channel.codexSessionId === rootId && !channel.channelPurpose);
        if (!root) continue;
      }
      let hub = state.sessionChannels.find(channel => channel.channelPurpose === "subagent-index" && channel.subagentRootSessionId === rootId);
      if (!hub) {
        const name = `${sanitizeDiscordThreadName(root.threadName).slice(0, 60)} · agents · ${rootId.slice(-12)}`;
        const thread = await input.guild.findThreadByName?.({ name, parentChannelId: input.adminChannelId }) ??
          await input.guild.createThread({ name, parentChannelId: input.adminChannelId, autoArchiveDuration: 10080 });
        hub = { ...root, codexSessionId: null, channelPurpose: "subagent-index", subagent: undefined,
          subagentRootSessionId: rootId, discordChannelId: thread.id, discordParentChannelId: input.adminChannelId,
          discordDeliveryMode: "thread", channelName: name, contextPostedAt: null, transcriptProgress: undefined };
        await save(hub);
      }
      if (!hub.contextPostedAt) {
        const users = await input.guild.threadOperatorIds?.(root.discordChannelId, input.mentionRoleIds) ?? [];
        for (const user of users) await input.guild.addThreadMember?.(hub.discordChannelId, user);
        await input.guild.sendTextMessage(hub.discordChannelId, payload(`hub:${hub.discordChannelId}`,
          `${users.map(id => `<@${id}>`).join(" ")}\n**서브 에이전트 목록 / Subagents**\n부모 작업 / Parent: <#${root.discordChannelId}>\n새 자식 작업을 아래에 알립니다. 이곳은 알림 전용입니다. 개별 링크에서 내용을 보고 대화할 수 있습니다.\nNotifications only. Open a child thread to read or reply.`, users));
        hub.contextPostedAt = new Date().toISOString(); await save(hub);
      }
      container ??= await input.guild.ensureSubagentContainer(input.adminChannelId);
      if (!child || child.discordParentChannelId !== container.id) {
        const old = child;
        const name = subagentThreadName(session);
        const thread = await input.guild.findThreadByName?.({ name, parentChannelId: container.id }) ??
          await input.guild.createThread({ name, parentChannelId: container.id, autoArchiveDuration: 60 });
        child = { ...root, ...old, codexSessionId: session.id, channelPurpose: undefined,
          subagent: session.subagent, subagentRootSessionId: rootId, subagentIndexChannelId: hub.discordChannelId,
          discordChannelId: thread.id, discordParentChannelId: container.id, discordDeliveryMode: "thread",
          channelName: name, threadName: name, updatedAt: session.updatedAt, cwd: session.cwdHint ?? root.cwd,
          contextPostedAt: null, transcriptProgress: undefined, lastTranscriptDiscordMessageId: null, subagentAnnouncedAt: undefined };
        await input.controlApi.createManagedChannel({ id: `channel:${thread.id}`, discordChannelId: thread.id, computerId: input.computerId, workspaceId: child.workspaceId, channelMode: "session-linked" });
        await input.controlApi.linkCodexSession({ id: `session-link:${thread.id}:${session.id}`, discordChannelId: thread.id, codexSessionId: session.id, origin: "imported_native", threadNameSnapshot: name });
        const nextChild = child;
        state = await input.stateStore.update(latest => ({ ...latest, sessionChannels: [
          ...latest.sessionChannels.filter(row => row.discordChannelId !== thread.id).map(row => row.codexSessionId === session.id ? {
            ...row, codexSessionId: null, channelPurpose: "subagent-redirect" as const, redirectChannelId: thread.id,
            subagent: undefined, transcriptProgress: undefined,
          } : row), nextChild,
        ] }));
      }
      if (!child.contextPostedAt) {
        const latestStatus = session.realtimeEvents?.filter(event => event.turnStatus).at(-1)?.turnStatus;
        const alreadyNotified = state.taskCompletionNotifications.some(notification => notification.sessionId === session.id);
        const recent = alreadyNotified && latestStatus !== "running" ? session.contextPreview?.filter(message => message.role === "assistant").at(-1)?.text : undefined;
        await input.guild.sendTextMessage(child.discordChannelId, payload(`child:${child.discordChannelId}`,
          `**${subagentThreadName(session)}**\n목록 / Index: <#${hub.discordChannelId}> · 부모 / Parent: <#${root.discordChannelId}>\n진행 내용은 멘션 없이 표시됩니다. 여기서 메시지를 보내 대화하세요.\nUpdates are quiet; reply here to continue.${session.subagent?.source === "codex" ? "\nCodex 자식에게 보낸 입력은 부모에게 전달을 요청합니다. / Native child input is relayed through its parent." : ""}${recent ? `\n\n${recent.slice(0, 1100)}` : ""}`));
        const progress = await syncCodexTranscriptProgress({ guild: input.guild, channel: child, session,
          newEventKeys: new Set(session.realtimeEvents?.filter(event => event.turnStatus === "running").map(event => event.key)), now: input.now ?? Date.now() });
        child.transcriptProgress = progress.progress;
        child.contextPostedAt = new Date().toISOString(); await save(child);
      }
      if (!child.subagentAnnouncedAt) {
        await input.guild.sendTextMessage(hub.discordChannelId, payload(`announce:${child.discordChannelId}`,
          `**새 서브 에이전트 / New subagent**\n<#${child.discordChannelId}> · ${session.subagent!.source}`));
        child.subagentAnnouncedAt = new Date().toISOString(); await save(child);
      }
    }
    for (const old of state.sessionChannels.filter(channel => channel.channelPurpose === "subagent-redirect" && !channel.redirectPostedAt)) {
      await input.guild.sendTextMessage(old.discordChannelId, payload(`redirect:${old.discordChannelId}`, `대화가 <#${old.redirectChannelId}>로 이동했습니다. 기존 기록은 여기 보존됩니다.\nConversation moved; history is preserved here.`));
      await input.guild.archiveThread?.(old.discordChannelId);
      await save({ ...old, redirectPostedAt: new Date().toISOString() });
    }
  };
  const result = (queues.get(input.stateStore) ?? Promise.resolve()).then(run);
  queues.set(input.stateStore, result.catch(() => undefined));
  return result;
}
