import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeSqliteScript } from "../../../packages/codex-adapter/src/sqlite.js";
import { createDirectControlClient, resolveDirectCodexRunner } from "./directControlClient.js";
import { createDirectSyncStateStore } from "./directState.js";

async function createCodexStateDatabase(codexHome: string, sql: string) {
  await executeSqliteScript(path.join(codexHome, "state_1.sqlite"), sql);
}

describe("createDirectControlClient", () => {
  it("uses app-server by default and keeps exec as an explicit compatibility mode", () => {
    expect(resolveDirectCodexRunner(undefined)).toBe("app-server");
    expect(resolveDirectCodexRunner("app-server")).toBe("app-server");
    expect(resolveDirectCodexRunner("exec")).toBe("exec");
  });

  it("runs commands directly against the configured local workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "direct-control-"));

    try {
      await writeFile(path.join(workspaceRoot, "README.md"), "hello direct\n", "utf8");
      const client = createDirectControlClient({
        mode: "direct",
        discord: {
          token: "discord-token",
          guildId: "guild-1",
          allowedRoleIds: ["role-operator"],
        },
        direct: {
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          workspaceId: `local-dev:${workspaceRoot}`,
          workspaceRoot,
          workspaceDisplayName: "repo",
          channelId: "channel-1",
          channelMode: "shell-admin",
          timeoutMs: 5_000,
          codexHome: path.join(workspaceRoot, ".codex"),
        },
      });

      await expect(client.getChannelContext("channel-1")).resolves.toMatchObject({
        computerId: "local-dev",
        workspaceRoot,
        cwd: workspaceRoot,
      });
      await expect(
        client.submitCommandJob({
          computerId: "local-dev",
          payload: {
            workspaceRoot,
            cwd: workspaceRoot,
            command: "cat README.md",
            timeoutMs: 5_000,
            confirmedDangerous: false,
          },
        }),
      ).resolves.toMatchObject({
        result: {
          status: "completed",
          stdout: expect.stringMatching(/^hello direct\r?\n$/),
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resolves a configured Claude Code channel separately from the Codex admin channel", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "direct-control-claude-"));
    const claudeCwd = path.join(workspaceRoot, "claude-project");

    try {
      await mkdir(claudeCwd);
      const client = createDirectControlClient({
        mode: "direct",
        discord: {
          token: "discord-token",
          guildId: "guild-1",
          allowedRoleIds: ["role-operator"],
        },
        direct: {
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          workspaceId: `local-dev:${workspaceRoot}`,
          workspaceRoot,
          workspaceDisplayName: "repo",
          channelId: "codex-channel-1",
          claudeChannelId: "claude-channel-1",
          channelMode: "shell-admin",
          timeoutMs: 5_000,
          codexHome: path.join(workspaceRoot, ".codex"),
        },
      });

      await expect(client.getChannelContext("claude-channel-1")).resolves.toMatchObject({
        channelMode: "claude-code",
        agentMain: "claude",
        workspaceRoot,
        cwd: workspaceRoot,
        codexSessionId: null,
      });
      await expect(
        client.updateChannelCwd({
          discordChannelId: "claude-channel-1",
          cwd: claudeCwd,
        }),
      ).resolves.toEqual({ cwd: claudeCwd });
      await expect(client.getChannelContext("claude-channel-1")).resolves.toMatchObject({
        channelMode: "claude-code",
        cwd: claudeCwd,
      });
      await expect(client.getChannelContext("codex-channel-1")).resolves.toMatchObject({
        channelMode: "shell-admin",
        agentMain: "codex",
        cwd: workspaceRoot,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("starts direct commands from an initial cwd inside the configured workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "direct-control-"));
    const initialCwd = path.join(workspaceRoot, "project");

    try {
      await mkdir(initialCwd);
      const client = createDirectControlClient({
        mode: "direct",
        discord: {
          token: "discord-token",
          guildId: "guild-1",
          allowedRoleIds: ["role-operator"],
        },
        direct: {
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          workspaceId: `local-dev:${workspaceRoot}`,
          workspaceRoot,
          initialCwd,
          workspaceDisplayName: "repo",
          channelId: "channel-1",
          channelMode: "shell-admin",
          timeoutMs: 5_000,
          codexHome: path.join(workspaceRoot, ".codex"),
        },
      });
      const context = await client.getChannelContext("channel-1");

      expect(context).toMatchObject({
        computerId: "local-dev",
        workspaceRoot,
        cwd: await realpath(initialCwd),
      });
      await expect(
        client.submitCommandJob({
          computerId: "local-dev",
          payload: {
            workspaceRoot,
            cwd: context?.cwd ?? workspaceRoot,
            command: "cd ..",
            timeoutMs: 5_000,
            confirmedDangerous: false,
          },
        }),
      ).resolves.toMatchObject({
        result: {
          status: "completed",
          cwd: await realpath(workspaceRoot),
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resolves synced Codex session channels from direct state", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "direct-control-state-"));

    try {
      const stateStore = createDirectSyncStateStore(path.join(workspaceRoot, "state.json"));
      await stateStore.write({
        version: 1,
        agentDefaults: {
          codex: { model: "gpt-5.6-sol", effort: "xhigh" },
          claude: { model: "claude-fable-5[1m]", effort: "max" },
        },
        archivedCodexSessionIds: [],
        workspaces: [
          {
            workspaceRoot,
            workspaceDisplayName: "repo",
            discordCategoryId: "category-1",
            computerId: "local-dev",
            workspaceId: `local-dev:${workspaceRoot}`,
          },
        ],
        sessionChannels: [
          {
            codexSessionId: "session-1",
            threadName: "Build bridge",
            updatedAt: "2026-04-23T00:00:00.000Z",
            cwd: workspaceRoot,
            workspaceRoot,
            workspaceDisplayName: "repo",
            discordCategoryId: "category-1",
            discordChannelId: "session-channel-1",
            agentModelOverride: "gpt-5.4",
            agentEffortOverride: "high",
            channelName: "build-bridge",
            computerId: "local-dev",
            workspaceId: `local-dev:${workspaceRoot}`,
          },
          {
            codexSessionId: null,
            threadName: "Claude scratch",
            updatedAt: "2026-04-23T00:00:00.000Z",
            cwd: workspaceRoot,
            workspaceRoot,
            workspaceDisplayName: "repo",
            discordCategoryId: "category-1",
            discordChannelId: "claude-thread-1",
            channelName: "claude-scratch",
            channelMode: "claude-code",
            claudeSessionId: "claude-session-1",
            computerId: "local-dev",
            workspaceId: `local-dev:${workspaceRoot}`,
          },
        ],
      });
      const client = createDirectControlClient(
        {
          mode: "direct",
          discord: {
            token: "discord-token",
            guildId: "guild-1",
            allowedRoleIds: ["role-operator"],
          },
          direct: {
            computerId: "local-dev",
            computerDisplayName: "Local Dev",
            workspaceId: `local-dev:${workspaceRoot}`,
            workspaceRoot,
            workspaceDisplayName: "repo",
            channelId: "admin-channel",
            channelMode: "shell-admin",
            timeoutMs: 5_000,
            codexHome: path.join(workspaceRoot, ".codex"),
          },
        },
        { stateStore },
      );

      await expect(client.getChannelContext("session-channel-1")).resolves.toMatchObject({
        channelMode: "session-linked",
        codexSessionId: "session-1",
        workspaceRoot,
        cwd: workspaceRoot,
        agentDefaults: {
          codex: { model: "gpt-5.6-sol", effort: "xhigh" },
          claude: { model: "claude-fable-5[1m]", effort: "max" },
        },
        agentModelOverride: "gpt-5.4",
        agentEffortOverride: "high",
      });
      await expect(client.getChannelContext("claude-thread-1")).resolves.toMatchObject({
        channelMode: "claude-code",
        codexSessionId: null,
        claudeSessionId: "claude-session-1",
        workspaceRoot,
        cwd: workspaceRoot,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("can include linked exec Codex sessions for realtime transcript sync", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "direct-control-codex-"));
    const codexHome = path.join(workspaceRoot, ".codex");
    const sessionId = "019dbcc5-5d37-7662-9b8e-d9f1eb824fc2";

    try {
      await mkdir(path.join(codexHome, "sessions", "2026", "04", "24"), { recursive: true });
      await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        `${JSON.stringify({
          id: sessionId,
          thread_name: "Discord-created exec session",
          updated_at: "2026-04-24T01:00:00.000Z",
        })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(codexHome, "sessions", "2026", "04", "24", `rollout-${sessionId}.jsonl`),
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId, cwd: workspaceRoot },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: "Discord에서 시작한 질문",
            },
          }),
        ].join("\n"),
        "utf8",
      );
      await createCodexStateDatabase(
        codexHome,
        [
          "create table threads (id text primary key, archived integer, source text);",
          "create table thread_spawn_edges (child_thread_id text);",
          `insert into threads values ('${sessionId}', 0, 'exec');`,
        ].join("\n"),
      );

      const client = createDirectControlClient({
        mode: "direct",
        discord: {
          token: "discord-token",
          guildId: "guild-1",
          allowedRoleIds: ["role-operator"],
        },
        direct: {
          computerId: "local-dev",
          computerDisplayName: "Local Dev",
          workspaceId: `local-dev:${workspaceRoot}`,
          workspaceRoot,
          workspaceDisplayName: "repo",
          channelId: "channel-1",
          channelMode: "shell-admin",
          timeoutMs: 5_000,
          codexHome,
        },
      });

      await expect(
        client.listCodexSessions({
          computerId: "local-dev",
          codexHome,
        }),
      ).resolves.toMatchObject({
        result: [],
      });
      await expect(
        client.listCodexSessions({
          computerId: "local-dev",
          codexHome,
          activeOnly: false,
          includeExecSessions: true,
        }),
      ).resolves.toMatchObject({
        result: [
          expect.objectContaining({
            id: sessionId,
            threadName: "Discord-created exec session",
          }),
        ],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
