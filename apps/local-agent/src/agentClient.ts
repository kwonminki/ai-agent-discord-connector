import WebSocket from "ws";
import { listNativeCodexSessions } from "./codexAdapter.js";
import { runClaudePrompt, type ClaudeRunnerProgressEvent } from "./claudeRunner.js";
import { runCodexPrompt, type CodexRunnerProgressEvent } from "./codexRunner.js";
import { runWorkspaceCommand } from "./runner.js";

export interface AgentConfig {
  computerId: string;
  displayName: string;
  hostname?: string;
  allowedRoleIds?: string[];
  capabilities: string[];
  workspaces?: Array<{
    id: string;
    absolutePath: string;
    displayName: string;
  }>;
}

export interface AgentJob {
  jobId: string;
  type: string;
  payload: unknown;
}

interface AgentJobOptions {
  onProgress?: (event: CodexRunnerProgressEvent | ClaudeRunnerProgressEvent) => Promise<void> | void;
}

interface ParsedAgentJob extends AgentJob {
  jobId: string;
}

export function createAgentHelloMessage(config: AgentConfig) {
  return {
    type: "agent-hello",
    computerId: config.computerId,
    displayName: config.displayName,
    hostname: config.hostname,
    allowedRoleIds: config.allowedRoleIds ?? [],
    capabilities: config.capabilities,
    workspaces: config.workspaces ?? [],
  };
}

export async function handleAgentJob(job: AgentJob, options: AgentJobOptions = {}) {
  if (job.type === "run-command") {
    return runWorkspaceCommand(job.payload as Parameters<typeof runWorkspaceCommand>[0]);
  }

  if (job.type === "list-codex-sessions") {
    const payload = job.payload as {
      codexHome: string;
      activeOnly?: boolean;
      includeExecSessions?: boolean;
      includeSessionIds?: string[];
    };
    return listNativeCodexSessions(payload.codexHome, {
      activeOnly: payload.activeOnly,
      includeExecSessions: payload.includeExecSessions,
      includeSessionIds: payload.includeSessionIds,
    });
  }

  if (job.type === "run-codex-prompt") {
    const payload = job.payload as Parameters<typeof runCodexPrompt>[0];

    if (payload.forkSession) {
      return {
        status: "failed",
        finalMessage: "Codex session fork requires the direct app-server runner.",
        sessionId: payload.sessionId ?? null,
        stderr: "",
        exitCode: null,
        errorCode: "CODEX_FORK_APP_SERVER_REQUIRED",
      };
    }

    return runCodexPrompt({
      ...payload,
      onProgress: options.onProgress,
    });
  }

  if (job.type === "run-claude-prompt") {
    return runClaudePrompt({
      ...(job.payload as Parameters<typeof runClaudePrompt>[0]),
      onProgress: options.onProgress,
    });
  }

  throw new Error("Unsupported agent job type");
}

function parseAgentJob(raw: WebSocket.RawData): ParsedAgentJob | null {
  try {
    const parsed = JSON.parse(raw.toString()) as Partial<AgentJob>;

    if (typeof parsed.jobId !== "string" || typeof parsed.type !== "string") {
      return null;
    }

    return {
      jobId: parsed.jobId,
      type: parsed.type,
      payload: parsed.payload,
    };
  } catch (error) {
    console.error("local-agent received invalid job payload", error);
    return null;
  }
}

function sendJobResult(socket: WebSocket, jobId: string, result: unknown) {
  socket.send(JSON.stringify({ type: "agent-job-result", jobId, result }));
}

function sendJobProgress(socket: WebSocket, jobId: string, event: CodexRunnerProgressEvent | ClaudeRunnerProgressEvent) {
  socket.send(JSON.stringify({ type: "agent-job-progress", jobId, event }));
}

function sendJobError(socket: WebSocket, jobId: string, error: Error) {
  socket.send(JSON.stringify({ type: "agent-job-result", jobId, error: { message: error.message } }));
}

export function connectAgent(wsUrl: string, config: AgentConfig) {
  const socket = new WebSocket(wsUrl);

  socket.on("open", () => {
    socket.send(JSON.stringify(createAgentHelloMessage(config)));
  });

  socket.on("message", (raw) => {
    void (async () => {
      const job = parseAgentJob(raw);

      if (!job) {
        return;
      }

      try {
        const result = await handleAgentJob(job, {
          onProgress: async (event) => {
            sendJobProgress(socket, job.jobId, event);
          },
        });
        sendJobResult(socket, job.jobId, result);
      } catch (error) {
        const jobError = error instanceof Error ? error : new Error("Unknown agent job failure");
        sendJobError(socket, job.jobId, jobError);
      }
    })().catch((error) => {
      console.error("local-agent failed to handle websocket message", error);
    });
  });

  return socket;
}
