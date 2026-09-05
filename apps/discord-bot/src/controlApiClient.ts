import type {
  ChannelMode,
  CommandTier,
  HarnessWorkerBinding,
  SessionOrigin,
} from "../../../packages/core/src/index.js";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from "../../local-agent/src/codexRunner.js";
import type { ManagedDiscordChannelContext } from "./channelContext.js";

export interface RunCommandJobPayload {
  workspaceRoot: string;
  cwd: string;
  command: string;
  timeoutMs: number;
  confirmedDangerous: boolean;
}

export interface RunCodexPromptJobPayload {
  workspaceRoot: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  sessionId: string | null;
  forkSession?: boolean;
  sessionName?: string | null;
  mode?: "prompt" | "review";
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null;
  controlKey?: string;
  harnessBuilder?: boolean;
  harness?: HarnessWorkerBinding;
}

export interface CodexTurnControlResult {
  status: "accepted" | "no-active-turn" | "unsupported" | "failed";
  message: string;
  threadId?: string;
  turnId?: string;
}

export interface ControlCodexTurnInput {
  computerId: string;
  controlKey: string;
  action: "steer" | "interrupt";
  content?: string;
}

export interface RunClaudePromptJobPayload {
  workspaceRoot: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  controlKey?: string;
  sessionId: string | null;
  forkSession?: boolean;
  sessionName?: string | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  harnessBuilder?: boolean;
  harness?: HarnessWorkerBinding;
}

export type SharedAgentPromptProgressEvent =
  | { type: "thread-started"; sessionId: string }
  | { type: "agent-message"; text: string }
  | { type: "operation-progress"; label: string; detail?: string; eventType: string };

export type CodexPromptProgressEvent =
  | SharedAgentPromptProgressEvent
  | { type: "codex-event"; eventType: string };

export type ClaudePromptProgressEvent =
  | SharedAgentPromptProgressEvent
  | { type: "agent-thought"; text: string };
export type AgentPromptProgressEvent = CodexPromptProgressEvent | ClaudePromptProgressEvent;

export type CodexPromptApprovalRequest = CodexApprovalRequest;
export type CodexPromptApprovalDecision = CodexApprovalDecision;
export type CodexPromptUserInputRequest = CodexUserInputRequest;
export type CodexPromptUserInputResponse = CodexUserInputResponse;

export type ControlApiJobResponse =
  | { jobId: string; result: unknown }
  | { jobId: string; error: { message: string } };

export interface SubmitCommandJobInput {
  computerId: string;
  payload: RunCommandJobPayload;
  requestId?: string;
  queueKey?: string;
}

export interface SubmitCodexPromptInput {
  computerId: string;
  payload: RunCodexPromptJobPayload;
  requestId?: string;
  queueKey?: string;
  onProgress?: (event: CodexPromptProgressEvent) => Promise<void> | void;
  onApprovalRequest?: (request: CodexPromptApprovalRequest) => Promise<CodexPromptApprovalDecision> | CodexPromptApprovalDecision;
  onUserInputRequest?: (request: CodexPromptUserInputRequest) => Promise<CodexPromptUserInputResponse> | CodexPromptUserInputResponse;
}

export interface SubmitClaudePromptInput {
  computerId: string;
  payload: RunClaudePromptJobPayload;
  requestId?: string;
  queueKey?: string;
  onProgress?: (event: ClaudePromptProgressEvent) => Promise<void> | void;
}

export interface ListCodexSessionsInput {
  computerId: string;
  codexHome: string;
  activeOnly?: boolean;
  includeExecSessions?: boolean;
  includeSessionIds?: string[];
}

export interface WorkspaceInventoryItem {
  id: string;
  absolutePath: string;
  displayName: string;
  status: string;
}

export interface ComputerInventoryItem {
  id: string;
  displayName: string;
  hostname: string;
  status: string;
  allowedRoleIds: string[];
  capabilities: string[];
  workspaces: WorkspaceInventoryItem[];
}

export interface CreateCategoryMappingInput {
  id: string;
  discordCategoryId: string;
  computerId: string;
  workspaceId: string;
}

export interface CategoryMappingResponse {
  id: string;
  discordCategoryId: string;
  computerId: string;
  workspaceId: string;
  syncStatus: string;
}

export interface CreateManagedChannelInput {
  id: string;
  discordChannelId: string;
  computerId: string;
  workspaceId: string;
  channelMode: ChannelMode;
}

export interface UpdateChannelCwdInput {
  discordChannelId: string;
  cwd: string;
}

export interface RecordCommandAuditInput {
  discordChannelId: string;
  userId: string;
  cwd: string | null;
  rawCommand: string;
  tier: CommandTier;
  resultStatus: string;
}

export interface CommandAuditResponse {
  id: string;
  channelId: string | null;
  userId: string;
  targetComputerId: string;
  targetWorkspaceId: string | null;
  cwd: string | null;
  rawCommand: string;
  tier: string;
  resultStatus: string;
}

export interface LinkCodexSessionInput {
  discordChannelId: string;
  id: string;
  codexSessionId: string;
  origin: SessionOrigin;
  threadNameSnapshot: string;
}

export interface LinkedCodexSessionResponse {
  id: string;
  channelId: string;
  codexSessionId: string;
  origin: SessionOrigin;
  threadNameSnapshot: string;
  availabilityStatus: string;
}

export interface ManagedChannelResponse {
  id: string;
  discordChannelId: string;
  computerId: string;
  workspaceId: string;
  channelMode: ChannelMode;
  cwd: string;
  status: string;
}

export interface ControlApiClient {
  listInventory(): Promise<ComputerInventoryItem[]>;
  getChannelContext(discordChannelId: string): Promise<ManagedDiscordChannelContext | null>;
  createCategoryMapping(input: CreateCategoryMappingInput): Promise<CategoryMappingResponse>;
  createManagedChannel(input: CreateManagedChannelInput): Promise<ManagedChannelResponse>;
  updateChannelCwd(input: UpdateChannelCwdInput): Promise<{ cwd: string }>;
  recordCommandAudit(input: RecordCommandAuditInput): Promise<CommandAuditResponse>;
  linkCodexSession(input: LinkCodexSessionInput): Promise<LinkedCodexSessionResponse>;
  listCodexSessions(input: ListCodexSessionsInput): Promise<ControlApiJobResponse>;
  submitCodexPrompt(input: SubmitCodexPromptInput): Promise<ControlApiJobResponse>;
  controlCodexTurn?: (input: ControlCodexTurnInput) => Promise<CodexTurnControlResult>;
  submitClaudePrompt?: (input: SubmitClaudePromptInput) => Promise<ControlApiJobResponse>;
  submitCommandJob(input: SubmitCommandJobInput): Promise<ControlApiJobResponse>;
}

interface ControlApiErrorResponse {
  error?: { message?: string };
}

function isNdjsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.includes("application/x-ndjson") ?? false;
}

function parseNdjsonLine(line: string): unknown | null {
  const trimmedLine = line.trim();

  if (trimmedLine.length === 0) {
    return null;
  }

  return JSON.parse(trimmedLine) as unknown;
}

function isControlApiJobError(response: ControlApiJobResponse): response is { jobId: string; error: { message: string } } {
  return "error" in response;
}

async function readCodexPromptStream(
  response: Response,
  onProgress: (event: CodexPromptProgressEvent) => Promise<void> | void,
): Promise<ControlApiJobResponse> {
  if (!response.body) {
    throw new Error("Control API Codex prompt stream was empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: ControlApiJobResponse | null = null;

  async function processLine(line: string): Promise<void> {
    const parsed = parseNdjsonLine(line) as
      | { type?: unknown; event?: unknown; jobId?: unknown; result?: unknown; error?: { message?: unknown } }
      | null;

    if (!parsed) {
      return;
    }

    if (parsed.type === "progress" && parsed.event) {
      await onProgress(parsed.event as CodexPromptProgressEvent);
      return;
    }

    if (parsed.type === "result" && typeof parsed.jobId === "string") {
      finalResponse =
        parsed.error && typeof parsed.error.message === "string"
          ? { jobId: parsed.jobId, error: { message: parsed.error.message } }
          : { jobId: parsed.jobId, result: parsed.result };
    }
  }

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      await processLine(line);
    }
  }

  buffer += decoder.decode();
  await processLine(buffer);

  if (!finalResponse) {
    throw new Error("Control API Codex prompt stream ended without a result");
  }

  const completedResponse = finalResponse as ControlApiJobResponse;

  if (isControlApiJobError(completedResponse)) {
    throw new Error(completedResponse.error.message);
  }

  return completedResponse;
}

export function createControlApiClient(input: { baseUrl: string }): ControlApiClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");

  return {
    async listInventory() {
      const response = await fetch(`${baseUrl}/inventory`);
      const body = (await response.json()) as ComputerInventoryItem[] | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API inventory request failed";
        throw new Error(message);
      }

      return body as ComputerInventoryItem[];
    },
    async getChannelContext(discordChannelId) {
      const response = await fetch(
        `${baseUrl}/discord/channels/${encodeURIComponent(discordChannelId)}/context`,
      );

      if (response.status === 404) {
        return null;
      }

      const body = (await response.json()) as ManagedDiscordChannelContext | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API channel context request failed";
        throw new Error(message);
      }

      return body as ManagedDiscordChannelContext;
    },
    async createCategoryMapping(categoryInput) {
      const response = await fetch(
        `${baseUrl}/workspaces/${encodeURIComponent(categoryInput.workspaceId)}/category-mappings`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: categoryInput.id,
            discordCategoryId: categoryInput.discordCategoryId,
            computerId: categoryInput.computerId,
          }),
        },
      );
      const body = (await response.json()) as CategoryMappingResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API category mapping request failed";
        throw new Error(message);
      }

      return body as CategoryMappingResponse;
    },
    async createManagedChannel(channelInput) {
      const response = await fetch(
        `${baseUrl}/workspaces/${encodeURIComponent(channelInput.workspaceId)}/channels`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: channelInput.id,
            discordChannelId: channelInput.discordChannelId,
            computerId: channelInput.computerId,
            channelMode: channelInput.channelMode,
          }),
        },
      );
      const body = (await response.json()) as ManagedChannelResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API managed channel request failed";
        throw new Error(message);
      }

      return body as ManagedChannelResponse;
    },
    async updateChannelCwd(channelInput) {
      const response = await fetch(
        `${baseUrl}/discord/channels/${encodeURIComponent(channelInput.discordChannelId)}/context`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: channelInput.cwd }),
        },
      );
      const body = (await response.json()) as { cwd: string } | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API channel context update failed";
        throw new Error(message);
      }

      return body as { cwd: string };
    },
    async recordCommandAudit(auditInput) {
      const response = await fetch(
        `${baseUrl}/discord/channels/${encodeURIComponent(auditInput.discordChannelId)}/audit-events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: auditInput.userId,
            cwd: auditInput.cwd,
            rawCommand: auditInput.rawCommand,
            tier: auditInput.tier,
            resultStatus: auditInput.resultStatus,
          }),
        },
      );
      const body = (await response.json()) as CommandAuditResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API command audit request failed";
        throw new Error(message);
      }

      return body as CommandAuditResponse;
    },
    async linkCodexSession(sessionInput) {
      const response = await fetch(
        `${baseUrl}/discord/channels/${encodeURIComponent(sessionInput.discordChannelId)}/session-links`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: sessionInput.id,
            codexSessionId: sessionInput.codexSessionId,
            origin: sessionInput.origin,
            threadNameSnapshot: sessionInput.threadNameSnapshot,
          }),
        },
      );
      const body = (await response.json()) as LinkedCodexSessionResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API session link request failed";
        throw new Error(message);
      }

      return body as LinkedCodexSessionResponse;
    },
    async listCodexSessions(sessionInput) {
      const response = await fetch(
        `${baseUrl}/computers/${encodeURIComponent(sessionInput.computerId)}/codex-sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            codexHome: sessionInput.codexHome,
            activeOnly: sessionInput.activeOnly,
            includeExecSessions: sessionInput.includeExecSessions,
            includeSessionIds: sessionInput.includeSessionIds,
          }),
        },
      );
      const body = (await response.json()) as ControlApiJobResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API Codex session listing failed";
        throw new Error(message);
      }

      return body as ControlApiJobResponse;
    },
    async submitCommandJob(commandInput) {
      const response = await fetch(
        `${baseUrl}/computers/${encodeURIComponent(commandInput.computerId)}/jobs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "run-command",
            payload: commandInput.payload,
          }),
        },
      );
      const body = (await response.json()) as ControlApiJobResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API job request failed";
        throw new Error(message);
      }

      return body as ControlApiJobResponse;
    },
    async submitCodexPrompt(promptInput) {
      const response = await fetch(
        `${baseUrl}/computers/${encodeURIComponent(promptInput.computerId)}/jobs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(promptInput.onProgress ? { accept: "application/x-ndjson" } : {}),
          },
          body: JSON.stringify({
            type: "run-codex-prompt",
            ...(promptInput.onProgress ? { streamProgress: true } : {}),
            payload: promptInput.payload,
          }),
        },
      );

      if (promptInput.onProgress && response.ok && isNdjsonResponse(response)) {
        return readCodexPromptStream(response, promptInput.onProgress);
      }

      const body = (await response.json()) as ControlApiJobResponse | ControlApiErrorResponse;

      if (!response.ok) {
        const errorBody = body as ControlApiErrorResponse;
        const message = errorBody.error?.message ?? "Control API Codex prompt request failed";
        throw new Error(message);
      }

      return body as ControlApiJobResponse;
    },
  };
}
