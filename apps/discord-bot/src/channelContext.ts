import type { ChannelMode } from "../../../packages/core/src/index.js";
import type { AgentDefaultSettings, AgentEffort, AgentKind } from "./agentSettings.js";
import type { DiscordSessionDeliveryMode, DiscordSessionChannelPurpose } from "./directState.js";

export interface ManagedDiscordChannelContext {
  channelMode: ChannelMode;
  channelPurpose?: DiscordSessionChannelPurpose | null;
  subagent?: import("../../../packages/codex-adapter/src/parser.js").CodexSubagent;
  redirectChannelId?: string;
  allowedRoleIds: string[];
  computerId: string;
  computerDisplayName: string;
  workspaceDisplayName: string;
  workspaceRoot: string;
  cwd: string;
  timeoutMs: number;
  codexSessionId?: string | null;
  claudeSessionId?: string | null;
  discordDeliveryMode?: DiscordSessionDeliveryMode;
  discordParentChannelId?: string | null;
  agentMain?: AgentKind | null;
  agentDefaults?: AgentDefaultSettings | null;
  agentModelOverride?: string | null;
  agentEffortOverride?: AgentEffort | null;
}
