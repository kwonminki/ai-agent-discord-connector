import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAgentRegistry } from "../../apps/control-api/src/agentRegistry.js";
import { createServer } from "../../apps/control-api/src/server.js";
import { connectAgent } from "../../apps/local-agent/src/agentClient.js";

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

async function listenOnRandomPort(app: ReturnType<typeof createServer>) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo | null;

  if (!address) {
    throw new Error("Expected server to listen on a TCP port");
  }

  return address.port;
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function waitForAgentRegistration(controlApiUrl: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${controlApiUrl}/computers`);
    const computers = (await response.json()) as unknown[];

    if (computers.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Expected local agent to register");
}

describe("control api to local agent command flow", () => {
  it("runs a workspace command through the websocket agent", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-discord-e2e-"));
    const app = createServer({ agentRegistry: createAgentRegistry(), jobTimeoutMs: 5_000 });
    const port = await listenOnRandomPort(app);
    const controlApiUrl = `http://127.0.0.1:${port}`;
    const agentSocket = connectAgent(`ws://127.0.0.1:${port}/agents`, {
      computerId: "computer-1",
      displayName: "macbook-pro-01",
      capabilities: ["shell", "codex-import"],
    });

    cleanup.push(() => closeSocket(agentSocket));
    cleanup.push(() => app.close());
    cleanup.push(() => rm(workspaceRoot, { recursive: true, force: true }));

    await writeFile(path.join(workspaceRoot, "README.md"), "hello from the real local agent\n", "utf8");
    await waitForAgentRegistration(controlApiUrl);

    const response = await fetch(`${controlApiUrl}/computers/computer-1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "run-command",
        payload: {
          workspaceRoot,
          cwd: workspaceRoot,
          command: "cat README.md",
          timeoutMs: 3_000,
          confirmedDangerous: false,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        status: "completed",
        stdout: expect.stringMatching(/^hello from the real local agent\r?\n$/),
        stderr: "",
        exitCode: 0,
      },
    });
  }, 15_000);
});
