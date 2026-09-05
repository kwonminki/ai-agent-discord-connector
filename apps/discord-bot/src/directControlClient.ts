import { randomUUID } from "node:crypto";
import { discoverCodexSessions } from "../../../packages/codex-adapter/src/index.js";
import {
  interruptActiveClaudeTurn,
  runClaudePrompt,
  steerActiveClaudeTurn,
} from "../../local-agent/src/claudeRunner.js";
import {
  interruptActiveCodexAppServerTurn,
  runCodexAppServerPrompt,
  steerActiveCodexAppServerTurn,
} from "../../local-agent/src/codexAppServerRunner.js";
import { runCodexPrompt } from "../../local-agent/src/codexRunner.js";
import { runWorkspaceCommand } from "../../local-agent/src/runner.js";
import { assertInsideWorkspace } from "../../local-agent/src/workspace.js";
import type { ControlApiClient } from "./controlApiClient.js";
import type { DirectConnectConfig } from "./connectConfig.js";
import type { DirectSyncStateStore } from "./directState.js";
import type { DirectWorkerClient } from "./directWorkerClient.js";

export function resolveDirectCodexRunner(
  configuredValue = process.env.CODEX_DISCORD_CODEX_RUNNER,
): "app-server" | "exec" {
  return configuredValue === "exec" ? "exec" : "app-server";
}

export function createDirectControlClient(
  config: DirectConnectConfig,
  options: { stateStore?: DirectSyncStateStore; workerClient?: DirectWorkerClient | null } = {},
): ControlApiClient {
  const codexRunner = resolveDirectCodexRunner();
  const claudeChannelId = config.direct.claudeChannelId?.trim() || null;
  let cwd = config.direct.initialCwd
    ? assertInsideWorkspace(config.direct.workspaceRoot, config.direct.initialCwd)
    : config.direct.workspaceRoot;
  let claudeCwd = cwd;
  const sessionLinks = new Map<string, {
    id: string;
    channelId: string;
    codexSessionId: string;
    origin: "managed_new" | "imported_native";
    threadNameSnapshot: string;
    availabilityStatus: string;
  }>();

  return {
    async listInventory() {
      return [
        {
          id: config.direct.computerId,
          displayName: config.direct.computerDisplayName,
          hostname: config.direct.computerId,
          status: "online",
          allowedRoleIds: [...config.discord.allowedRoleIds],
          capabilities: ["shell", "codex-import", "codex-chat", "claude-code"],
          workspaces: [
            {
              id: config.direct.workspaceId,
              absolutePath: config.direct.workspaceRoot,
              displayName: config.direct.workspaceDisplayName,
              status: "valid",
            },
          ],
        },
      ];
    },
    async getChannelContext(discordChannelId) {
      const state = await options.stateStore?.read();
      const agentDefaults = state?.agentDefaults;

      if (discordChannelId === config.direct.channelId) {
        return {
          channelMode: config.direct.channelMode,
          allowedRoleIds: [...config.discord.allowedRoleIds],
          computerId: config.direct.computerId,
          computerDisplayName: config.direct.computerDisplayName,
          workspaceDisplayName: config.direct.workspaceDisplayName,
          workspaceRoot: config.direct.workspaceRoot,
          cwd,
          timeoutMs: config.direct.timeoutMs,
          codexSessionId: null,
          discordDeliveryMode: "channel",
          discordParentChannelId: null,
          agentMain: "codex",
          agentDefaults,
        };
      }

      if (claudeChannelId && discordChannelId === claudeChannelId) {
        return {
          channelMode: "claude-code",
          allowedRoleIds: [...config.discord.allowedRoleIds],
          computerId: config.direct.computerId,
          computerDisplayName: config.direct.computerDisplayName,
          workspaceDisplayName: config.direct.workspaceDisplayName,
          workspaceRoot: config.direct.workspaceRoot,
          cwd: claudeCwd,
          timeoutMs: config.direct.timeoutMs,
          codexSessionId: null,
          discordDeliveryMode: "channel",
          discordParentChannelId: null,
          agentMain: "claude",
          agentDefaults,
        };
      }

      const syncedChannel = state?.sessionChannels.find(
        (channel) => channel.discordChannelId === discordChannelId,
      ) ?? null;

      if (!syncedChannel) {
        return null;
      }

      const syncedChannelMode = syncedChannel.channelMode ?? "session-linked";

      return {
        channelMode: syncedChannelMode,
        allowedRoleIds: [...config.discord.allowedRoleIds],
        computerId: syncedChannel.computerId,
        computerDisplayName: config.direct.computerDisplayName,
        workspaceDisplayName: syncedChannel.workspaceDisplayName,
        workspaceRoot: syncedChannel.workspaceRoot,
        cwd: syncedChannel.cwd,
        timeoutMs: config.direct.timeoutMs,
        codexSessionId: syncedChannel.codexSessionId,
        claudeSessionId: syncedChannel.claudeSessionId ?? null,
        discordDeliveryMode: syncedChannel.discordDeliveryMode ?? "channel",
        discordParentChannelId: syncedChannel.discordParentChannelId ?? null,
        agentMain: null,
        agentDefaults,
        agentModelOverride: syncedChannel.agentModelOverride ?? null,
        agentEffortOverride: syncedChannel.agentEffortOverride ?? null,
      };
    },
    async createCategoryMapping(input) {
      return {
        id: input.id,
        discordCategoryId: input.discordCategoryId,
        computerId: input.computerId,
        workspaceId: input.workspaceId,
        syncStatus: "direct",
      };
    },
    async createManagedChannel(input) {
      return {
        id: input.id,
        discordChannelId: input.discordChannelId,
        computerId: input.computerId,
        workspaceId: input.workspaceId,
        channelMode: input.channelMode,
        cwd,
        status: "direct",
      };
    },
    async updateChannelCwd(input) {
      let updatedCwd = input.cwd;

      if (input.discordChannelId === config.direct.channelId) {
        cwd = input.cwd;
        updatedCwd = cwd;
      }

      if (claudeChannelId && input.discordChannelId === claudeChannelId) {
        claudeCwd = input.cwd;
        updatedCwd = claudeCwd;
      }

      await options.stateStore?.updateChannelCwd(input.discordChannelId, input.cwd);

      return { cwd: updatedCwd };
    },
    async recordCommandAudit(input) {
      return {
        id: randomUUID(),
        channelId: input.discordChannelId,
        userId: input.userId,
        targetComputerId: config.direct.computerId,
        targetWorkspaceId: config.direct.workspaceId,
        cwd: input.cwd,
        rawCommand: input.rawCommand,
        tier: input.tier,
        resultStatus: input.resultStatus,
      };
    },
    async linkCodexSession(input) {
      const link = {
        id: input.id,
        channelId: input.discordChannelId,
        codexSessionId: input.codexSessionId,
        origin: input.origin,
        threadNameSnapshot: input.threadNameSnapshot,
        availabilityStatus: "available",
      };
      sessionLinks.set(input.discordChannelId, link);
      return link;
    },
    async listCodexSessions(input) {
      if (input.computerId !== config.direct.computerId) {
        return { jobId: randomUUID(), error: { message: "Computer is offline" } };
      }

      return {
        jobId: randomUUID(),
        result: await discoverCodexSessions(input.codexHome, {
          activeOnly: input.activeOnly ?? true,
          includeExecSessions: input.includeExecSessions ?? false,
          includeSessionIds: input.includeSessionIds,
          includeContextPreview: true,
          includeRealtimeEvents: true,
          contextMessageLimit: 25,
          contextMessageMaxChars: 8_000,
          realtimeEventLimit: 200,
        }),
      };
    },
    async submitCommandJob(input) {
      if (input.computerId !== config.direct.computerId) {
        return { jobId: randomUUID(), error: { message: "Computer is offline" } };
      }

      if (options.workerClient) {
        const response = await options.workerClient.submit({
          jobId: input.requestId,
          type: "run-command",
          queueKey: input.queueKey ?? input.requestId ?? randomUUID(),
          payload: input.payload,
        });
        if (!input.requestId) {
          await options.workerClient.markDelivered(response.jobId);
        }
        return "error" in response
          ? { jobId: response.jobId, error: response.error }
          : { jobId: response.jobId, result: response.result };
      }

      const result = await runWorkspaceCommand(input.payload);
      return { jobId: randomUUID(), result };
    },
    async submitCodexPrompt(input) {
      if (input.computerId !== config.direct.computerId) {
        return { jobId: randomUUID(), error: { message: "Computer is offline" } };
      }

      const runnerInput = {
        ...input.payload,
        codexHome: config.direct.codexHome,
        onProgress: input.onProgress,
        onApprovalRequest: input.onApprovalRequest,
        onUserInputRequest: input.onUserInputRequest,
      };
      if (input.payload.harness && !options.workerClient) {
        return {
          jobId: randomUUID(),
          error: { message: "Harness execution requires the isolated direct worker." },
        };
      }
      if (input.payload.forkSession && codexRunner !== "app-server") {
        return {
          jobId: randomUUID(),
          result: {
            status: "failed",
            finalMessage: "Codex session fork requires CODEX_DISCORD_CODEX_RUNNER=app-server.",
            sessionId: input.payload.sessionId,
            stderr: "",
            exitCode: null,
            errorCode: "CODEX_FORK_APP_SERVER_REQUIRED",
          },
        };
      }
      if (options.workerClient) {
        const response = await options.workerClient.submit({
          jobId: input.requestId,
          type: "run-codex-prompt",
          queueKey: input.queueKey ?? input.payload.controlKey ?? input.requestId ?? randomUUID(),
          payload: {
            runner: codexRunner,
            input: {
              ...input.payload,
              codexHome: config.direct.codexHome,
            },
          },
          onProgress: input.onProgress,
          onApprovalRequest: input.onApprovalRequest,
          onUserInputRequest: input.onUserInputRequest,
        });
        if (!input.requestId) {
          await options.workerClient.markDelivered(response.jobId);
        }
        return "error" in response
          ? { jobId: response.jobId, error: response.error }
          : { jobId: response.jobId, result: response.result };
      }
      const result =
        codexRunner === "app-server" && input.payload.mode !== "review"
          ? await runCodexAppServerPrompt(runnerInput)
          : await runCodexPrompt(runnerInput);
      return { jobId: randomUUID(), result };
    },
    async controlCodexTurn(input) {
      if (input.computerId !== config.direct.computerId) {
        return {
          status: "failed",
          message: "Computer is offline",
        };
      }

      if (options.workerClient) {
        const workerResult = await options.workerClient.control({
          controlKey: input.controlKey,
          action: input.action,
          content: input.content,
        });
        if (workerResult.status !== "no-active-turn") {
          return workerResult;
        }
      } else {
        const claudeResult = input.action === "steer"
          ? await steerActiveClaudeTurn(input.controlKey, input.content ?? "")
          : interruptActiveClaudeTurn(input.controlKey);
        if (claudeResult.status !== "no-active-turn") {
          return claudeResult;
        }
      }

      if (codexRunner !== "app-server") {
        return {
          status: "unsupported",
          message: "Codex steering requires CODEX_DISCORD_CODEX_RUNNER=app-server.",
        };
      }

      return input.action === "steer"
        ? steerActiveCodexAppServerTurn(input.controlKey, input.content ?? "")
        : interruptActiveCodexAppServerTurn(input.controlKey);
    },
    async submitClaudePrompt(input) {
      if (input.computerId !== config.direct.computerId) {
        return { jobId: randomUUID(), error: { message: "Computer is offline" } };
      }

      if (input.payload.harness && !options.workerClient) {
        return {
          jobId: randomUUID(),
          error: { message: "Harness execution requires the isolated direct worker." },
        };
      }

      if (options.workerClient) {
        const response = await options.workerClient.submit({
          jobId: input.requestId,
          type: "run-claude-prompt",
          queueKey: input.queueKey ?? input.requestId ?? randomUUID(),
          payload: input.payload,
          onProgress: input.onProgress,
        });
        if (!input.requestId) {
          await options.workerClient.markDelivered(response.jobId);
        }
        return "error" in response
          ? { jobId: response.jobId, error: response.error }
          : { jobId: response.jobId, result: response.result };
      }

      const result = await runClaudePrompt({
        ...input.payload,
        onProgress: input.onProgress,
      });
      return { jobId: randomUUID(), result };
    },
  };
}
