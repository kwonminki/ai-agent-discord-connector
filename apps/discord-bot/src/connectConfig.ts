import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChannelMode,
  ConnectorLocale,
} from "../../../packages/core/src/index.js";

export interface DirectConnectConfig {
  mode: "direct";
  discord: {
    token: string;
    guildId: string;
    allowedRoleIds: string[];
    locale?: ConnectorLocale;
  };
  direct: {
    hostInstallationId?: string;
    computerId: string;
    computerDisplayName: string;
    workspaceId: string;
    workspaceRoot: string;
    initialCwd?: string;
    workspaceDisplayName: string;
    channelId: string;
    claudeChannelId?: string;
    channelMode: ChannelMode;
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
  discord: {
    token: string;
    guildId: string;
    allowedRoleIds: string[];
    locale?: ConnectorLocale;
  };
  hub: {
    controlApiUrl: string;
    controlWsUrl: string;
  };
}

export type ConnectConfig = DirectConnectConfig | HubConnectConfig;

export function resolveConnectConfigPath(): string {
  return path.resolve(process.env.CONNECT_CONFIG_PATH ?? ".connect/config.json");
}

export async function loadConnectConfig(configPath = resolveConnectConfigPath()): Promise<ConnectConfig | null> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as ConnectConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // JSON.parse errors can quote credential-bearing source text.
      throw new Error("Invalid connector configuration JSON. Check the file selected by CONNECT_CONFIG_PATH.");
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
