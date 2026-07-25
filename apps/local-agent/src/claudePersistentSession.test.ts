import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudePersistentSessionCount,
  disposeClaudePersistentSessions,
  runClaudePrompt,
  setClaudeSessionIdleNotificationSink,
  type ClaudeSessionIdleNotification,
} from "./claudeRunner.js";

async function createPersistentFakeClaude(tempRoot: string, options: {
  usageTokens?: number;
} = {}): Promise<{
  fakeClaude: string;
  spawnsPath: string;
  argsPath: string;
  inputsPath: string;
  triggerPath: string;
}> {
  const fakeClaude = path.join(tempRoot, "claude");
  const spawnsPath = path.join(tempRoot, "spawns.log");
  const argsPath = path.join(tempRoot, "args.log");
  const inputsPath = path.join(tempRoot, "inputs.json");
  const triggerPath = path.join(tempRoot, "fire-idle-turn");
  const usageTokens = options.usageTokens ?? 1_000;

  await writeFile(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      `fs.appendFileSync(${JSON.stringify(spawnsPath)}, process.pid + '\\n');`,
      `fs.appendFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'persist-session-1' }));",
      "const messages = [];",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  messages.push(JSON.parse(line));",
      `  fs.writeFileSync(${JSON.stringify(inputsPath)}, JSON.stringify(messages));`,
      "  const n = messages.length;",
      `  console.log(JSON.stringify({ type: 'assistant', session_id: 'persist-session-1', message: { usage: { input_tokens: ${usageTokens}, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'answer ' + n }] } }));`,
      "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'persist-session-1', result: 'result ' + n }));",
      "});",
      "input.on('close', () => process.exit(0));",
      "setInterval(() => {",
      "  try {",
      `    if (fs.existsSync(${JSON.stringify(triggerPath)})) {`,
      `      fs.unlinkSync(${JSON.stringify(triggerPath)});`,
      "      console.log(JSON.stringify({ type: 'assistant', session_id: 'persist-session-1', message: { content: [{ type: 'text', text: '예약이 발화했습니다' }] } }));",
      "      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'persist-session-1', result: '예약 결과: pong' }));",
      "    }",
      "  } catch {}",
      "}, 10);",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeClaude, 0o755);

  return { fakeClaude, spawnsPath, argsPath, inputsPath, triggerPath };
}

async function countSpawns(spawnsPath: string): Promise<number> {
  const content = await readFile(spawnsPath, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean).length;
}

describe("persistent Claude Code sessions", () => {
  afterEach(async () => {
    await disposeClaudePersistentSessions("test-cleanup");
    setClaudeSessionIdleNotificationSink(null);
  });

  it("keeps one process alive across turns on the same control key", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-persist-"));
    const fake = await createPersistentFakeClaude(tempRoot);

    try {
      const first = await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "첫 번째 턴",
        timeoutMs: 5_000,
        controlKey: "channel-persist-1",
        sessionId: null,
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });
      expect(first).toMatchObject({
        status: "completed",
        finalMessage: "result 1",
        sessionId: "persist-session-1",
        exitCode: null,
      });
      expect(claudePersistentSessionCount()).toBe(1);

      const second = await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "두 번째 턴",
        timeoutMs: 5_000,
        controlKey: "channel-persist-1",
        sessionId: "persist-session-1",
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });
      expect(second).toMatchObject({
        status: "completed",
        finalMessage: "result 2",
        sessionId: "persist-session-1",
      });

      expect(await countSpawns(fake.spawnsPath)).toBe(1);
      const inputs = JSON.parse(await readFile(fake.inputsPath, "utf8")) as Array<{
        message: { content: Array<{ text: string }> };
      }>;
      expect(inputs.map((message) => message.message.content[0]?.text)).toEqual([
        "첫 번째 턴",
        "두 번째 턴",
      ]);
    } finally {
      await disposeClaudePersistentSessions("test-cleanup");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forwards idle turns (fired schedules) to the notification sink", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-persist-idle-"));
    const fake = await createPersistentFakeClaude(tempRoot);
    const notifications: ClaudeSessionIdleNotification[] = [];
    setClaudeSessionIdleNotificationSink((notification) => {
      notifications.push(notification);
    });

    try {
      await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "예약을 걸어줘",
        timeoutMs: 5_000,
        controlKey: "channel-persist-2",
        sessionId: null,
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });

      await writeFile(fake.triggerPath, "fire", "utf8");

      for (let attempt = 0; attempt < 300 && notifications.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        controlKey: "channel-persist-2",
        sessionId: "persist-session-1",
        message: "예약 결과: pong",
        isError: false,
      });
    } finally {
      await disposeClaudePersistentSessions("test-cleanup");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("spawns a fresh process when the channel starts a new conversation", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-persist-new-"));
    const fake = await createPersistentFakeClaude(tempRoot);

    try {
      await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "기존 대화",
        timeoutMs: 5_000,
        controlKey: "channel-persist-3",
        sessionId: null,
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });

      const fresh = await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "새 대화 시작",
        timeoutMs: 5_000,
        controlKey: "channel-persist-3",
        sessionId: null,
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });

      expect(fresh).toMatchObject({ status: "completed", finalMessage: "result 1" });
      expect(await countSpawns(fake.spawnsPath)).toBe(2);
    } finally {
      await disposeClaudePersistentSessions("test-cleanup");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("auto-compacts the session when context usage crosses the threshold", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-persist-compact-"));
    // 150k tokens against the default 200k window crosses the default 60%.
    const fake = await createPersistentFakeClaude(tempRoot, { usageTokens: 150_000 });
    const notifications: ClaudeSessionIdleNotification[] = [];
    setClaudeSessionIdleNotificationSink((notification) => {
      notifications.push(notification);
    });

    try {
      const first = await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "긴 작업을 해줘",
        timeoutMs: 5_000,
        controlKey: "channel-persist-compact",
        sessionId: null,
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });
      expect(first.status).toBe("completed");

      let inputs: Array<{ message: { content: Array<{ text: string }> } }> = [];
      for (let attempt = 0; attempt < 300; attempt += 1) {
        inputs = JSON.parse(await readFile(fake.inputsPath, "utf8").catch(() => "[]"));
        if (inputs.length >= 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(inputs.map((message) => message.message.content[0]?.text)).toEqual([
        "긴 작업을 해줘",
        "/compact",
      ]);

      for (let attempt = 0; attempt < 300 && notifications.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(notifications[0]?.message).toContain("컨텍스트 자동 압축 완료");
      expect(notifications[0]?.controlKey).toBe("channel-persist-compact");
    } finally {
      await disposeClaudePersistentSessions("test-cleanup");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resumes in a fresh process after the pooled process is gone", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-persist-resume-"));
    const fake = await createPersistentFakeClaude(tempRoot);

    try {
      await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "첫 턴",
        timeoutMs: 5_000,
        controlKey: "channel-persist-4",
        sessionId: null,
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });

      // Simulate a worker restart: the pool is empty but the conversation id
      // is still known to the bot.
      await disposeClaudePersistentSessions("simulated-restart");
      expect(claudePersistentSessionCount()).toBe(0);

      const resumed = await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "이어서 진행해줘",
        timeoutMs: 5_000,
        controlKey: "channel-persist-4",
        sessionId: "persist-session-1",
        claudeCommand: fake.fakeClaude,
        persistentSession: true,
      });

      expect(resumed).toMatchObject({ status: "completed", finalMessage: "result 1" });
      expect(await countSpawns(fake.spawnsPath)).toBe(2);

      const argsLines = (await readFile(fake.argsPath, "utf8")).trim().split("\n");
      const resumeArgs = JSON.parse(argsLines[1] ?? "[]") as string[];
      expect(resumeArgs).toEqual(expect.arrayContaining(["--resume", "persist-session-1"]));
    } finally {
      await disposeClaudePersistentSessions("test-cleanup");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
