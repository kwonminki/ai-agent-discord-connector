import net from "node:net";
import os from "node:os";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Desktop's same-user IPC follower protocol. Keep versions explicit: incompatible
// app updates must fail closed instead of resuming a second app-server writer.
const versions: Record<string, number> = {
  initialize: 0, "thread-owner-discovery": 1,
  "thread-follower-steer-turn": 1, "thread-follower-start-turn": 2,
};
const MAX_FRAME = 8 * 1024 * 1024;
type Response = { type: "response"; requestId: string; resultType: "success" | "error"; method?: string; handledByClientId?: string; result?: any; error?: string };
export interface DesktopSession {
  send(text: string, messageId: string): Promise<"steered" | "started">;
  close(): void;
}
export interface DesktopSessionClient { open(threadId: string): Promise<DesktopSession | null> }

export function createDesktopSessionClient(options: { codexHome?: string; timeoutMs?: number } = {}): DesktopSessionClient {
  const socketPath = path.join(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "ipc", "ipc.sock");
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async open(threadId) {
      if (process.platform === "win32" || !/^[0-9a-f-]{36}$/i.test(threadId)) return null;
      try {
        const [directory, file] = await Promise.all([lstat(path.dirname(socketPath)), lstat(socketPath)]);
        const uid = process.getuid?.();
        if (uid == null || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) || !file.isSocket() || file.uid !== uid) {
          throw new Error("Desktop IPC must belong to the gateway user in a private directory.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const socket = net.createConnection(socketPath);
      let buffer = Buffer.alloc(0), clientId = "initializing-client";
      const pending = new Map<string, { resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
      const fail = () => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Desktop connection closed. Delivery was not retried.")); }
        pending.clear();
      };
      socket.on("error", fail); socket.on("close", fail);
      function close() { socket.destroy(); fail(); }
      function write(value: unknown) {
        const body = Buffer.from(JSON.stringify(value));
        if (body.length > MAX_FRAME) throw new Error("Desktop request is too large.");
        const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
      }
      socket.on("data", (chunk) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 4) {
            const length = buffer.readUInt32LE();
            if (!length || length > MAX_FRAME) throw new Error("Invalid Desktop frame.");
            if (buffer.length < length + 4) return;
            const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
            buffer = buffer.subarray(length + 4);
            if (message.type === "client-discovery-request") {
              // This connector never claims to own app conversations.
              write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
            } else if (message.type === "response") {
              const entry = pending.get(message.requestId);
              if (entry) { pending.delete(message.requestId); clearTimeout(entry.timer); entry.resolve(message); }
            }
          }
        } catch { close(); }
      });
      function request(method: string, params: unknown, targetClientId?: string): Promise<Response> {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Desktop response timed out. Delivery was not retried.")); close(); }, timeoutMs);
          pending.set(requestId, { resolve, reject, timer });
          try { write({ type: "request", requestId, sourceClientId: clientId, method, version: versions[method], params, targetClientId, timeoutMs }); }
          catch { clearTimeout(timer); pending.delete(requestId); reject(new Error("Desktop request could not be written.")); close(); }
        });
      }
      function success(response: Response, method: string, owner?: string) {
        if (response.resultType !== "success" || response.method !== method || (owner && response.handledByClientId !== owner)) {
          throw new Error("Desktop rejected the request or its conversation owner changed. No automatic retry was made.");
        }
      }
      try {
        const connected = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error("Desktop connection timed out.")); close(); }, timeoutMs);
          socket.once("connect", () => { clearTimeout(timer); resolve(true); });
          socket.once("error", (error: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            // A crashed/closed app can leave its socket behind. Before any
            // request is sent, refusal or disappearance means no Desktop owner.
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
            else reject(new Error("Desktop connection unavailable."));
          });
        });
        if (!connected) { close(); return null; }
        const init = await request("initialize", { clientType: "discord-connector" });
        success(init, "initialize");
        if (typeof init.result?.clientId !== "string") throw new Error("Unsupported Desktop initialization response.");
        clientId = init.result.clientId;
        const discovery = await request("thread-owner-discovery", { hostId: "local", conversationId: threadId });
        if (discovery.resultType === "error" && discovery.error === "no-client-found") { close(); return null; }
        success(discovery, "thread-owner-discovery");
        const owner = discovery.handledByClientId;
        if (!owner || discovery.result?.supportsUntrustedAppInput !== true) throw new Error("Update the Desktop app to use Discord input.");
        return {
          close,
          async send(text, messageId) {
            const confirmed = await request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, owner);
            success(confirmed, "thread-owner-discovery", owner);
            const input = [{ type: "text", text, text_elements: [] }];
            const clientUserMessageId = `discord:${messageId}`;
            const steered = await request("thread-follower-steer-turn", {
              conversationId: threadId, input, clientUserMessageId,
              restoreMessage: { id: clientUserMessageId, text, context: {} },
            }, owner);
            if (steered.resultType === "success") {
              success(steered, "thread-follower-steer-turn", owner);
              if (typeof steered.result?.result?.turnId !== "string") throw new Error("Unrecognized Desktop delivery result. Check the app before resending.");
              return "steered";
            }
            // The app explicitly reports no active turn before accepting input.
            // Only this rejection permits starting a turn in the SAME owner.
            if (steered.error !== `Cannot steer conversation ${threadId} because its active turn already ended`) {
              throw new Error("Desktop did not confirm input. Check the app before resending.");
            }
            const started = await request("thread-follower-start-turn", {
              conversationId: threadId,
              turnStart: { request: { threadId, input, clientUserMessageId }, context: { inheritThreadSettings: true } },
            }, owner);
            success(started, "thread-follower-start-turn", owner);
            if (typeof started.result?.result?.turn?.id !== "string") throw new Error("Unrecognized Desktop delivery result. Check the app before resending.");
            return "started";
          },
        };
      } catch (error) { close(); throw error; }
    },
  };
}
