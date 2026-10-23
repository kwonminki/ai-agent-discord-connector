import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveConnectorLocale,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";

export type ConnectMode = "direct" | "hub";

export interface DiscordConfig {
  token: string;
  guildId: string;
  allowedRoleIds: string[];
  locale: ConnectorLocale;
}

export interface DirectConnectConfig {
  mode: "direct";
  discord: DiscordConfig;
  direct: {
    computerId: string;
    /** Present only for a host prepared and provisioned by the noninteractive host commands. */
    hostInstallationId?: string;
    computerDisplayName: string;
    workspaceId: string;
    workspaceRoot: string;
    initialCwd?: string;
    workspaceDisplayName: string;
    channelId: string;
    claudeChannelId?: string;
    channelMode: "shell-admin" | "session-linked";
    timeoutMs: number;
    codexHome: string;
    maintenanceAgent?: "codex" | "claude";
    orca?: { command?: string; enabled?: boolean };
    relay?: {
      trustedBotUserIds: string[];
      controlChannelId: string;
    };
  };
}

export interface HubConnectConfig {
  mode: "hub";
  discord: DiscordConfig;
  hub: {
    controlApiUrl: string;
    controlWsUrl: string;
  };
}

export type ConnectConfig = DirectConnectConfig | HubConnectConfig;

export interface BuildDirectConfigInput {
  token: string;
  guildId: string;
  channelId: string;
  claudeChannelId?: string;
  roleIds: string | string[];
  workspaceRoot: string;
  initialCwd?: string;
  workspaceDisplayName?: string;
  computerId?: string;
  computerDisplayName?: string;
  codexHome?: string;
  timeoutMs?: number;
  locale?: string;
  maintenanceAgent?: string;
  orcaCommand?: string;
}

export interface BuildHubConfigInput {
  token: string;
  guildId: string;
  roleIds: string | string[];
  controlApiUrl?: string;
  controlWsUrl?: string;
  locale?: string;
}

export function parseRoleIds(roleIds: string | string[]): string[] {
  const rawRoleIds = Array.isArray(roleIds) ? roleIds : roleIds.split(",");
  return rawRoleIds.map((roleId) => roleId.trim()).filter((roleId) => roleId.length > 0);
}

export function buildDirectConfig(input: BuildDirectConfigInput): DirectConnectConfig {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const initialCwd = input.initialCwd ? path.resolve(input.initialCwd) : undefined;
  const computerId = input.computerId ?? "local-dev";
  const channelId = input.channelId.trim();
  const claudeChannelId = input.claudeChannelId?.trim();

  if (claudeChannelId && claudeChannelId === channelId) {
    throw new Error("AI agent/admin channel ID and Claude Code channel ID must be different.");
  }
  const requestedMaintenanceAgent = input.maintenanceAgent?.trim().toLowerCase();
  if (
    requestedMaintenanceAgent &&
    requestedMaintenanceAgent !== "codex" &&
    requestedMaintenanceAgent !== "claude"
  ) {
    throw new Error("Maintenance agent must be codex or claude.");
  }
  const maintenanceAgent =
    requestedMaintenanceAgent === "claude"
      ? "claude"
      : requestedMaintenanceAgent === "codex"
        ? "codex"
        : undefined;
  if (maintenanceAgent === "claude" && !claudeChannelId) {
    throw new Error("Claude maintenance requires a Claude Code channel ID.");
  }

  return {
    mode: "direct",
    discord: {
      token: input.token,
      guildId: input.guildId,
      allowedRoleIds: parseRoleIds(input.roleIds),
      locale: resolveConnectorLocale(input.locale),
    },
    direct: {
      computerId,
      computerDisplayName: input.computerDisplayName ?? "Local Dev",
      workspaceId: `${computerId}:${workspaceRoot}`,
      workspaceRoot,
      ...(initialCwd ? { initialCwd } : {}),
      workspaceDisplayName: input.workspaceDisplayName ?? path.basename(workspaceRoot),
      channelId,
      ...(claudeChannelId ? { claudeChannelId } : {}),
      channelMode: "shell-admin",
      timeoutMs: input.timeoutMs ?? 30_000,
      codexHome: input.codexHome ?? path.join(os.homedir(), ".codex"),
      ...(maintenanceAgent ? { maintenanceAgent } : {}),
      ...(input.orcaCommand?.trim() ? { orca: { command: input.orcaCommand.trim() } } : {}),
    },
  };
}

export function buildHubConfig(input: BuildHubConfigInput): HubConnectConfig {
  return {
    mode: "hub",
    discord: {
      token: input.token,
      guildId: input.guildId,
      allowedRoleIds: parseRoleIds(input.roleIds),
      locale: resolveConnectorLocale(input.locale),
    },
    hub: {
      controlApiUrl: input.controlApiUrl ?? "http://127.0.0.1:4317",
      controlWsUrl: input.controlWsUrl ?? "ws://127.0.0.1:4317/agents",
    },
  };
}

export function renderEnvFile(config: ConnectConfig): string {
  const lines = [
    'DATABASE_URL="file:./dev.sqlite"',
    `CONNECT_MODE="${config.mode}"`,
    'CONNECT_CONFIG_PATH=".connect/config.json"',
    'CONNECT_STATE_PATH=".connect/state.json"',
    `DISCORD_TOKEN="${config.discord.token}"`,
    `DISCORD_GUILD_ID="${config.discord.guildId}"`,
    `DISCORD_ALLOWED_ROLE_IDS="${config.discord.allowedRoleIds.join(",")}"`,
    `CONNECT_LOCALE="${config.discord.locale}"`,
  ];

  if (config.mode === "hub") {
    lines.push(`CONTROL_API_URL="${config.hub.controlApiUrl}"`);
    lines.push(`CONTROL_WS_URL="${config.hub.controlWsUrl}"`);
  } else {
    lines.push(`AGENT_COMPUTER_ID="${config.direct.computerId}"`);
    lines.push(`AGENT_DISPLAY_NAME="${config.direct.computerDisplayName}"`);
    lines.push(`AGENT_WORKSPACE_ROOT="${config.direct.workspaceRoot}"`);
    lines.push(`AGENT_WORKSPACE_DISPLAY_NAME="${config.direct.workspaceDisplayName}"`);
    if (config.direct.claudeChannelId) {
      lines.push(`CLAUDE_CHANNEL_ID="${config.direct.claudeChannelId}"`);
    }
    lines.push(`CONNECT_MAINTENANCE_AGENT="${config.direct.maintenanceAgent ?? "codex"}"`);
    lines.push(`CODEX_HOME="${config.direct.codexHome}"`);
  }

  return `${lines.join("\n")}\n`;
}

export async function writeSetupFiles(input: { cwd: string; config: ConnectConfig }): Promise<void> {
  const connectDirectory = path.join(input.cwd, ".connect");
  const configPath = path.join(connectDirectory, "config.json");
  const environmentPath = path.join(input.cwd, ".env");
  await mkdir(connectDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(connectDirectory, 0o700);
  }
  await writeFile(
    configPath,
    `${JSON.stringify(input.config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(configPath, 0o600);
  }
  await writeFile(
    environmentPath,
    renderEnvFile(input.config),
    { encoding: "utf8", mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(environmentPath, 0o600);
  }
}
