import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  defaultAppServerTransportKind,
  interruptActiveCodexAppServerTurn,
  runCodexAppServerPrompt,
  steerActiveCodexAppServerTurn,
  terminateManagedAppServer,
} from "./codexAppServerRunner.js";

async function listenOnLoopback(httpServer: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not determine test app-server port.");
  }

  return `ws://127.0.0.1:${address.port}`;
}

describe("runCodexAppServerPrompt", () => {
  it("uses loopback TCP on Windows and Unix sockets elsewhere", () => {
    expect(defaultAppServerTransportKind("win32")).toBe("tcp");
    expect(defaultAppServerTransportKind("darwin")).toBe("unix");
    expect(defaultAppServerTransportKind("linux")).toBe("unix");
  });

  it("force-stops a managed app-server child that ignores graceful termination", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    await once(child, "spawn");

    await terminateManagedAppServer(child, 20, 1_000);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("steers and interrupts an active turn through its control key", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-control-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    const received: Array<{ method: string; params: unknown }> = [];

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: unknown };

          if (!message.method) {
            return;
          }

          received.push({ method: message.method, params: message.params });

          if (message.method === "initialize") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            return;
          }

          if (message.method === "thread/start") {
            socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "control-thread-1" } } }));
            return;
          }

          if (message.method === "turn/start") {
            socket.send(JSON.stringify({
              id: message.id,
              result: { turn: { id: "control-turn-1", status: "inProgress", items: [] } },
            }));
            return;
          }

          if (message.method === "turn/steer") {
            socket.send(JSON.stringify({ id: message.id, result: { turnId: "control-turn-1" } }));
            return;
          }

          if (message.method === "turn/interrupt") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            socket.send(JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "control-thread-1",
                turn: { id: "control-turn-1", status: "interrupted", error: { message: "Interrupted" } },
              },
            }));
          }
        });
      });

      const runPromise = runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "긴 작업을 시작해줘",
        timeoutMs: 5_000,
        sessionId: null,
        controlKey: "discord-channel-1",
        appServerUrl,
      });

      let steerResult = await steerActiveCodexAppServerTurn("discord-channel-1", "구현 방향을 바꿔줘");
      for (let attempt = 0; attempt < 20 && steerResult.status === "no-active-turn"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        steerResult = await steerActiveCodexAppServerTurn("discord-channel-1", "구현 방향을 바꿔줘");
      }

      expect(steerResult).toMatchObject({
        status: "accepted",
        threadId: "control-thread-1",
        turnId: "control-turn-1",
      });
      expect(await interruptActiveCodexAppServerTurn("discord-channel-1")).toMatchObject({
        status: "accepted",
        threadId: "control-thread-1",
        turnId: "control-turn-1",
      });
      await expect(runPromise).resolves.toMatchObject({ status: "failed", finalMessage: "Interrupted" });
      await expect(interruptActiveCodexAppServerTurn("discord-channel-1")).resolves.toMatchObject({
        status: "no-active-turn",
      });
      expect(received).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "turn/steer",
          params: {
            threadId: "control-thread-1",
            expectedTurnId: "control-turn-1",
            input: [{ type: "text", text: "구현 방향을 바꿔줘", text_elements: [] }],
          },
        }),
        expect.objectContaining({
          method: "turn/interrupt",
          params: { threadId: "control-thread-1", turnId: "control-turn-1" },
        }),
      ]));
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("refreshes a stale active turn id before steering a goal continuation", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-stale-steer-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    const steerTurnIds: string[] = [];

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            id?: number;
            method?: string;
            params?: { expectedTurnId?: string };
          };

          if (message.method === "initialize") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            return;
          }

          if (message.method === "thread/start") {
            socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "goal-thread-1" } } }));
            return;
          }

          if (message.method === "turn/start") {
            socket.send(JSON.stringify({
              id: message.id,
              result: { turn: { id: "discord-turn-1", status: "inProgress", items: [] } },
            }));
            return;
          }

          if (message.method === "thread/read") {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                thread: {
                  id: "goal-thread-1",
                  turns: [
                    { id: "discord-turn-1", status: "completed", items: [] },
                    { id: "goal-continuation-2", status: "inProgress", items: [] },
                  ],
                },
              },
            }));
            return;
          }

          if (message.method === "turn/steer") {
            const expectedTurnId = message.params?.expectedTurnId ?? "";
            steerTurnIds.push(expectedTurnId);

            if (expectedTurnId === "discord-turn-1") {
              socket.send(JSON.stringify({
                id: message.id,
                error: {
                  code: -32600,
                  message: "expected active turn id 'discord-turn-1' but found 'goal-continuation-2'",
                },
              }));
            } else {
              socket.send(JSON.stringify({
                id: message.id,
                result: { turnId: "goal-continuation-2" },
              }));
            }
            return;
          }

          if (message.method === "turn/interrupt") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            socket.send(JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "goal-thread-1",
                turn: { id: "goal-continuation-2", status: "interrupted", error: { message: "Interrupted" } },
              },
            }));
          }
        });
      });

      const runPromise = runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "장기 목표를 계속 진행해줘",
        timeoutMs: 5_000,
        sessionId: null,
        controlKey: "goal-discord-channel",
        appServerUrl,
      });

      let steerResult = await steerActiveCodexAppServerTurn("goal-discord-channel", "현재 방향을 수정해줘");
      for (let attempt = 0; attempt < 20 && steerResult.status === "no-active-turn"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        steerResult = await steerActiveCodexAppServerTurn("goal-discord-channel", "현재 방향을 수정해줘");
      }

      expect(steerResult).toMatchObject({
        status: "accepted",
        threadId: "goal-thread-1",
        turnId: "goal-continuation-2",
      });
      expect(steerTurnIds).toEqual(["discord-turn-1", "goal-continuation-2"]);
      expect(await interruptActiveCodexAppServerTurn("goal-discord-channel")).toMatchObject({
        status: "accepted",
        turnId: "goal-continuation-2",
      });
      await expect(runPromise).resolves.toMatchObject({ status: "failed", finalMessage: "Interrupted" });
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("refreshes a stale active turn id before interrupting a goal continuation", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-stale-interrupt-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    const interruptTurnIds: string[] = [];

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            id?: number;
            method?: string;
            params?: { turnId?: string };
          };

          if (message.method === "initialize") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            return;
          }

          if (message.method === "thread/start") {
            socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "interrupt-thread-1" } } }));
            return;
          }

          if (message.method === "turn/start") {
            socket.send(JSON.stringify({
              id: message.id,
              result: { turn: { id: "discord-turn-1", status: "inProgress", items: [] } },
            }));
            return;
          }

          if (message.method === "thread/read") {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                thread: {
                  id: "interrupt-thread-1",
                  turns: [
                    { id: "discord-turn-1", status: "completed", items: [] },
                    { id: "goal-continuation-2", status: "inProgress", items: [] },
                  ],
                },
              },
            }));
            return;
          }

          if (message.method === "turn/interrupt") {
            const turnId = message.params?.turnId ?? "";
            interruptTurnIds.push(turnId);

            if (turnId === "discord-turn-1") {
              socket.send(JSON.stringify({
                id: message.id,
                error: {
                  code: -32600,
                  message: "expected active turn id `discord-turn-1` but found `goal-continuation-2`",
                },
              }));
            } else {
              socket.send(JSON.stringify({ id: message.id, result: {} }));
              socket.send(JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "interrupt-thread-1",
                  turn: { id: "goal-continuation-2", status: "interrupted", error: { message: "Interrupted" } },
                },
              }));
            }
          }
        });
      });

      const runPromise = runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "장기 목표를 계속 진행해줘",
        timeoutMs: 5_000,
        sessionId: null,
        controlKey: "interrupt-discord-channel",
        appServerUrl,
      });

      let interruptResult = await interruptActiveCodexAppServerTurn("interrupt-discord-channel");
      for (let attempt = 0; attempt < 20 && interruptResult.status === "no-active-turn"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        interruptResult = await interruptActiveCodexAppServerTurn("interrupt-discord-channel");
      }

      expect(interruptResult).toMatchObject({
        status: "accepted",
        threadId: "interrupt-thread-1",
        turnId: "goal-continuation-2",
      });
      expect(interruptTurnIds).toEqual(["discord-turn-1", "goal-continuation-2"]);
      await expect(runPromise).resolves.toMatchObject({ status: "failed", finalMessage: "Interrupted" });
      await expect(interruptActiveCodexAppServerTurn("interrupt-discord-channel")).resolves.toMatchObject({
        status: "no-active-turn",
      });
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs a prompt through the Codex app-server protocol", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-runner-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    const received: Array<{ method: string; params: unknown }> = [];

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: unknown };

          if (!message.method) {
            return;
          }

          received.push({ method: message.method, params: message.params });

          if (message.method === "initialize") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  userAgent: "Codex Desktop/0.0.0 test",
                  codexHome: path.join(workspaceRoot, ".codex"),
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              }),
            );
            return;
          }

          if (message.method === "thread/start") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  thread: {
                    id: "thread-1",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "thread/started",
                params: {
                  thread: {
                    id: "thread-1",
                  },
                },
              }),
            );
            return;
          }

          if (message.method === "turn/start") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  turn: {
                    id: "turn-1",
                    status: "inProgress",
                    items: [],
                    itemsView: "notLoaded",
                    error: null,
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/started",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "commandExecution",
                    id: "command-1",
                    command: "pnpm test",
                    cwd: workspaceRoot,
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/commandExecution/outputDelta",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "command-1",
                  delta: "330 tests passed\n",
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "commandExecution",
                    id: "command-1",
                    command: "pnpm test",
                    cwd: workspaceRoot,
                    exitCode: 0,
                    durationMs: 850,
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/reasoning/summaryTextDelta",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "reasoning-1",
                  summaryIndex: 0,
                  delta: "샘플 경계를 다시 확인했습니다.",
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "reasoning",
                    id: "reasoning-1",
                    summary: [],
                    content: ["외부로 보내면 안 되는 raw reasoning"],
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "item-1",
                  delta: "완료",
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    type: "agentMessage",
                    id: "item-1",
                    text: "완료했습니다.",
                    phase: "final_answer",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "thread/goal/updated",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  goal: {
                    threadId: "thread-1",
                    objective: "장기 작업을 끝낸다",
                    status: "active",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "thread-1",
                  turn: {
                    id: "turn-1",
                    status: "completed",
                    error: null,
                  },
                },
              }),
            );
          }
        });
      });

      const events: unknown[] = [];
      let finalProgressDelivered = false;
      const result = await runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "테스트",
        timeoutMs: 5_000,
        appServerUrl,
        onProgress: async (event) => {
          if (event.type === "agent-message") {
            await new Promise((resolve) => setTimeout(resolve, 25));
            finalProgressDelivered = true;
          }
          events.push(event);
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        finalMessage: "완료했습니다.",
        sessionId: "thread-1",
        exitCode: 0,
        goalStatus: "active",
      });
      expect(finalProgressDelivered).toBe(true);
      expect(events.at(-1)).toEqual({ type: "agent-message", text: "완료했습니다." });
      expect(events).toEqual(
        expect.arrayContaining([
          { type: "thread-started", sessionId: "thread-1" },
          {
            type: "operation-progress",
            label: "명령 실행 중",
            detail: `명령: pnpm test · 위치: ${workspaceRoot}`,
            eventType: "item/started",
          },
          {
            type: "operation-progress",
            label: "명령 실행 완료",
            detail: `명령: pnpm test · 위치: ${workspaceRoot} · 종료 코드: 0 · 소요: 850ms · 출력: 330 tests passed`,
            eventType: "item/completed",
          },
          {
            type: "operation-progress",
            label: "생각 정리",
            detail: "샘플 경계를 다시 확인했습니다.",
            eventType: "item/completed",
          },
          { type: "agent-message", text: "완료했습니다." },
        ]),
      );
      expect(JSON.stringify(events)).not.toContain("외부로 보내면 안 되는 raw reasoning");
      expect(received).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "thread/start",
            params: expect.objectContaining({
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            }),
          }),
          expect.objectContaining({
            method: "turn/start",
            params: expect.objectContaining({
              approvalPolicy: "never",
              sandboxPolicy: { type: "dangerFullAccess" },
            }),
          }),
        ]),
      );
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("isolates concurrent sessions when a shared app-server broadcasts notifications", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-isolation-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    const connections: Array<{
      socket: import("ws").WebSocket;
      threadId: string | null;
      turnId: string | null;
    }> = [];
    let notificationsSent = false;

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        const connection = {
          socket,
          threadId: null as string | null,
          turnId: null as string | null,
        };
        connections.push(connection);

        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            id?: number;
            method?: string;
          };

          if (message.method === "initialize") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            return;
          }

          if (message.method === "thread/start") {
            connection.threadId = `isolated-thread-${connections.indexOf(connection) + 1}`;
            socket.send(JSON.stringify({
              id: message.id,
              result: { thread: { id: connection.threadId } },
            }));
            return;
          }

          if (message.method !== "turn/start") {
            return;
          }

          connection.turnId = `isolated-turn-${connections.indexOf(connection) + 1}`;
          socket.send(JSON.stringify({
            id: message.id,
            result: {
              turn: {
                id: connection.turnId,
                status: "inProgress",
                items: [],
              },
            },
          }));

          if (notificationsSent || connections.some((candidate) => !candidate.turnId)) {
            return;
          }
          notificationsSent = true;

          for (const recipient of connections) {
            for (const source of connections) {
              recipient.socket.send(JSON.stringify({
                method: "thread/started",
                params: { thread: { id: source.threadId } },
              }));
            }

            for (const source of connections) {
              const suffix = source.threadId?.split("-").at(-1);
              recipient.socket.send(JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: source.threadId,
                  turnId: source.turnId,
                  item: {
                    type: "agentMessage",
                    id: `isolated-message-${suffix}`,
                    text: `isolated answer ${suffix}`,
                    phase: "final_answer",
                  },
                },
              }));
              recipient.socket.send(JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: source.threadId,
                  turn: {
                    id: source.turnId,
                    status: "completed",
                    error: null,
                  },
                },
              }));
            }
          }
        });
      });

      const firstEvents: unknown[] = [];
      const secondEvents: unknown[] = [];
      const results = await Promise.all([
        runCodexAppServerPrompt({
          workspaceRoot,
          cwd: workspaceRoot,
          prompt: "첫 번째 동시 요청",
          timeoutMs: 5_000,
          appServerUrl,
          onProgress: (event) => {
            firstEvents.push(event);
          },
        }),
        runCodexAppServerPrompt({
          workspaceRoot,
          cwd: workspaceRoot,
          prompt: "두 번째 동시 요청",
          timeoutMs: 5_000,
          appServerUrl,
          onProgress: (event) => {
            secondEvents.push(event);
          },
        }),
      ]);

      expect(results).toEqual([
        expect.objectContaining({
          status: "completed",
          sessionId: "isolated-thread-1",
          finalMessage: "isolated answer 1",
        }),
        expect.objectContaining({
          status: "completed",
          sessionId: "isolated-thread-2",
          finalMessage: "isolated answer 2",
        }),
      ]);
      expect(firstEvents).toEqual([
        { type: "thread-started", sessionId: "isolated-thread-1" },
        { type: "agent-message", text: "isolated answer 1" },
      ]);
      expect(secondEvents).toEqual([
        { type: "thread-started", sessionId: "isolated-thread-2" },
        { type: "agent-message", text: "isolated answer 2" },
      ]);
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("forks an existing app-server thread before starting a turn", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-runner-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    const received: Array<{ method: string; params: unknown }> = [];

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: unknown };

          if (!message.method) {
            return;
          }

          received.push({ method: message.method, params: message.params });

          if (message.method === "initialize") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  userAgent: "Codex Desktop/0.0.0 test",
                  codexHome: path.join(workspaceRoot, ".codex"),
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              }),
            );
            return;
          }

          if (message.method === "thread/fork") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  newThread: {
                    id: "fork-thread-1",
                  },
                },
              }),
            );
            return;
          }

          if (message.method === "thread/name/set") {
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            return;
          }

          if (message.method === "turn/start") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  turn: {
                    id: "fork-turn-1",
                    status: "inProgress",
                    items: [],
                    itemsView: "notLoaded",
                    error: null,
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "fork-thread-1",
                  turnId: "fork-turn-1",
                  item: {
                    type: "agentMessage",
                    id: "fork-message-1",
                    text: "분기 세션이 준비되었습니다.",
                    phase: "final_answer",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "fork-thread-1",
                  turn: {
                    id: "fork-turn-1",
                    status: "completed",
                    error: null,
                  },
                },
              }),
            );
          }
        });
      });

      const events: unknown[] = [];
      const result = await runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "fork 준비",
        timeoutMs: 5_000,
        sessionId: "source-thread-1",
        forkSession: true,
        sessionName: "Refactor branch",
        appServerUrl,
        onProgress: (event) => {
          events.push(event);
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        finalMessage: "분기 세션이 준비되었습니다.",
        sessionId: "fork-thread-1",
        exitCode: 0,
      });
      expect(events).toEqual(
        expect.arrayContaining([
          { type: "thread-started", sessionId: "fork-thread-1" },
          { type: "agent-message", text: "분기 세션이 준비되었습니다." },
        ]),
      );
      expect(received).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "thread/fork",
            params: expect.objectContaining({
              threadId: "source-thread-1",
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            }),
          }),
          expect.objectContaining({
            method: "thread/name/set",
            params: {
              threadId: "fork-thread-1",
              name: "Refactor branch",
            },
          }),
          expect.objectContaining({
            method: "turn/start",
            params: expect.objectContaining({
              threadId: "fork-thread-1",
            }),
          }),
        ]),
      );
      const forkIndex = received.findIndex((entry) => entry.method === "thread/fork");
      const nameIndex = received.findIndex((entry) => entry.method === "thread/name/set");
      const turnIndex = received.findIndex((entry) => entry.method === "turn/start");
      expect(forkIndex).toBeLessThan(nameIndex);
      expect(nameIndex).toBeLessThan(turnIndex);
      expect(received.some((entry) => entry.method === "thread/resume")).toBe(false);
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("answers app-server command approval requests", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-runner-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    let approvalResponse: unknown = null;

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            id?: number | string;
            method?: string;
            params?: unknown;
            result?: unknown;
          };

          if (message.id === "approval-1" && !message.method) {
            approvalResponse = message.result;
            socket.send(
              JSON.stringify({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "thread-approval",
                  turnId: "turn-approval",
                  itemId: "item-approval",
                  delta: "승인됨",
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "thread-approval",
                  turnId: "turn-approval",
                  item: {
                    type: "agentMessage",
                    id: "item-approval",
                    text: "승인 후 완료했습니다.",
                    phase: "final_answer",
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                method: "turn/completed",
                params: {
                  threadId: "thread-approval",
                  turn: {
                    id: "turn-approval",
                    status: "completed",
                    error: null,
                  },
                },
              }),
            );
            return;
          }

          if (!message.method) {
            return;
          }

          if (message.method === "initialize") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  userAgent: "Codex Desktop/0.0.0 test",
                  codexHome: path.join(workspaceRoot, ".codex"),
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              }),
            );
            return;
          }

          if (message.method === "thread/start") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  thread: {
                    id: "thread-approval",
                  },
                },
              }),
            );
            return;
          }

          if (message.method === "turn/start") {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  turn: {
                    id: "turn-approval",
                    status: "inProgress",
                    items: [],
                    itemsView: "notLoaded",
                    error: null,
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                id: "approval-1",
                method: "item/commandExecution/requestApproval",
                params: {
                  threadId: "thread-approval",
                  turnId: "turn-approval",
                  itemId: "command-1",
                  startedAtMs: Date.now(),
                  command: "pnpm test",
                  cwd: workspaceRoot,
                  reason: "테스트 승인이 필요합니다.",
                },
              }),
            );
          }
        });
      });

      const approvalRequests: unknown[] = [];
      const result = await runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "테스트",
        timeoutMs: 5_000,
        appServerUrl,
        onApprovalRequest: (request) => {
          approvalRequests.push(request);
          return { decision: "acceptForSession" };
        },
      });

      expect(approvalRequests).toEqual([
        expect.objectContaining({
          kind: "command",
          command: "pnpm test",
          cwd: workspaceRoot,
          reason: "테스트 승인이 필요합니다.",
        }),
      ]);
      expect(approvalResponse).toEqual({ decision: "acceptForSession" });
      expect(result).toMatchObject({
        status: "completed",
        finalMessage: "승인 후 완료했습니다.",
        sessionId: "thread-approval",
      });
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("answers app-server request_user_input tool requests", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-runner-"));
    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    let userInputResponse: unknown = null;

    try {
      const appServerUrl = await listenOnLoopback(httpServer);

      wsServer.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            id?: number | string;
            method?: string;
            result?: unknown;
          };

          if (message.id === "user-input-1" && !message.method) {
            userInputResponse = message.result;
            socket.send(JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-user-input",
                turnId: "turn-user-input",
                item: {
                  type: "agentMessage",
                  id: "item-answer",
                  text: "선택한 방식으로 구현했습니다.",
                  phase: "final_answer",
                },
              },
            }));
            socket.send(JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-user-input",
                turn: { id: "turn-user-input", status: "completed", error: null },
              },
            }));
            return;
          }

          if (!message.method) {
            return;
          }

          if (message.method === "initialize") {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                userAgent: "Codex Desktop/0.0.0 test",
                codexHome: path.join(workspaceRoot, ".codex"),
                platformFamily: "unix",
                platformOs: "macos",
              },
            }));
            return;
          }

          if (message.method === "thread/start") {
            socket.send(JSON.stringify({
              id: message.id,
              result: { thread: { id: "thread-user-input" } },
            }));
            return;
          }

          if (message.method === "turn/start") {
            socket.send(JSON.stringify({
              id: message.id,
              result: {
                turn: {
                  id: "turn-user-input",
                  status: "inProgress",
                  items: [],
                  itemsView: "notLoaded",
                  error: null,
                },
              },
            }));
            socket.send(JSON.stringify({
              id: "user-input-1",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "thread-user-input",
                turnId: "turn-user-input",
                itemId: "question-1",
                questions: [{
                  id: "implementation",
                  header: "구현 방식",
                  question: "어떤 방식으로 구현할까요?",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "별도 계층", description: "기존 코드와 분리합니다." },
                    { label: "직접 수정", description: "현재 코드에 바로 반영합니다." },
                  ],
                }],
                autoResolutionMs: null,
              },
            }));
          }
        });
      });

      const userInputRequests: unknown[] = [];
      const result = await runCodexAppServerPrompt({
        workspaceRoot,
        cwd: workspaceRoot,
        prompt: "질문해줘",
        timeoutMs: 5_000,
        appServerUrl,
        onUserInputRequest: (request) => {
          userInputRequests.push(request);
          return { answers: { implementation: { answers: ["별도 계층"] } } };
        },
      });

      expect(userInputRequests).toEqual([{
        threadId: "thread-user-input",
        turnId: "turn-user-input",
        itemId: "question-1",
        questions: [{
          id: "implementation",
          header: "구현 방식",
          question: "어떤 방식으로 구현할까요?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "별도 계층", description: "기존 코드와 분리합니다." },
            { label: "직접 수정", description: "현재 코드에 바로 반영합니다." },
          ],
        }],
        autoResolutionMs: null,
      }]);
      expect(userInputResponse).toEqual({
        answers: { implementation: { answers: ["별도 계층"] } },
      });
      expect(result).toMatchObject({
        status: "completed",
        finalMessage: "선택한 방식으로 구현했습니다.",
        sessionId: "thread-user-input",
      });
    } finally {
      wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
