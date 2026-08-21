import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { writeNodeTestExecutable } from "../test/testExecutable.js";
import WebSocket, { WebSocketServer } from "ws";
import { connectAgent, createAgentHelloMessage, handleAgentJob } from "./agentClient.js";

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

describe("agent client", () => {
  it("creates a hello message for registration", () => {
    expect(
      createAgentHelloMessage({
        computerId: "local-dev",
        displayName: "Local Dev",
        hostname: "local-dev.local",
        allowedRoleIds: ["role-operator"],
        capabilities: ["shell", "codex-import"],
        workspaces: [
          {
            id: "local-dev:/Users/me/project",
            absolutePath: "/Users/me/project",
            displayName: "project",
          },
        ],
      }),
    ).toEqual({
      type: "agent-hello",
      computerId: "local-dev",
      displayName: "Local Dev",
      hostname: "local-dev.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
      workspaces: [
        {
          id: "local-dev:/Users/me/project",
          absolutePath: "/Users/me/project",
          displayName: "project",
        },
      ],
    });
  });

  it("rejects unknown jobs", async () => {
    await expect(
      handleAgentJob({
        jobId: "job-1",
        type: "unknown",
        payload: {},
      }),
    ).rejects.toThrow("Unsupported agent job type");
  });

  it("sends a result envelope for a successful websocket job", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
    const server = new WebSocketServer({ port: 0 });
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    cleanup.push(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

    const serverReady = once(server, "listening");
    await serverReady;
    const address = server.address();
    if (typeof address === "string" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }

    const socket = connectAgent(`ws://127.0.0.1:${address.port}/agents`, {
      computerId: "computer-1",
      displayName: "Computer 1",
      hostname: "computer-1.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
      workspaces: [
        {
          id: "computer-1:/repo",
          absolutePath: "/repo",
          displayName: "repo",
        },
      ],
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }

          socket.once("close", () => resolve());
          socket.close();
        }),
    );

    const [connection] = await once(server, "connection");
    const serverSocket = connection as WebSocket;

    const [helloMessage] = await once(serverSocket, "message");
    expect(JSON.parse(helloMessage.toString())).toEqual({
      type: "agent-hello",
      computerId: "computer-1",
      displayName: "Computer 1",
      hostname: "computer-1.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
      workspaces: [
        {
          id: "computer-1:/repo",
          absolutePath: "/repo",
          displayName: "repo",
        },
      ],
    });

    const resultMessage = once(serverSocket, "message");
    serverSocket.send(
      JSON.stringify({
        jobId: "job-1",
        type: "run-command",
        payload: {
          workspaceRoot,
          cwd: workspaceRoot,
          command: process.platform === "win32" ? "[Console]::Out.Write('hello')" : "printf hello",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        },
      }),
    );

    const [rawResult] = await resultMessage;
    expect(JSON.parse(rawResult.toString())).toEqual({
      type: "agent-job-result",
      jobId: "job-1",
      result: {
        status: "completed",
        stdout: "hello",
        stderr: "",
        exitCode: 0,
      },
    });

    socket.close();
  });

  it("sends progress envelopes while a Codex websocket job is running", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
    const fakeCodex = path.join(workspaceRoot, "codex");
    const server = new WebSocketServer({ port: 0 });
    const serverReady = once(server, "listening");
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    cleanup.push(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

    await writeNodeTestExecutable(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('--output-last-message');",
        "console.log(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '중간 출력입니다.' } }));",
        "fs.writeFileSync(args[outputIndex + 1], 'Final answer');",
      ].join("\n"),
      "utf8",
    );

    await serverReady;
    const address = server.address();
    if (typeof address === "string" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }

    const socket = connectAgent(`ws://127.0.0.1:${address.port}/agents`, {
      computerId: "computer-1",
      displayName: "Computer 1",
      capabilities: ["shell", "codex-import"],
      workspaces: [],
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }

          socket.once("close", () => resolve());
          socket.close();
        }),
    );

    const [connection] = await once(server, "connection");
    const serverSocket = connection as WebSocket;
    await once(serverSocket, "message");

    const progressMessage = once(serverSocket, "message");
    serverSocket.send(
      JSON.stringify({
        jobId: "job-codex-1",
        type: "run-codex-prompt",
        payload: {
          workspaceRoot,
          cwd: workspaceRoot,
          prompt: "Explain this",
          timeoutMs: 5_000,
          codexCommand: fakeCodex,
        },
      }),
    );

    const [rawProgress] = await progressMessage;
    expect(JSON.parse(rawProgress.toString())).toEqual({
      type: "agent-job-progress",
      jobId: "job-codex-1",
      event: {
        type: "agent-message",
        text: "중간 출력입니다.",
      },
    });

    const [rawResult] = await once(serverSocket, "message");
    expect(JSON.parse(rawResult.toString())).toMatchObject({
      type: "agent-job-result",
      jobId: "job-codex-1",
      result: {
        status: "completed",
        finalMessage: "Final answer",
      },
    });
  });

  it("sends an error envelope for an unsupported websocket job", async () => {
    const server = new WebSocketServer({ port: 0 });
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }

    const socket = connectAgent(`ws://127.0.0.1:${address.port}/agents`, {
      computerId: "computer-1",
      displayName: "Computer 1",
      hostname: "computer-1.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
      workspaces: [],
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }

          socket.once("close", () => resolve());
          socket.close();
        }),
    );

    const [connection] = await once(server, "connection");
    const serverSocket = connection as WebSocket;

    await once(serverSocket, "message");

    const resultMessage = once(serverSocket, "message");
    serverSocket.send(JSON.stringify({ jobId: "job-2", type: "unknown", payload: {} }));

    const [rawResult] = await resultMessage;
    expect(JSON.parse(rawResult.toString())).toEqual({
      type: "agent-job-result",
      jobId: "job-2",
      error: {
        message: "Unsupported agent job type",
      },
    });

    socket.close();
  });
});
