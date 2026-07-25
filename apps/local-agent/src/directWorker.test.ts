import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDirectWorkerClient } from "../../discord-bot/src/directWorkerClient.js";
import { startDirectWorker } from "./directWorker.js";
import { createDirectWorkerStore } from "./directWorkerStore.js";

describe("direct worker", () => {
  it("wakes immediately for a new job while retaining a slow polling fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-wake-"));
    const store = createDirectWorkerStore(path.join(root, "worker"));
    const worker = await startDirectWorker({ store, pollIntervalMs: 10_000, maxConcurrency: 1 });
    const client = createDirectWorkerClient({ store, pollIntervalMs: 10 });

    try {
      const startedAt = Date.now();
      await expect(client.submit({
        jobId: "wake-job",
        type: "run-command",
        queueKey: "thread-1",
        payload: {
          workspaceRoot: root,
          cwd: root,
          command: "printf woke",
          timeoutMs: 5_000,
          confirmedDangerous: true,
        },
      })).resolves.toMatchObject({ result: { status: "completed", stdout: "woke" } });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps executing a durable job while a second client reconnects to the same job id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-"));
    const workspace = path.join(root, "workspace");
    const store = createDirectWorkerStore(path.join(root, "worker"));
    const worker = await startDirectWorker({ store, pollIntervalMs: 10, maxConcurrency: 2 });
    const firstClient = createDirectWorkerClient({ store, pollIntervalMs: 10 });
    const secondClient = createDirectWorkerClient({ store, pollIntervalMs: 10 });

    try {
      const input = {
        jobId: "discord-request-1",
        type: "run-command" as const,
        queueKey: "thread-1",
        payload: {
          workspaceRoot: root,
          cwd: root,
          command: `mkdir -p '${workspace}' && sleep 0.15 && printf survived`,
          timeoutMs: 5_000,
          confirmedDangerous: true,
        },
      };
      const originalWaiter = firstClient.submit(input);

      await expect(secondClient.submit(input)).resolves.toMatchObject({
        jobId: "discord-request-1",
        result: {
          status: "completed",
          stdout: "survived",
        },
      });
      await expect(originalWaiter).resolves.toMatchObject({ jobId: "discord-request-1" });
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes jobs with the same queue key while allowing durable result reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-order-"));
    const outputPath = path.join(root, "order.txt");
    const store = createDirectWorkerStore(path.join(root, "worker"));
    const firstClient = createDirectWorkerClient({ store, pollIntervalMs: 10 });
    const secondClient = createDirectWorkerClient({ store, pollIntervalMs: 10 });

    try {
      const basePayload = {
        workspaceRoot: root,
        cwd: root,
        timeoutMs: 5_000,
        confirmedDangerous: true,
      };
      const first = firstClient.submit({
        jobId: "ordered-1",
        type: "run-command",
        queueKey: "thread-1",
        payload: { ...basePayload, command: `sleep 0.1; printf 'first\\n' >> '${outputPath}'` },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = secondClient.submit({
        jobId: "ordered-2",
        type: "run-command",
        queueKey: "thread-1",
        payload: { ...basePayload, command: `printf 'second\\n' >> '${outputPath}'` },
      });
      const startedAt = Date.now();
      const worker = await startDirectWorker({ store, pollIntervalMs: 1_500, maxConcurrency: 4 });

      try {
        await Promise.all([first, second]);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        await expect(readFile(outputPath, "utf8")).resolves.toBe("first\nsecond\n");
      } finally {
        await worker.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the Discord progress delivery cursor for reconnecting clients", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-cursor-"));
    const store = createDirectWorkerStore(path.join(root, "worker"));

    try {
      await store.enqueue({
        jobId: "cursor-job",
        type: "run-command",
        queueKey: "thread-1",
        payload: {
          workspaceRoot: root,
          cwd: root,
          command: "printf cursor",
          timeoutMs: 5_000,
          confirmedDangerous: true,
        },
      });
      await store.appendProgress("cursor-job", { type: "agent-message", text: "first" });
      await expect(store.readEvents("cursor-job")).resolves.toHaveLength(1);
      await store.appendProgress("cursor-job", { type: "agent-message", text: "second" });
      await store.writeDeliveryCursor("cursor-job", 1);
      await store.complete("cursor-job", { status: "completed" });
      const delivered: string[] = [];

      await expect(store.readDeliveryCursor("cursor-job")).resolves.toBe(1);
      await expect(store.readEvents("cursor-job")).resolves.toHaveLength(2);
      await createDirectWorkerClient({ store, pollIntervalMs: 10 }).submit({
        jobId: "cursor-job",
        type: "run-command",
        queueKey: "thread-1",
        payload: {
          workspaceRoot: root,
          cwd: root,
          command: "printf cursor",
          timeoutMs: 5_000,
          confirmedDangerous: true,
        },
        onProgress: (event) => {
          if (event.type === "agent-message") {
            delivered.push(event.text);
          }
        },
      });
      expect(delivered).toEqual(["second"]);
      await expect(store.readDeliveryCursor("cursor-job")).resolves.toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists request_user_input events and delivers the Discord answer to the worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-user-input-"));
    const store = createDirectWorkerStore(path.join(root, "worker"));

    try {
      await store.enqueue({
        jobId: "user-input-job",
        type: "run-codex-prompt",
        queueKey: "thread-1",
        payload: {
          runner: "app-server",
          input: {
            workspaceRoot: root,
            cwd: root,
            prompt: "choose",
            timeoutMs: 5_000,
          },
        },
      });
      const userInputId = await store.requestUserInput("user-input-job", {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{
          id: "mode",
          header: "모드",
          question: "어떤 모드를 사용할까요?",
          isOther: false,
          isSecret: false,
          options: [{ label: "안전", description: "보수적으로 실행합니다." }],
        }],
        autoResolutionMs: null,
      });
      await store.complete("user-input-job", { status: "completed" });
      const requests: unknown[] = [];

      await createDirectWorkerClient({ store, pollIntervalMs: 10 }).submit({
        jobId: "user-input-job",
        type: "run-codex-prompt",
        queueKey: "thread-1",
        payload: {
          runner: "app-server",
          input: {
            workspaceRoot: root,
            cwd: root,
            prompt: "choose",
            timeoutMs: 5_000,
          },
        },
        onUserInputRequest: (request) => {
          requests.push(request);
          return { answers: { mode: { answers: ["안전"] } } };
        },
      });

      expect(requests).toEqual([expect.objectContaining({ itemId: "item-1" })]);
      await expect(store.readUserInputResponse("user-input-job", userInputId)).resolves.toEqual({
        answers: { mode: { answers: ["안전"] } },
      });
      await expect(store.readDeliveryCursor("user-input-job")).resolves.toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps processing turn controls while draining an active job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-drain-control-"));
    const store = createDirectWorkerStore(path.join(root, "worker"));
    const handledControls: string[] = [];
    const worker = await startDirectWorker({
      store,
      pollIntervalMs: 10,
      maxConcurrency: 1,
      controlCodexTurn: async (control) => {
        handledControls.push(`${control.action}:${control.content ?? ""}`);
        return { status: "accepted", message: "Steering accepted while draining." };
      },
    });
    const client = createDirectWorkerClient({ store, pollIntervalMs: 10 });

    try {
      const job = client.submit({
        jobId: "draining-job",
        type: "run-command",
        queueKey: "thread-1",
        payload: {
          workspaceRoot: root,
          cwd: root,
          command: "sleep 0.5",
          timeoutMs: 5_000,
          confirmedDangerous: true,
        },
      });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await store.readState("draining-job"))?.status === "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(store.readState("draining-job")).resolves.toMatchObject({ status: "running" });

      const stopping = worker.stop();
      const control = client.control({
        controlKey: "thread-1",
        action: "steer",
        content: "새 지시",
      });
      await expect(Promise.race([
        control,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("Control was not handled until the active job finished.")),
          250,
        )),
      ])).resolves.toEqual({
        status: "accepted",
        message: "Steering accepted while draining.",
      });
      await Promise.all([job, stopping]);
      expect(handledControls).toEqual(["steer:새 지시"]);
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("steers an active Claude Code process through the durable control mailbox", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-claude-steer-"));
    const fakeClaude = path.join(root, "claude");
    const inputsPath = path.join(root, "inputs.json");
    const store = createDirectWorkerStore(path.join(root, "worker"));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      "const messages = [];",
      "let readyToFinish = false;",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-steer-1' }));",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  messages.push(JSON.parse(line));",
      `  fs.writeFileSync(${JSON.stringify(inputsPath)}, JSON.stringify(messages));`,
      "  if (messages.length === 2) {",
      "    readyToFinish = true;",
      "    console.log(JSON.stringify({ type: 'assistant', session_id: 'claude-steer-1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'steering applied' }] } }));",
      "    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-steer-1', result: 'steering applied' }));",
      "  }",
      "});",
      "input.on('close', () => process.exit(0));",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);
    const worker = await startDirectWorker({ store, pollIntervalMs: 10, maxConcurrency: 1 });
    const client = createDirectWorkerClient({ store, pollIntervalMs: 10 });

    try {
      const job = client.submit({
        jobId: "claude-steer-job",
        type: "run-claude-prompt",
        queueKey: "thread-claude",
        payload: {
          workspaceRoot: root,
          cwd: root,
          prompt: "first request",
          timeoutMs: 60_000,
          controlKey: "thread-claude",
          claudeCommand: fakeClaude,
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const inputs = await readFile(inputsPath, "utf8").catch(() => "");
        if (inputs.includes("first request")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await expect(client.control({
        controlKey: "thread-claude",
        action: "steer",
        content: "updated direction",
      })).resolves.toMatchObject({
        status: "accepted",
      });
      await expect(job).resolves.toMatchObject({
        result: {
          status: "completed",
          finalMessage: "steering applied",
          sessionId: "claude-steer-1",
        },
      });

      const inputs = JSON.parse(await readFile(inputsPath, "utf8")) as Array<{
        message: { content: Array<{ text: string }> };
      }>;
      expect(inputs.map((message) => message.message.content[0]?.text)).toEqual([
        "first request",
        "updated direction",
      ]);
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts an active Claude Code process by queue key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-claude-interrupt-"));
    const fakeClaude = path.join(root, "claude");
    const store = createDirectWorkerStore(path.join(root, "worker"));
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-interrupt-1' }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);
    const worker = await startDirectWorker({ store, pollIntervalMs: 10, maxConcurrency: 1 });
    const client = createDirectWorkerClient({ store, pollIntervalMs: 10 });

    try {
      const job = client.submit({
        jobId: "claude-interrupt-job",
        type: "run-claude-prompt",
        queueKey: "thread-claude",
        payload: {
          workspaceRoot: root,
          cwd: root,
          prompt: "keep working",
          timeoutMs: 60_000,
          claudeCommand: fakeClaude,
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await store.readState("claude-interrupt-job"))?.status === "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await expect(client.control({
        controlKey: "thread-claude",
        action: "interrupt",
      })).resolves.toEqual({
        status: "accepted",
        message: "Claude Code interrupt requested.",
      });
      await expect(job).resolves.toMatchObject({
        result: {
          status: "failed",
          errorCode: "CLAUDE_PROMPT_INTERRUPTED",
        },
      });
    } finally {
      await worker.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("moves invalid persisted jobs to dead-letter and returns a terminal failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-worker-invalid-"));
    const workerRoot = path.join(root, "worker");
    const store = createDirectWorkerStore(workerRoot);
    const jobDirectory = path.join(workerRoot, "jobs", "invalid-job");

    try {
      await store.initialize();
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(path.join(jobDirectory, "request.json"), JSON.stringify({
        version: 1,
        jobId: "invalid-job",
        type: "run-command",
        queueKey: "thread-1",
        payload: { command: "printf should-not-run" },
        createdAt: new Date().toISOString(),
      }));

      await expect(store.listRequests()).resolves.toEqual([]);
      await expect(store.readResult("invalid-job")).resolves.toMatchObject({
        error: { message: expect.stringContaining("Invalid direct worker job request") },
      });
      await expect(readdir(path.join(workerRoot, "dead-letter", "jobs"))).resolves.toHaveLength(1);
      if (process.platform !== "win32") {
        expect((await stat(workerRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(path.join(jobDirectory, "result.json"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
