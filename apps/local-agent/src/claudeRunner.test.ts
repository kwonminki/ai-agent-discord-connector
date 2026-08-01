import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeNodeTestExecutable } from "../test/testExecutable.js";
import {
  runClaudePrompt,
  steerActiveClaudeTurn,
} from "./claudeRunner.js";

describe("runClaudePrompt", () => {
  it("returns a coded failure when Claude Code is missing", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runner-"));

    try {
      await expect(
        runClaudePrompt({
          workspaceRoot: tempRoot,
          cwd: tempRoot,
          prompt: "Explain this",
          timeoutMs: 5_000,
          claudeCommand: path.join(tempRoot, "missing-claude"),
        }),
      ).resolves.toMatchObject({
        status: "failed",
        finalMessage: "",
        sessionId: null,
        stderr: "Claude Code command was not found. Install Claude Code or set CODEX_DISCORD_CLAUDE_COMMAND.",
        exitCode: null,
        errorCode: "CLAUDE_CLI_NOT_FOUND",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs Claude Code headless and captures stream-json progress and result", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runner-"));
    const fakeClaude = path.join(tempRoot, "claude");
    const events: unknown[] = [];

    try {
      await writeNodeTestExecutable(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }));",
          "console.log(JSON.stringify({ type: 'system', subtype: 'status', session_id: 'claude-session-1' }));",
          "console.log(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', session_id: 'claude-session-1' }));",
          "console.log(JSON.stringify({ type: 'assistant', session_id: 'claude-session-1', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/README.md' } }] } }));",
          "console.log(JSON.stringify({ type: 'user', session_id: 'claude-session-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'README title and setup steps' }] } }));",
          "console.log(JSON.stringify({ type: 'assistant', session_id: 'claude-session-1', message: { content: [{ type: 'text', text: '중간 설명입니다.' }] } }));",
          "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1', result: '최종 답변입니다.' }));",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runClaudePrompt({
          workspaceRoot: tempRoot,
          cwd: tempRoot,
          prompt: "Explain this",
          timeoutMs: 5_000,
          claudeCommand: fakeClaude,
          onProgress: (event) => {
            events.push(event);
          },
        }),
      ).resolves.toMatchObject({
        status: "completed",
        finalMessage: "최종 답변입니다.",
        sessionId: "claude-session-1",
        stderr: "",
        exitCode: 0,
      });
      expect(events).toEqual([
        { type: "thread-started", sessionId: "claude-session-1" },
        {
          type: "operation-progress",
          label: "Claude 도구 실행 중",
          detail: "Read · 입력: {\"file_path\":\"/repo/README.md\"}",
          eventType: "tool_use",
        },
        {
          type: "operation-progress",
          label: "Claude 도구 실행 완료",
          detail: "README title and setup steps",
          eventType: "tool_result",
        },
        { type: "agent-message", text: "중간 설명입니다." },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("surfaces thinking blocks as agent-thought progress events", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runner-thought-"));
    const fakeClaude = path.join(tempRoot, "claude");
    const events: unknown[] = [];

    try {
      await writeNodeTestExecutable(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-2' }));",
          "console.log(JSON.stringify({ type: 'assistant', session_id: 'claude-session-2', message: { content: [{ type: 'thinking', thinking: '로그 파일부터 살펴봐야겠다.' }, { type: 'text', text: '로그를 확인하겠습니다.' }] } }));",
          "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-2', result: '확인 완료' }));",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runClaudePrompt({
          workspaceRoot: tempRoot,
          cwd: tempRoot,
          prompt: "로그 확인해줘",
          timeoutMs: 5_000,
          claudeCommand: fakeClaude,
          onProgress: (event) => {
            events.push(event);
          },
        }),
      ).resolves.toMatchObject({
        status: "completed",
        finalMessage: "확인 완료",
      });

      expect(events).toEqual([
        { type: "thread-started", sessionId: "claude-session-2" },
        { type: "agent-thought", text: "로그 파일부터 살펴봐야겠다." },
        { type: "agent-message", text: "로그를 확인하겠습니다." },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("streams an additional user message into an active Claude Code turn", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runner-steer-"));
    const fakeClaude = path.join(tempRoot, "claude");
    const inputsPath = path.join(tempRoot, "inputs.json");
    const argsPath = path.join(tempRoot, "args.json");

    try {
      await writeNodeTestExecutable(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const readline = require('node:readline');",
          `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
          "const messages = [];",
          "let readyToFinish = false;",
          "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-steer-session-1' }));",
          "const input = readline.createInterface({ input: process.stdin });",
          "input.on('line', (line) => {",
          "  const message = JSON.parse(line);",
          "  messages.push(message);",
          `  fs.writeFileSync(${JSON.stringify(inputsPath)}, JSON.stringify(messages));`,
          "  if (messages.length === 1) {",
          "    console.log(JSON.stringify({ type: 'assistant', session_id: 'claude-steer-session-1', message: { content: [{ type: 'text', text: '첫 요청을 처리 중입니다.' }] } }));",
          "  }",
          "  if (messages.length === 2) {",
          "    readyToFinish = true;",
          "    console.log(JSON.stringify({ type: 'assistant', session_id: 'claude-steer-session-1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '추가 지시를 반영했습니다.' }] } }));",
          "  }",
          "});",
          "input.on('close', () => {",
          "  if (readyToFinish) {",
          "    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-steer-session-1', result: 'steered result' }));",
          "  }",
          "});",
        ].join("\n"),
        "utf8",
      );

      const run = runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "첫 요청",
        timeoutMs: 5_000,
        controlKey: "claude-thread-1",
        claudeCommand: fakeClaude,
        // This fake only emits its result once stdin closes, which is the
        // one-shot lifecycle; persistent sessions are covered separately.
        persistentSession: false,
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const inputs = await readFile(inputsPath, "utf8").catch(() => "");
        if (inputs.includes("첫 요청")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await expect(steerActiveClaudeTurn(
        "claude-thread-1",
        "테스트보다 구현을 먼저 진행해줘",
      )).resolves.toMatchObject({
        status: "accepted",
      });
      await expect(run).resolves.toMatchObject({
        status: "completed",
        finalMessage: "steered result",
        sessionId: "claude-steer-session-1",
      });

      const inputs = JSON.parse(await readFile(inputsPath, "utf8")) as Array<{
        type: string;
        message: { role: string; content: Array<{ type: string; text: string }> };
      }>;
      expect(inputs.map((message) => message.message.content[0]?.text)).toEqual([
        "첫 요청",
        "테스트보다 구현을 먼저 진행해줘",
      ]);
      expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual(expect.arrayContaining([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes --fork-session when resuming a Claude Code session fork", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runner-"));
    const fakeClaude = path.join(tempRoot, "claude");
    const argsPath = path.join(tempRoot, "args.json");

    try {
      await writeNodeTestExecutable(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
          "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-fork-session-1' }));",
          "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-fork-session-1', result: 'fork ready' }));",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runClaudePrompt({
          workspaceRoot: tempRoot,
          cwd: tempRoot,
          prompt: "Fork this session",
          timeoutMs: 5_000,
          claudeCommand: fakeClaude,
          sessionId: "claude-source-session-1",
          forkSession: true,
          sessionName: "GPU experiment",
        }),
      ).resolves.toMatchObject({
        status: "completed",
        sessionId: "claude-fork-session-1",
      });

      const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
      expect(args).toEqual(
        expect.arrayContaining([
          "--resume",
          "claude-source-session-1",
          "--fork-session",
          "--name",
          "GPU experiment",
        ]),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes selected model and effort to Claude Code", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-runner-"));
    const fakeClaude = path.join(tempRoot, "claude");
    const argsPath = path.join(tempRoot, "args.json");

    try {
      await writeNodeTestExecutable(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
          "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1', result: 'done' }));",
        ].join("\n"),
        "utf8",
      );

      await runClaudePrompt({
        workspaceRoot: tempRoot,
        cwd: tempRoot,
        prompt: "Use the configured model",
        timeoutMs: 5_000,
        claudeCommand: fakeClaude,
        model: "claude-fable-5[1m]",
        effort: "max",
      });

      const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
      expect(args).toEqual(expect.arrayContaining([
        "--model",
        "claude-fable-5[1m]",
        "--effort",
        "max",
      ]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
