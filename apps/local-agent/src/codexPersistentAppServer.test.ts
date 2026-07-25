import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexPersistentAppServerCount,
  disposeCodexPersistentAppServers,
  runCodexAppServerPrompt,
} from "./codexAppServerRunner.js";

const wsEntryPath = createRequire(import.meta.url).resolve("ws");

async function createFakeCodexAppServer(tempRoot: string): Promise<{
  fakeCodex: string;
  spawnsPath: string;
}> {
  const fakeCodex = path.join(tempRoot, "codex");
  const spawnsPath = path.join(tempRoot, "spawns.log");

  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      `const { WebSocketServer } = require(${JSON.stringify(wsEntryPath)});`,
      `fs.appendFileSync(${JSON.stringify(spawnsPath)}, process.pid + '\\n');`,
      "const listenUrl = process.argv[process.argv.indexOf('--listen') + 1] ?? '';",
      "const server = http.createServer();",
      "const wss = new WebSocketServer({ server, perMessageDeflate: false });",
      "wss.on('connection', (socket) => {",
      "  let threadId = 'thread-persist-1';",
      "  socket.on('message', (raw) => {",
      "    const message = JSON.parse(raw.toString());",
      "    if (!message.method) return;",
      "    if (message.method === 'initialize') {",
      "      socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'Fake Codex/0.0.0' } }));",
      "      return;",
      "    }",
      "    if (message.method === 'thread/start' || message.method === 'thread/resume') {",
      "      if (message.method === 'thread/resume' && message.params && message.params.threadId) {",
      "        threadId = message.params.threadId;",
      "      }",
      "      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId } } }));",
      "      socket.send(JSON.stringify({ method: 'thread/started', params: { thread: { id: threadId } } }));",
      "      return;",
      "    }",
      "    if (message.method === 'turn/start') {",
      "      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], itemsView: 'notLoaded', error: null } } }));",
      "      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: '완료했습니다.', phase: 'final_answer' } } }));",
      "      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', error: null } } }));",
      "      return;",
      "    }",
      "    if (message.id !== undefined) {",
      "      socket.send(JSON.stringify({ id: message.id, result: {} }));",
      "    }",
      "  });",
      "});",
      "if (listenUrl.startsWith('unix://')) {",
      "  server.listen(listenUrl.slice('unix://'.length));",
      "} else {",
      "  const parsed = new URL(listenUrl.replace(/^ws:/, 'http:'));",
      "  server.listen(Number(parsed.port), parsed.hostname);",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  return { fakeCodex, spawnsPath };
}

async function readSpawnPids(spawnsPath: string): Promise<number[]> {
  const content = await readFile(spawnsPath, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => Number.parseInt(line, 10));
}

describe("persistent Codex app-server", () => {
  afterEach(async () => {
    await disposeCodexPersistentAppServers();
  });

  it("reuses one managed app-server process across prompts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-persist-"));
    const fake = await createFakeCodexAppServer(tempRoot);

    try {
      const first = await runCodexAppServerPrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "첫 번째 요청",
        timeoutMs: 10_000,
        codexCommand: fake.fakeCodex,
      });
      expect(first).toMatchObject({
        status: "completed",
        finalMessage: "완료했습니다.",
        sessionId: "thread-persist-1",
      });
      expect(codexPersistentAppServerCount()).toBe(1);

      const second = await runCodexAppServerPrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "두 번째 요청",
        timeoutMs: 10_000,
        codexCommand: fake.fakeCodex,
        sessionId: "thread-persist-1",
      });
      expect(second).toMatchObject({ status: "completed", sessionId: "thread-persist-1" });

      expect(await readSpawnPids(fake.spawnsPath)).toHaveLength(1);
    } finally {
      await disposeCodexPersistentAppServers();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("spawns a replacement app-server after the pooled one dies", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-persist-respawn-"));
    const fake = await createFakeCodexAppServer(tempRoot);

    try {
      const first = await runCodexAppServerPrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "첫 번째 요청",
        timeoutMs: 10_000,
        codexCommand: fake.fakeCodex,
      });
      expect(first.status).toBe("completed");

      const [firstPid] = await readSpawnPids(fake.spawnsPath);
      expect(firstPid).toBeGreaterThan(0);
      process.kill(firstPid ?? 0, "SIGKILL");

      for (let attempt = 0; attempt < 200 && codexPersistentAppServerCount() > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(codexPersistentAppServerCount()).toBe(0);

      const second = await runCodexAppServerPrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "두 번째 요청",
        timeoutMs: 10_000,
        codexCommand: fake.fakeCodex,
        sessionId: "thread-persist-1",
      });
      expect(second).toMatchObject({ status: "completed", sessionId: "thread-persist-1" });
      expect(await readSpawnPids(fake.spawnsPath)).toHaveLength(2);
    } finally {
      await disposeCodexPersistentAppServers();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
