import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexPersistentAppServerCount,
  disposeCodexPersistentAppServers,
  runCodexAppServerPrompt,
  setCodexSessionIdleNotificationSink,
  type CodexSessionIdleNotification,
} from "./codexAppServerRunner.js";

const wsEntryPath = createRequire(import.meta.url).resolve("ws");

async function createFakeCodexAppServer(tempRoot: string, options: {
  tokenUsageTokens?: number;
  cachedTokenUsageTokens?: number;
  contextWindow?: number;
  compactClosesEarly?: boolean;
  threadId?: string;
} = {}): Promise<{
  fakeCodex: string;
  spawnsPath: string;
  methodsPath: string;
}> {
  const fakeCodex = path.join(tempRoot, "codex");
  const spawnsPath = path.join(tempRoot, "spawns.log");
  const methodsPath = path.join(tempRoot, "methods.log");
  const tokenUsageTokens = options.tokenUsageTokens ?? 0;
  const cachedTokenUsageTokens = options.cachedTokenUsageTokens ?? 0;
  const contextWindow = options.contextWindow ?? 258_000;
  const compactClosesEarly = options.compactClosesEarly ?? false;
  const threadId = options.threadId ?? "thread-persist-1";

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
      `  let threadId = ${JSON.stringify(threadId)};`,
      "  socket.on('message', (raw) => {",
      "    const message = JSON.parse(raw.toString());",
      "    if (!message.method) return;",
      `    fs.appendFileSync(${JSON.stringify(methodsPath)}, message.method + '\\n');`,
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
      `      if (${tokenUsageTokens} > 0) {`,
      `        socket.send(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: { last: { inputTokens: ${tokenUsageTokens}, cachedInputTokens: ${cachedTokenUsageTokens}, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: ${tokenUsageTokens} }, total: { inputTokens: ${tokenUsageTokens}, cachedInputTokens: ${cachedTokenUsageTokens}, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: ${tokenUsageTokens} }, modelContextWindow: ${contextWindow} } } }));`,
      "      }",
      "      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: '완료했습니다.', phase: 'final_answer' } } }));",
      "      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', error: null } } }));",
      "      return;",
      "    }",
      "    if (message.method === 'thread/compact/start') {",
      `      if (${compactClosesEarly}) { socket.close(); return; }`,
      "      socket.send(JSON.stringify({ id: message.id, result: {} }));",
      "      socket.send(JSON.stringify({ method: 'thread/compacted', params: { threadId, turnId: 'turn-compact-1' } }));",
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

  return { fakeCodex, spawnsPath, methodsPath };
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
    setCodexSessionIdleNotificationSink(null);
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

  it("compacts the thread natively once token usage crosses the threshold", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-persist-compact-"));
    // 200k against a 258k window crosses the default 60% threshold.
    const fake = await createFakeCodexAppServer(tempRoot, {
      tokenUsageTokens: 200_000,
      cachedTokenUsageTokens: 100_000,
    });
    const events: Array<{ type: string; label?: string; detail?: string }> = [];
    const notifications: CodexSessionIdleNotification[] = [];
    setCodexSessionIdleNotificationSink((notification) => {
      notifications.push(notification);
    });

    try {
      const result = await runCodexAppServerPrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "긴 작업",
        timeoutMs: 10_000,
        codexCommand: fake.fakeCodex,
        controlKey: "channel-persist-compact",
        onProgress: (event) => {
          events.push(event as { type: string; label?: string; detail?: string });
        },
      });
      expect(result.status).toBe("completed");

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "operation-progress",
          label: "컨텍스트 자동 압축 예정",
          detail: expect.stringContaining("200k/258k"),
        }),
      ]));

      let methods = "";
      for (let attempt = 0; attempt < 500; attempt += 1) {
        methods = await readFile(fake.methodsPath, "utf8").catch(() => "");
        if (methods.includes("thread/compact/start")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(methods).toContain("thread/resume");
      expect(methods).toContain("thread/compact/start");

      for (let attempt = 0; attempt < 500 && notifications.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(notifications).toEqual([
        expect.objectContaining({
          controlKey: "channel-persist-compact",
          sessionId: "thread-persist-1",
          message: expect.stringContaining("🧹 컨텍스트 자동 압축 완료"),
          isError: false,
        }),
      ]);
      expect(notifications[0]?.message).toContain("200k/258k");
      expect(notifications[0]?.message).not.toContain("300k/258k");
    } finally {
      await disposeCodexPersistentAppServers();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("reports a failed native compaction to the source channel", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-persist-compact-fail-"));
    const fake = await createFakeCodexAppServer(tempRoot, {
      tokenUsageTokens: 200_000,
      compactClosesEarly: true,
      threadId: "thread-persist-compact-fail",
    });
    const notifications: CodexSessionIdleNotification[] = [];
    setCodexSessionIdleNotificationSink((notification) => {
      notifications.push(notification);
    });

    try {
      const result = await runCodexAppServerPrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "압축 실패 테스트",
        timeoutMs: 10_000,
        codexCommand: fake.fakeCodex,
        controlKey: "channel-persist-compact-fail",
      });
      expect(result.status).toBe("completed");

      for (let attempt = 0; attempt < 500 && notifications.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(notifications).toEqual([
        expect.objectContaining({
          controlKey: "channel-persist-compact-fail",
          sessionId: "thread-persist-compact-fail",
          message: expect.stringContaining("⚠️ 컨텍스트 자동 압축 시도"),
          isError: true,
        }),
      ]);
    } finally {
      await disposeCodexPersistentAppServers();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

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
