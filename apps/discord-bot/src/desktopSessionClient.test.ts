import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesktopSessionClient } from "./desktopSessionClient.js";

const thread = "01a0ceec-c225-71a2-9204-b4d5819c004d";
let home: string, server: net.Server;
let sockets: Set<net.Socket>, requests: any[];
let respond: (m: any, socket: net.Socket) => unknown;
function write(socket: net.Socket, message: unknown) {
  const body = Buffer.from(JSON.stringify(message)); const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4);
  // Exercise fragmented headers and bodies instead of assuming one data event.
  socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2, 7)); socket.write(frame.subarray(7));
}
function success(m: any, result: unknown, owner = "owner") { return { type: "response", requestId: m.requestId, method: m.method, resultType: "success", handledByClientId: owner, result }; }
function error(m: any, text: string) { return { type: "response", requestId: m.requestId, resultType: "error", error: text }; }
function normal(m: any) {
  return success(m, m.method === "initialize" ? { clientId: "connector" } : m.method === "thread-owner-discovery" ? { supportsUntrustedAppInput: true } : m.method === "thread-follower-steer-turn" ? { result: { turnId: "turn" } } : { result: { turn: { id: "next-turn" } } });
}
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "desktop-ipc-")); await mkdir(path.join(home, "ipc"), { mode: 0o700 });
  sockets = new Set(); requests = []; respond = normal;
  server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(), message = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        requests.push(message); const reply = respond(message, socket); if (reply) write(socket, reply);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path.join(home, "ipc", "ipc.sock"), resolve));
});
afterEach(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
const client = (timeoutMs = 1000) => createDesktopSessionClient({ codexHome: home, timeoutMs });

describe("Desktop same-session IPC", () => {
  it("discovers the exact owner and steers the existing turn with literal input", async () => {
    const session = await client().open(thread);
    expect(await session!.send('answer "2"\n$(literal)', "discord-id")).toBe("steered"); session!.close();
    const sent = requests.at(-1);
    expect(sent).toMatchObject({ method: "thread-follower-steer-turn", version: 1, targetClientId: "owner", sourceClientId: "connector", params: { conversationId: thread, input: [{ type: "text", text: 'answer "2"\n$(literal)' }], clientUserMessageId: "discord:discord-id", restoreMessage: { context: {} } } });
    expect(requests.filter(x => x.method === "thread-owner-discovery")).toHaveLength(2);
    expect(requests.some(x => /resume|fork/.test(x.method))).toBe(false);
  });
  it("starts in the same owner only after the exact inactive-turn rejection", async () => {
    respond = m => m.method === "thread-follower-steer-turn" ? error(m, `Cannot steer conversation ${thread} because its active turn already ended`) : normal(m);
    const session = await client().open(thread); expect(await session!.send("continue", "id")).toBe("started"); session!.close();
    expect(requests.at(-1)).toMatchObject({ method: "thread-follower-start-turn", version: 2, targetClientId: "owner", params: { conversationId: thread, turnStart: { request: { threadId: thread, input: [{ text: "continue" }], clientUserMessageId: "discord:id" }, context: { inheritThreadSettings: true } } } });
    expect(Object.keys(requests.at(-1).params.turnStart.request).sort()).toEqual(["clientUserMessageId", "input", "threadId"]);
  });
  it.each(["timeout", "request-version-mismatch", "approval-required", "no-client-found"])("never starts a replacement turn after %s", async reason => {
    respond = m => m.method === "thread-follower-steer-turn" ? error(m, reason) : normal(m);
    const session = await client().open(thread); await expect(session!.send("answer", "id")).rejects.toThrow(); session!.close();
    expect(requests.some(x => x.method === "thread-follower-start-turn")).toBe(false);
  });
  it("rejects changed ownership before input", async () => {
    const session = await client().open(thread); respond = m => success(m, { supportsUntrustedAppInput: true }, "other-owner");
    await expect(session!.send("answer", "id")).rejects.toThrow("owner changed"); session!.close();
    expect(requests.some(x => x.method === "thread-follower-steer-turn")).toBe(false);
  });
  it("does not resend after a dropped delivery acknowledgement", async () => {
    respond = (m, socket) => { if (m.method === "thread-follower-steer-turn") { socket.destroy(); return; } return normal(m); };
    const session = await client().open(thread); await expect(session!.send("answer", "id")).rejects.toThrow("closed"); session!.close();
    expect(requests.filter(x => x.method === "thread-follower-steer-turn")).toHaveLength(1);
  });
  it("bounds response waits and never retries unknown delivery", async () => {
    respond = m => m.method === "thread-follower-steer-turn" ? undefined : normal(m);
    const session = await client(50).open(thread); await expect(session!.send("answer", "id")).rejects.toThrow("timed out"); session!.close();
    expect(requests.filter(x => x.method === "thread-follower-steer-turn")).toHaveLength(1);
  });
  it("requires recognized delivery receipts", async () => {
    respond = m => m.method === "thread-follower-steer-turn" ? success(m, { result: {} }) : normal(m);
    const session = await client().open(thread); await expect(session!.send("answer", "id")).rejects.toThrow("Unrecognized"); session!.close();
    expect(requests.some(x => x.method === "thread-follower-start-turn")).toBe(false);
  });
  it("returns no owner without claiming or resuming the thread", async () => {
    respond = m => m.method === "thread-owner-discovery" ? error(m, "no-client-found") : normal(m);
    expect(await client().open(thread)).toBeNull();
    expect(requests.map(x => x.method)).toEqual(["initialize", "thread-owner-discovery"]);
  });
  it("requires an app supporting the observed follower protocol", async () => {
    respond = m => m.method === "thread-owner-discovery" ? success(m, {}) : normal(m);
    await expect(client().open(thread)).rejects.toThrow("Update the Desktop");
  });
  it("rejects a shared IPC directory and ignores missing sockets or non-session IDs", async () => {
    await chmod(path.join(home, "ipc"), 0o777); await expect(client().open(thread)).rejects.toThrow("private directory");
    expect(await createDesktopSessionClient({ codexHome: path.join(home, "missing") }).open(thread)).toBeNull();
    expect(await client().open("not-a-session")).toBeNull(); expect(requests).toHaveLength(0);
  });
});
