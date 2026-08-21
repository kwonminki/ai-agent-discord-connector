import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDirectConfig,
  buildHubConfig,
  renderEnvFile,
  writeSetupFiles,
} from "./config.js";
import {
  BOT_RELOAD_EXIT_CODE,
  buildManagedProcessEnv,
  buildManagedProcessCommands,
  discordSetupGuide,
  shouldRestartManagedProcess,
} from "./index.js";

const repoRoot = path.resolve("/repo");
const operatorRoot = path.resolve("/operator/project");

describe("connect setup config", () => {
  it("builds direct mode config with minimal operator inputs", () => {
    const config = buildDirectConfig({
      token: "discord-token",
      guildId: "guild-1",
      channelId: "channel-1",
      claudeChannelId: "claude-channel-1",
      roleIds: "role-operator, role-admin",
      workspaceRoot: repoRoot,
      workspaceDisplayName: "repo",
      computerId: "local-dev",
      computerDisplayName: "Local Dev",
      codexHome: "/Users/me/.codex",
    });

    expect(config).toEqual({
      mode: "direct",
      discord: {
        token: "discord-token",
        guildId: "guild-1",
        allowedRoleIds: ["role-operator", "role-admin"],
        locale: "ko",
      },
      direct: {
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        workspaceId: `local-dev:${repoRoot}`,
        workspaceRoot: repoRoot,
        workspaceDisplayName: "repo",
        channelId: "channel-1",
        claudeChannelId: "claude-channel-1",
        channelMode: "shell-admin",
        timeoutMs: 30_000,
        codexHome: "/Users/me/.codex",
      },
    });
    expect(renderEnvFile(config)).toContain('CLAUDE_CHANNEL_ID="claude-channel-1"');
    expect(renderEnvFile(config)).toContain('CONNECT_MAINTENANCE_AGENT="codex"');
    expect(renderEnvFile(config)).toContain('CONNECT_LOCALE="ko"');
  });

  it("can keep the direct workspace root broader than the initial cwd", () => {
    const config = buildDirectConfig({
      token: "discord-token",
      guildId: "guild-1",
      channelId: "channel-1",
      roleIds: "role-operator",
      workspaceRoot: repoRoot,
      initialCwd: path.join(repoRoot, "apps", "web"),
    });

    expect(config.direct).toMatchObject({
      workspaceId: `local-dev:${repoRoot}`,
      workspaceRoot: repoRoot,
      initialCwd: path.join(repoRoot, "apps", "web"),
      workspaceDisplayName: "repo",
    });
  });

  it("describes where every Discord setup value comes from", () => {
    const guide = discordSetupGuide("direct").join("\n");

    expect(guide).toContain("Developer Portal");
    expect(guide).toContain("Server/Guild ID");
    expect(guide).toContain("Operator role ID");
    expect(guide).toContain("AI agent/admin channel ID");
    expect(guide).toContain("Claude Code channel ID");
    expect(guide).toContain("Public Key와 OAuth2 Client ID는 connector 설정에 넣지 않습니다");
  });

  it("builds English config and setup guidance", () => {
    const config = buildDirectConfig({
      token: "discord-token",
      guildId: "guild-1",
      channelId: "channel-1",
      roleIds: "role-operator",
      workspaceRoot: repoRoot,
      locale: "english",
    });

    expect(config.discord.locale).toBe("en");
    expect(discordSetupGuide("direct", "en").join("\n")).toContain(
      "Public Key and OAuth2 Client ID are not connector settings",
    );
  });

  it("rejects using the same Discord channel for agent admin and Claude Code", () => {
    expect(() => buildDirectConfig({
      token: "discord-token",
      guildId: "guild-1",
      channelId: "shared-channel",
      claudeChannelId: "shared-channel",
      roleIds: "role-operator",
      workspaceRoot: repoRoot,
    })).toThrow("AI agent/admin channel ID and Claude Code channel ID must be different.");
  });

  it("allows Claude Code to be the single maintenance agent when its channel exists", () => {
    const config = buildDirectConfig({
      token: "discord-token",
      guildId: "guild-1",
      channelId: "channel-1",
      claudeChannelId: "claude-channel-1",
      roleIds: "role-operator",
      workspaceRoot: repoRoot,
      maintenanceAgent: "claude",
    });

    expect(config.direct.maintenanceAgent).toBe("claude");
    expect(renderEnvFile(config)).toContain('CONNECT_MAINTENANCE_AGENT="claude"');
  });

  it("rejects Claude maintenance without a Claude Code channel", () => {
    expect(() => buildDirectConfig({
      token: "discord-token",
      guildId: "guild-1",
      channelId: "channel-1",
      roleIds: "role-operator",
      workspaceRoot: repoRoot,
      maintenanceAgent: "claude",
    })).toThrow("Claude maintenance requires a Claude Code channel ID.");
  });

  it("writes generated config and env files", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "connect-cli-"));

    try {
      const config = buildHubConfig({
        token: "discord-token",
        guildId: "guild-1",
        roleIds: "role-operator",
        controlApiUrl: "http://127.0.0.1:4317",
        controlWsUrl: "ws://127.0.0.1:4317/agents",
      });

      await writeSetupFiles({ cwd: tempRoot, config });

      await expect(readFile(path.join(tempRoot, ".connect", "config.json"), "utf8")).resolves.toContain(
        '"mode": "hub"',
      );
      await expect(readFile(path.join(tempRoot, ".env"), "utf8")).resolves.toBe(renderEnvFile(config));
      if (process.platform !== "win32") {
        await expect(
          stat(path.join(tempRoot, ".connect")).then((value) => value.mode & 0o777),
        ).resolves.toBe(0o700);
        await expect(
          stat(path.join(tempRoot, ".connect", "config.json")).then((value) => value.mode & 0o777),
        ).resolves.toBe(0o600);
        await expect(
          stat(path.join(tempRoot, ".env")).then((value) => value.mode & 0o777),
        ).resolves.toBe(0o600);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("restarts only the Discord bot when it exits with the reload code", () => {
    expect(
      shouldRestartManagedProcess({
        script: "dev:bot",
        code: BOT_RELOAD_EXIT_CODE,
      }),
    ).toBe(true);
    expect(
      shouldRestartManagedProcess({
        script: "dev:agent",
        code: BOT_RELOAD_EXIT_CODE,
      }),
    ).toBe(false);
    expect(
      shouldRestartManagedProcess({
        script: "dev:bot",
        code: 1,
        mode: "hub",
      }),
    ).toBe(false);
    expect(
      shouldRestartManagedProcess({
        script: "dev:bot",
        code: 1,
        mode: "direct",
      }),
    ).toBe(true);
    expect(
      shouldRestartManagedProcess({
        script: "direct-worker",
        code: 1,
        mode: "direct",
      }),
    ).toBe(true);
  });

  it("builds package-local process commands for installed CLI execution", () => {
    expect(buildManagedProcessCommands("direct")).toEqual([
      ["node", ["--import", "tsx", "apps/local-agent/src/directWorker.ts"], "direct-worker"],
      ["node", ["--import", "tsx", "apps/discord-bot/src/index.ts"], "dev:bot"],
    ]);
    expect(buildManagedProcessCommands("hub")).toEqual([
      ["node", ["--import", "tsx", "apps/control-api/src/index.ts"], "dev:control"],
      ["node", ["--import", "tsx", "apps/local-agent/src/index.ts"], "dev:agent"],
      ["node", ["--import", "tsx", "apps/discord-bot/src/index.ts"], "dev:bot"],
    ]);
    expect(buildManagedProcessCommands("direct", "worker")).toEqual([
      ["node", ["--import", "tsx", "apps/local-agent/src/directWorker.ts"], "direct-worker"],
    ]);
    expect(buildManagedProcessCommands("direct", "bot")).toEqual([
      ["node", ["--import", "tsx", "apps/discord-bot/src/index.ts"], "dev:bot"],
    ]);
    expect(buildManagedProcessCommands("direct", "relay")).toEqual([
      ["node", ["--import", "tsx", "apps/relay-bot/src/index.ts"], "dev:relay"],
    ]);
  });

  it("keeps operator config and state paths rooted in the launch directory", () => {
    expect(buildManagedProcessEnv("direct", operatorRoot, { EXISTING: "1" })).toMatchObject({
      EXISTING: "1",
      CONNECT_MODE: "direct",
      CONNECT_CONFIG_PATH: path.join(operatorRoot, ".connect", "config.json"),
      CONNECT_STATE_PATH: path.join(operatorRoot, ".connect", "state.json"),
      CONNECT_WORKER_ROOT: path.join(operatorRoot, ".connect", "worker"),
      CONNECT_DISCORD_QUEUE_ROOT: path.join(operatorRoot, ".connect", "discord-queue"),
    });
  });
});
