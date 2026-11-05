import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { sameOrcaTarget, type OrcaClient, type OrcaTarget } from "./orcaClient.js";

const prefix = "orca-chat:";
const rowSchema = z.object({
  sessionId: z.string().min(1), threadId: z.string().min(1),
  title: z.string().nullish(), host: z.string(), workspace: z.string(),
  kind: z.string(), reconciling: z.number().nullable(), handoff: z.string().nullable(),
});
type Chat = z.infer<typeof rowSchema> & { profile: string };
type Rpc = (profile: string, method: string, params: unknown, runtimeId?: string) => Promise<{ result: unknown; runtimeId: string }>;
const pageSchema = z.object({ ok: z.literal(true), page: z.object({
  sessionId: z.string(), fence: z.number().int().positive(), working: z.boolean(),
  actionablePromptIds: z.array(z.string()),
  items: z.array(z.object({ body: z.object({ kind: z.string(), role: z.string().optional(),
    blocks: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  }).passthrough() })),
}) });

export function orcaProfiles(env = process.env, platform = process.platform, home = os.homedir()): string[] {
  const explicit = env.CONNECT_ORCA_USER_DATA_PATH?.trim() || env.ORCA_USER_DATA_PATH?.trim();
  if (explicit) return [explicit];
  if (platform === "darwin") return [path.join(home, "Library/Application Support/orca")];
  if (platform === "win32") return env.APPDATA ? [path.join(env.APPDATA, "orca")] : [];
  return [path.join(home, ".orca"), path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "orca")];
}

export async function findNativeChat(threadId: string, profiles = orcaProfiles()): Promise<Chat | null> {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) return null;
  const matches: Chat[] = [];
  // Match only the currently proven provider handle, never a name, cwd, or old fork/clear link.
  const query = `SELECT json_object('sessionId', session_id, 'threadId', json_extract(link.value,'$.handle.threadId'),
    'title',json_extract(record_json,'$.conversationName'),'host',json_extract(record_json,'$.location.executionHostId'),
    'workspace',json_extract(record_json,'$.location.workspaceId'),'kind',json_extract(record_json,'$.lease.runtimeKind'),
    'reconciling',json_extract(record_json,'$.lease.unreconciled'),'handoff',json_extract(record_json,'$.lease.handoffStage')) AS row
    FROM agent_session_records, json_each(record_json,'$.providerHandleChain') AS link
    WHERE json_extract(record_json,'$.provider')='codex'
      AND json_extract(link.value,'$.linkId')=json_extract(record_json,'$.lease.provenHandleLinkId')
      AND json_extract(link.value,'$.handle.threadId')='${threadId}'`;
  for (const profile of [...new Set(profiles)]) {
    const file = path.join(profile, "agent-session-journal.db");
    try { await stat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Cannot read Orca chat ownership. No input was sent.");
    }
    let rows: unknown[];
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(file, { readOnly: true });
      try { rows = db.prepare(query).all().map(row => JSON.parse(String(row.row))); }
      finally { db.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_BUILTIN_MODULE") {
        throw new Error("Cannot read Orca chat ownership. No input was sent.");
      }
      const { stdout } = await promisify(execFile)("sqlite3", ["-readonly", file, query], { timeout: 5000, maxBuffer: 1024 * 1024 });
      rows = stdout.trim() ? stdout.trim().split("\n").map(line => JSON.parse(line)) : [];
    }
    matches.push(...rows.map(row => ({ ...rowSchema.parse(row), profile })));
  }
  if (matches.length > 1) throw new Error("Multiple Orca chats claim this session. No input was sent.");
  const chat = matches[0];
  if (!chat) return null;
  if (chat.reconciling || chat.handoff) {
    throw new Error("Orca is transferring this session between terminal and chat. Wait for the transfer before replying.");
  }
  return chat.kind === "native" ? chat : null;
}

export const orcaRpc: Rpc = async (profile, method, params, runtimeId) => {
  const metadata = z.object({ runtimeId: z.string(), authToken: z.string().min(1),
    transports: z.array(z.object({ kind: z.string(), endpoint: z.string() })),
  }).parse(JSON.parse(await readFile(path.join(profile, "orca-runtime.json"), "utf8")));
  if (runtimeId && metadata.runtimeId !== runtimeId) throw new Error("Orca restarted before delivery. No input was sent.");
  const endpoint = metadata.transports.find(t => t.kind === "unix" || t.kind === "named-pipe")?.endpoint;
  if (!endpoint) throw new Error("Orca has no local runtime connection.");
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(endpoint);
    let buffer = "", settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve({ result, runtimeId: metadata.runtimeId });
    };
    const timer = setTimeout(() => finish(new Error("Orca chat delivery timed out. Check the chat before resending.")), 30_000);
    socket.setEncoding("utf8");
    socket.once("error", () => finish(new Error("Orca runtime is unavailable. Reopen Orca on this host.")));
    socket.once("close", () => finish(new Error("Orca disconnected before confirming delivery.")));
    socket.once("connect", () => socket.write(JSON.stringify({ id, authToken: metadata.authToken, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return finish(new Error("Orca response is too large."));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame._keepalive) continue;
          if (frame.id !== id || frame._meta?.runtimeId !== metadata.runtimeId) throw new Error();
          if (frame.ok !== true) return finish(new Error("Orca refused the chat request. Check the session in Orca."));
          finish(undefined, frame.result);
        } catch { finish(new Error("Unsupported Orca runtime response.")); }
      }
    });
  });
};

export function orcaFingerprint(value: unknown): string {
  const canonical = (v: any): string => v === null || typeof v !== "object" ? JSON.stringify(v ?? null) :
    Array.isArray(v) ? `[${v.map(canonical).join(",")}]` :
    `{${Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function withOrcaNativeChat(cli: OrcaClient, find = findNativeChat, rpc: Rpc = orcaRpc): OrcaClient {
  const targets = new Map<string, Chat>();
  async function history(chat: Chat, runtimeId?: string) {
    const response = await rpc(chat.profile, "agentSession.history", { sessionId: chat.sessionId, direction: "tail", limit: 20 }, runtimeId);
    const { page } = pageSchema.parse(response.result);
    if (page.sessionId !== chat.sessionId) throw new Error("Orca returned another chat.");
    return { page, runtimeId: response.runtimeId };
  }
  async function resolve(chat: Chat): Promise<OrcaTarget> {
    const live = await find(chat.threadId);
    if (!live || live.profile !== chat.profile || live.sessionId !== chat.sessionId) throw new Error("Orca chat ownership changed. No input was sent.");
    const { page, runtimeId } = await history(live);
    const owner = await rpc(live.profile, "agentSession.handoffStatus", { sessionId: live.sessionId }, runtimeId);
    if (!z.object({ owner: z.literal("native"), phase: z.literal("idle") }).safeParse(owner.result).success) {
      throw new Error("Orca chat is changing owners. Wait for the transfer before replying.");
    }
    const handle = prefix + live.sessionId;
    targets.set(handle, live);
    return { handle, runtimeId, incarnationId: String(page.fence), processKey: `${live.sessionId}:${page.fence}`,
      executionHostId: live.host, title: live.title || "Orca chat", worktreePath: live.workspace,
      agentIdentity: "codex", connected: true, writable: true, orphaned: false };
  }
  function chatFor(handle: string) {
    const chat = targets.get(handle);
    if (!chat) throw new Error("Orca chat association expired. Send a new message.");
    return chat;
  }
  return {
    ...cli,
    async resolveSession(agent, id) {
      const chat = agent === "codex" ? await find(id) : null;
      return chat ? resolve(chat) : cli.resolveSession?.(agent, id) ?? null;
    },
    async show(handle) {
      return handle.startsWith(prefix) ? resolve(chatFor(handle)) : cli.show(handle);
    },
    async screen(target, beforeInput) {
      if (!target.handle.startsWith(prefix)) return cli.screen(target, beforeInput);
      const { page } = await history(chatFor(target.handle), target.runtimeId);
      if (String(page.fence) !== target.incarnationId) throw new Error("Orca chat restarted. Retry with a new message.");
      if (beforeInput && page.actionablePromptIds.length) throw new Error("Orca is waiting for an approval or structured answer. Answer that prompt in Orca first.");
      return page.items.flatMap(item => item.body.kind === "message" ?
        (item.body.blocks ?? []).filter(block => block.type === "text").map(block => `${item.body.role}: ${block.text ?? ""}`) : []).join("\n");
    },
    async send(target, text) {
      if (!target.handle.startsWith(prefix)) return cli.send(target, text);
      const chat = chatFor(target.handle);
      if (!sameOrcaTarget(target, await resolve(chat))) throw new Error("Orca chat changed before delivery.");
      const body = { kind: "message", role: "user", blocks: [{ type: "text", text }] };
      const fields = { body, delivery: "queue-if-active" };
      const response = await rpc(chat.profile, "agentSession.send", { ...fields, envelope: {
        sessionId: chat.sessionId, clientOperationId: `${Date.now()}-${randomUUID().replaceAll("-", "")}`,
        expectedRuntimeFence: Number(target.incarnationId),
        payloadFingerprint: orcaFingerprint({ method: "agentSession.send", sessionId: chat.sessionId, fields }),
      } }, target.runtimeId);
      const result = z.object({ ok: z.boolean(), value: z.unknown().optional() }).parse(response.result);
      if (!result.ok) return { accepted: false, turnStarted: false };
      // Host acceptance is not proof that the model has started or completed a turn.
      return { accepted: true, turnStarted: false };
    },
  };
}
