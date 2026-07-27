import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentRelayTurnResultSchema } from "../../../packages/core/src/index.js";
import {
  DEFAULT_AGENT_PROMPT_TIMEOUT_MS,
  createDiscordMessageHandler,
  resolveAgentPromptTimeoutMs,
  type ManagedDiscordChannelContext,
} from "./messageHandler.js";

const channelContext: ManagedDiscordChannelContext = {
  channelMode: "shell-admin",
  allowedRoleIds: ["role-operator"],
  computerId: "computer-1",
  computerDisplayName: "macbook-pro-01",
  workspaceDisplayName: "repo",
  workspaceRoot: "/repo",
  cwd: "/repo",
  timeoutMs: 3_000,
};

const sessionChannelContext: ManagedDiscordChannelContext = {
  ...channelContext,
  channelMode: "session-linked",
  codexSessionId: null,
};

const claudeChannelContext: ManagedDiscordChannelContext = {
  ...channelContext,
  channelMode: "claude-code",
  codexSessionId: null,
};

describe("createDiscordMessageHandler", () => {
  it("uses a long Codex prompt timeout by default while allowing explicit override", () => {
    expect(resolveAgentPromptTimeoutMs(3_000, undefined)).toBe(DEFAULT_AGENT_PROMPT_TIMEOUT_MS);
    expect(resolveAgentPromptTimeoutMs(3_000, "7200000")).toBe(7_200_000);
    expect(resolveAgentPromptTimeoutMs(3_000, "0")).toBe(0);
    expect(resolveAgentPromptTimeoutMs(10_000, "1000")).toBe(10_000);
  });

  it("accepts a trusted relay prompt only in an agent thread and returns a structured callback without a mention", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-relay-1",
      result: {
        status: "completed",
        finalMessage: [
          "상대 agent에게 전달할 답변입니다.",
          "```agent-relay",
          '{"status":"continue","summary":"한 번 더 검토"}',
          "```",
        ].join("\n"),
        sessionId: "session-relay-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-relay-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
      relayControlChannelId: "relay-control",
    });

    await handleMessage({
      authorBot: true,
      relayRequest: true,
      userId: "trusted-relay-bot",
      channelId: "thread-a",
      messageId: "relay-request-1",
      content: "상대 agent의 제안을 검토해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({ edit: async () => undefined }),
    });

    expect(submitCodexPrompt).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      1,
      "thread-a",
      expect.objectContaining({
        embeds: [expect.objectContaining({
          title: "답변",
          description: "상대 agent에게 전달할 답변입니다.",
        })],
      }),
    );
    const callbackPayload = sendTextMessage.mock.calls[1]?.[1];
    expect(sendTextMessage.mock.calls[1]?.[0]).toBe("relay-control");
    expect(callbackPayload).toEqual(expect.objectContaining({
      content: "agent-relay-result:relay-request-1",
      allowedMentions: { parse: [] },
    }));
    const resultFile = callbackPayload.files?.[0]?.attachment;
    expect(Buffer.isBuffer(resultFile)).toBe(true);
    expect(agentRelayTurnResultSchema.parse(JSON.parse(resultFile.toString("utf8")))).toMatchObject({
      requestMessageId: "relay-request-1",
      sourceThreadId: "thread-a",
      finalMessage: "상대 agent에게 전달할 답변입니다.",
      decision: { status: "continue", summary: "한 번 더 검토" },
    });
    expect(sendTextMessage.mock.calls).not.toContainEqual([
      "thread-a",
      "**Codex 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    ]);
  });

  it("never executes a relay bot message in a shell-admin channel", async () => {
    const submitCommandJob = vi.fn();
    const submitCodexPrompt = vi.fn();
    const reply = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
      relayControlChannelId: "relay-control",
    });

    await handleMessage({
      authorBot: true,
      relayRequest: true,
      userId: "trusted-relay-bot",
      channelId: "admin-channel",
      messageId: "relay-request-admin",
      content: "rm -rf /",
      roleIds: ["role-operator"],
      reply,
    });

    expect(submitCommandJob).not.toHaveBeenCalled();
    expect(submitCodexPrompt).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("submits an authorized shell command to the control api and edits the queued reply with the result", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const submitCommandJob = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        stdout: "README.md\n",
        stderr: "",
        exitCode: 0,
        cwd: "/repo/src",
      },
    });
    const updateChannelCwd = vi.fn().mockResolvedValue({ cwd: "/repo/src" });
    const recordCommandAudit = vi.fn().mockResolvedValue({ id: "audit-1" });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd,
      recordCommandAudit,
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "ls",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(submitCommandJob).toHaveBeenCalledWith({
      computerId: "computer-1",
      payload: {
        workspaceRoot: "/repo",
        cwd: "/repo",
        command: "ls",
        timeoutMs: 3_000,
        confirmedDangerous: false,
      },
    });
    expect(updateChannelCwd).toHaveBeenCalledWith({
      discordChannelId: "discord-channel-1",
      cwd: "/repo/src",
    });
    expect(recordCommandAudit).toHaveBeenCalledWith({
      discordChannelId: "discord-channel-1",
      userId: "discord-user-1",
      cwd: "/repo",
      rawCommand: "ls",
      tier: "safe-read",
      resultStatus: "completed",
    });
    expect(replies).toEqual([
      expect.objectContaining({
        allowedMentions: { parse: [] },
        embeds: [
          expect.objectContaining({
            title: "Command queued",
            color: 0xf1c40f,
          }),
        ],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        allowedMentions: { parse: [] },
        embeds: [
          expect.objectContaining({
            title: "Command completed",
            color: 0x2ecc71,
            fields: expect.arrayContaining([
              { name: "Target", value: "`macbook-pro-01` / `repo`", inline: false },
              { name: "Working directory", value: "`/repo/src`", inline: false },
              { name: "Command", value: "```bash\nls\n```", inline: false },
              { name: "Output", value: "```text\nREADME.md\n```", inline: false },
            ]),
          }),
        ],
      }),
    ]);
  });

  it("denies unauthorized command execution without submitting a job", async () => {
    const replies: unknown[] = [];
    const submitCommandJob = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "ls",
      roleIds: ["role-viewer"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(submitCommandJob).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Permission denied",
            color: 0xe74c3c,
          }),
        ],
      }),
    ]);
  });

  it("passes explicit dangerous command confirmation to the control api", async () => {
    const submitCommandJob = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        stdout: "",
        stderr: "",
        exitCode: 0,
      },
    });
    const recordCommandAudit = vi.fn().mockResolvedValue({ id: "audit-1" });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit,
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "confirm rm README.md",
      roleIds: ["role-operator"],
      reply: async () => {},
    });

    expect(submitCommandJob).toHaveBeenCalledWith({
      computerId: "computer-1",
      payload: {
        workspaceRoot: "/repo",
        cwd: "/repo",
        command: "rm README.md",
        timeoutMs: 3_000,
        confirmedDangerous: true,
      },
    });
    expect(recordCommandAudit).toHaveBeenCalledWith({
      discordChannelId: "discord-channel-1",
      userId: "discord-user-1",
      cwd: "/repo",
      rawCommand: "rm README.md",
      tier: "dangerous-mutate",
      resultStatus: "completed",
    });
  });

  it("clears admin channel messages without submitting a shell command", async () => {
    const replies: unknown[] = [];
    const clearMessages = vi.fn().mockResolvedValue({
      deletedCount: 25,
      requestedCount: 25,
    });
    const submitCommandJob = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "clear 25",
      roleIds: ["role-operator"],
      clearMessages,
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(submitCommandJob).not.toHaveBeenCalled();
    expect(clearMessages).toHaveBeenCalledWith({ mode: "count", count: 25 });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Messages cleared",
            color: 0x2ecc71,
          }),
        ],
      }),
    ]);
  });

  it("requires confirmation before clearing all admin channel messages", async () => {
    const replies: unknown[] = [];
    const clearMessages = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "clear",
      roleIds: ["role-operator"],
      clearMessages,
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(clearMessages).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Clear confirmation required",
            color: 0xf1c40f,
          }),
        ],
      }),
    ]);
  });

  it("serializes command execution per Discord channel", async () => {
    const firstJob = {
      resolve: null as ((value: unknown) => void) | null,
    };
    const submitCommandJob = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstJob.resolve = resolve;
          }),
      )
      .mockResolvedValueOnce({
        jobId: "job-2",
        result: {
          status: "completed",
          stdout: "second\n",
          stderr: "",
          exitCode: 0,
        },
      });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const first = handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "pwd",
      roleIds: ["role-operator"],
      reply: async () => {},
    });
    const second = handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "ls",
      roleIds: ["role-operator"],
      reply: async () => {},
    });

    for (let attempt = 0; attempt < 5 && submitCommandJob.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(submitCommandJob).toHaveBeenCalledTimes(1);

    if (!firstJob.resolve) {
      throw new Error("Expected first job resolver to be captured");
    }

    firstJob.resolve({
      jobId: "job-1",
      result: {
        status: "completed",
        stdout: "/repo\n",
        stderr: "",
        exitCode: 0,
      },
    });

    await first;
    await second;

    expect(submitCommandJob).toHaveBeenCalledTimes(2);
    expect(submitCommandJob.mock.calls[0][0].payload.command).toBe("pwd");
    expect(submitCommandJob.mock.calls[1][0].payload.command).toBe("ls");
  });

  it("persists active and pending agent requests and reuses their IDs for worker jobs", async () => {
    let finishFirst: (value: unknown) => void = () => {
      throw new Error("first durable command was not started");
    };
    const submitCommandJob = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({
        jobId: "request-2",
        result: { status: "completed", stdout: "", stderr: "", exitCode: 0 },
      });
    const persisted: string[] = [];
    const completed: string[] = [];
    const persistDurableRequest = vi.fn().mockImplementation(async (input: { content: string }) => {
      const requestId = input.content === "pwd" ? "request-1" : "request-2";
      persisted.push(requestId);
      return { requestId, createdAt: `2026-07-21T00:00:0${persisted.length}.000Z` };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      persistDurableRequest,
      completeDurableRequest: async (requestId) => {
        completed.push(requestId);
      },
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const message = (content: string) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    const first = handleMessage(message("pwd"));
    await vi.waitFor(() => expect(submitCommandJob).toHaveBeenCalledTimes(1));
    const second = handleMessage(message("ls"));
    await vi.waitFor(() => expect(persistDurableRequest).toHaveBeenCalledTimes(2));

    expect(persisted).toEqual(["request-1", "request-2"]);
    expect(submitCommandJob).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: "request-1",
      queueKey: "discord-channel-1",
    }));
    expect(completed).toEqual([]);

    finishFirst({
      jobId: "request-1",
      result: { status: "completed", stdout: "", stderr: "", exitCode: 0 },
    });
    await first;
    await second;

    expect(submitCommandJob).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: "request-2",
      queueKey: "discord-channel-1",
    }));
    expect(completed).toEqual(["request-1", "request-2"]);
  });

  it("restores durable requests in timestamp order before draining their channel", async () => {
    const submitCommandJob = vi.fn().mockImplementation(async (input) => ({
      jobId: input.requestId,
      result: { status: "completed", stdout: "", stderr: "", exitCode: 0 },
    }));
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      completeDurableRequest: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const restoredMessage = (requestId: string, content: string, createdAt: string) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content,
      roleIds: ["role-operator"],
      requestId,
      durableQueuedAt: createdAt,
      restoreOnly: true,
      reply: async () => ({ edit: async () => undefined }),
    });

    await handleMessage(restoredMessage("request-2", "ls", "2026-07-21T00:00:02.000Z"));
    await handleMessage(restoredMessage("request-1", "pwd", "2026-07-21T00:00:01.000Z"));
    expect(submitCommandJob).not.toHaveBeenCalled();

    handleMessage.drainRestoredMessages();
    await vi.waitFor(() => expect(submitCommandJob).toHaveBeenCalledTimes(2));
    expect(submitCommandJob.mock.calls.map(([call]) => call.requestId)).toEqual([
      "request-1",
      "request-2",
    ]);
  });

  it("shows and clears pending messages while preserving the active job", async () => {
    const activeJob = { resolve: null as ((value: unknown) => void) | null };
    const submitCommandJob = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        activeJob.resolve = resolve;
      }),
    );
    const controlReplies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const message = (content: string, collect = false) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async (payload: unknown) => {
        if (collect) {
          controlReplies.push(payload);
        }
        return { edit: async () => undefined };
      },
    });

    const active = handleMessage(message("pwd"));
    const pending = handleMessage(message("ls"));

    for (let attempt = 0; attempt < 5 && submitCommandJob.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    await handleMessage(message("queue", true));
    await handleMessage(message("queue-clear", true));
    await pending;

    expect(submitCommandJob).toHaveBeenCalledTimes(1);
    expect(controlReplies[0]).toEqual(expect.objectContaining({
      embeds: [expect.objectContaining({
        title: "Channel queue",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "Pending (1)", value: expect.stringContaining("ls") }),
        ]),
      })],
    }));
    expect(controlReplies[1]).toEqual(expect.objectContaining({
      embeds: [expect.objectContaining({
        title: "Queue cleared",
        fields: expect.arrayContaining([expect.objectContaining({ name: "Removed", value: "1" })]),
      })],
    }));

    if (!activeJob.resolve) {
      throw new Error("Expected active command resolver");
    }
    activeJob.resolve({ status: "completed", stdout: "", stderr: "", exitCode: 0 });
    await active;
  });

  it("keeps explicit queue prompts pending and mentions every completion with the remaining queue size", async () => {
    let firstPromptWaiting = false;
    let finishFirstPrompt: (value: unknown) => void = () => {
      throw new Error("first prompt completion was not initialized");
    };
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const markDiscordRequestedCodexSession = vi.fn().mockResolvedValue(undefined);
    const submitCodexPrompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFirstPrompt = resolve;
          firstPromptWaiting = true;
        }),
      )
      .mockResolvedValueOnce({
        jobId: "job-2",
        result: {
          status: "completed",
          finalMessage: "두 번째 요청까지 처리했습니다.",
          sessionId: "session-1",
        },
      });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      markDiscordRequestedCodexSession,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      sendTextMessage,
    };
    const userMessage = (content: string, replies: unknown[] = []) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content,
      roleIds: ["role-operator"],
      guild,
      reply: async (payload: unknown) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    const first = handleMessage(userMessage("첫 번째 긴 작업"));
    await vi.waitFor(() => expect(firstPromptWaiting).toBe(true));
    const second = handleMessage(userMessage("/queue prompt:끝나면 이 내용도 이어서 확인해줘"));

    const botReply = vi.fn();
    await handleMessage({
      authorBot: true,
      userId: "bot-user",
      channelId: "thread-1",
      content: "Codex 진행 메시지",
      roleIds: [],
      guild,
      reply: botReply,
    });

    const statusReplies: unknown[] = [];
    await handleMessage(userMessage("status", statusReplies));
    expect(statusReplies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([
              { name: "Agent state", value: "`Codex running`", inline: true },
              { name: "Queue", value: "`1 pending`", inline: true },
            ]),
          }),
        ],
      }),
    ]);
    expect(botReply).not.toHaveBeenCalled();

    finishFirstPrompt({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "첫 번째 요청을 처리했습니다.",
        sessionId: "session-1",
      },
    });
    await first;
    await second;

    expect(submitCodexPrompt).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenCalledTimes(4);
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: expect.stringContaining("첫 번째 요청을 처리했습니다.") })],
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      "**Codex 작업 완료** — 대기열 1개를 이어서 진행합니다",
      { mentionRoleIds: ["role-operator"] },
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      3,
      "thread-1",
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: expect.stringContaining("두 번째 요청까지 처리했습니다.") })],
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      4,
      "thread-1",
      "**Codex 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    );
    expect(markDiscordRequestedCodexSession).toHaveBeenCalledTimes(2);
    expect(markDiscordRequestedCodexSession).toHaveBeenNthCalledWith(
      1,
      "session-1",
      { discordChannelId: "thread-1", completionMentionSent: true },
    );
  });

  it("posts active-goal Codex results as intermediate answers with an operator mention", async () => {
    const edits: unknown[] = [];
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const markDiscordRequestedCodexSession = vi.fn().mockResolvedValue(undefined);
    const resolveCodexGoalStatus = vi.fn().mockResolvedValue("active");
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn().mockResolvedValue({
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "현재 단계 결과입니다.",
          sessionId: "session-1",
        },
      }),
      markDiscordRequestedCodexSession,
      resolveCodexGoalStatus,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content: "장기 작업을 계속해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({
        edit: async (payload: unknown) => {
          edits.push(payload);
        },
      }),
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.objectContaining({
        content: expect.stringContaining("**Codex 중간 답변**"),
        embeds: [expect.objectContaining({ title: "중간 답변" })],
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      "**Codex 중간 답변**",
      { mentionRoleIds: ["role-operator"] },
    );
    expect(edits.at(-1)).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("Codex 중간 답변 수신"),
      }),
    );
    expect(markDiscordRequestedCodexSession).toHaveBeenCalledWith("session-1", {
      discordChannelId: "thread-1",
      completionMentionSent: true,
    });
    expect(resolveCodexGoalStatus).toHaveBeenCalledWith("session-1");
  });

  it("steers an active Codex turn with an ordinary follow-up instead of queueing a new turn", async () => {
    let firstPromptWaiting = false;
    let finishFirstPrompt: (value: unknown) => void = () => {
      throw new Error("first prompt completion was not initialized");
    };
    const submitCodexPrompt = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishFirstPrompt = resolve;
        firstPromptWaiting = true;
      }),
    );
    const controlCodexTurn = vi.fn().mockResolvedValue({
      status: "accepted",
      message: "steered",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const steerReplies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const userMessage = (content: string, replies: unknown[] = []) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content,
      roleIds: ["role-operator"],
      reply: async (payload: unknown) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    const first = handleMessage(userMessage("첫 번째 긴 작업"));
    await vi.waitFor(() => expect(firstPromptWaiting).toBe(true));
    await handleMessage(userMessage("테스트보다 구현을 먼저 진행해줘", steerReplies));

    expect(controlCodexTurn).toHaveBeenCalledWith({
      computerId: "computer-1",
      controlKey: "thread-1",
      action: "steer",
      content: "테스트보다 구현을 먼저 진행해줘",
    });
    expect(submitCodexPrompt).toHaveBeenCalledTimes(1);
    expect(steerReplies).toEqual([
      expect.objectContaining({ embeds: [expect.objectContaining({ title: "Codex steering" })] }),
    ]);

    finishFirstPrompt({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "수정 지시까지 반영했습니다.",
        sessionId: "session-1",
      },
    });
    await first;
  });

  it("retries automatic steering while a new app-server turn is becoming active", async () => {
    let firstPromptWaiting = false;
    let finishFirstPrompt: (value: unknown) => void = () => {
      throw new Error("first prompt completion was not initialized");
    };
    const submitCodexPrompt = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishFirstPrompt = resolve;
        firstPromptWaiting = true;
      }),
    );
    const controlCodexTurn = vi.fn()
      .mockResolvedValueOnce({
        status: "no-active-turn",
        message: "turn is still starting",
      })
      .mockResolvedValueOnce({
        status: "accepted",
        message: "steered",
        threadId: "session-1",
        turnId: "turn-1",
      });
    const steerReplies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      controlCodexTurn,
      autoSteerRetryDelayMs: 0,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const userMessage = (content: string, replies: unknown[] = []) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content,
      roleIds: ["role-operator"],
      reply: async (payload: unknown) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    const first = handleMessage(userMessage("첫 번째 긴 작업"));
    await vi.waitFor(() => expect(firstPromptWaiting).toBe(true));
    await handleMessage(userMessage("방금 지시를 바로 반영해줘", steerReplies));

    expect(controlCodexTurn).toHaveBeenCalledTimes(2);
    expect(submitCodexPrompt).toHaveBeenCalledTimes(1);
    expect(steerReplies).toEqual([
      expect.objectContaining({ embeds: [expect.objectContaining({ title: "Codex steering" })] }),
    ]);

    finishFirstPrompt({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "수정 지시까지 반영했습니다.",
        sessionId: "session-1",
      },
    });
    await first;
  });

  it("does not silently queue an ordinary follow-up when active-turn steering is unsupported", async () => {
    let firstPromptWaiting = false;
    let finishFirstPrompt: (value: unknown) => void = () => {
      throw new Error("first prompt completion was not initialized");
    };
    const submitCodexPrompt = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishFirstPrompt = resolve;
        firstPromptWaiting = true;
      }),
    );
    const controlCodexTurn = vi.fn().mockResolvedValue({
      status: "unsupported",
      message: "Codex steering requires app-server.",
    });
    const steerReplies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      controlCodexTurn,
      autoSteerRetryDelayMs: 0,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const userMessage = (content: string, replies: unknown[] = []) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content,
      roleIds: ["role-operator"],
      reply: async (payload: unknown) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    const first = handleMessage(userMessage("첫 번째 긴 작업"));
    await vi.waitFor(() => expect(firstPromptWaiting).toBe(true));
    await handleMessage(userMessage("이 메시지는 큐로 보내지 마", steerReplies));

    expect(controlCodexTurn).toHaveBeenCalledTimes(1);
    expect(submitCodexPrompt).toHaveBeenCalledTimes(1);
    expect(steerReplies).toEqual([
      expect.objectContaining({ embeds: [expect.objectContaining({ title: "Steering not supported" })] }),
    ]);

    finishFirstPrompt({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "첫 작업 완료",
        sessionId: "session-1",
      },
    });
    await first;
  });

  it("sends Codex steering and interrupt controls immediately", async () => {
    const replies: unknown[] = [];
    const controlCodexTurn = vi.fn()
      .mockResolvedValueOnce({
        status: "accepted",
        message: "steered",
        threadId: "thread-1",
        turnId: "turn-1",
      })
      .mockResolvedValueOnce({
        status: "accepted",
        message: "interrupted",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const send = (content: string) => handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async (payload) => {
        replies.push(payload);
      },
    });

    await send("steer 테스트 대신 구현부터 해줘");
    await send("interrupt");

    expect(controlCodexTurn).toHaveBeenNthCalledWith(1, {
      computerId: "computer-1",
      controlKey: "discord-channel-1",
      action: "steer",
      content: "테스트 대신 구현부터 해줘",
    });
    expect(controlCodexTurn).toHaveBeenNthCalledWith(2, {
      computerId: "computer-1",
      controlKey: "discord-channel-1",
      action: "interrupt",
    });
    expect(replies).toEqual([
      expect.objectContaining({ embeds: [expect.objectContaining({ title: "Codex steering" })] }),
      expect.objectContaining({ embeds: [expect.objectContaining({ title: "Codex interrupt" })] }),
    ]);
  });

  it("steers an active relay turn from a user message and interrupts only its exact request", async () => {
    let finishRelay!: (value: unknown) => void;
    const submitCodexPrompt = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishRelay = resolve;
      }),
    );
    const controlCodexTurn = vi.fn()
      .mockResolvedValueOnce({
        status: "accepted",
        message: "relay steering accepted",
      })
      .mockResolvedValueOnce({
        status: "accepted",
        message: "relay interrupt accepted",
      });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      resolveRelayPresence: async () => ({
        conversationId: "d90bcf0b-e471-4f9f-a2cf-c279d14d53d0",
        originThreadId: "discord-channel-1",
        peerThreadId: "discord-channel-2",
        activeThreadId: "discord-channel-1",
        expiresAtMs: Date.now() + 60_000,
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
      autoSteerRetryDelayMs: 1,
    });
    const relayTurn = handleMessage({
      authorBot: true,
      relayRequest: true,
      userId: "relay-bot",
      channelId: "discord-channel-1",
      content: "두 agent의 설계를 비교해줘",
      roleIds: ["role-operator"],
      messageId: "relay-request-1",
      reply: async () => ({ edit: async () => undefined }),
    });
    await vi.waitFor(() => expect(submitCodexPrompt).toHaveBeenCalledTimes(1));

    const steerReplies: unknown[] = [];
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "성능보다 안정성을 우선해서 검토해줘",
      roleIds: ["role-operator"],
      reply: async (payload) => {
        steerReplies.push(payload);
      },
    });
    await handleMessage({
      authorBot: true,
      relayRequest: true,
      relayCancelRequestId: "relay-request-1",
      userId: "relay-bot",
      channelId: "discord-channel-1",
      content: "interrupt",
      roleIds: ["role-operator"],
      messageId: "relay-cancel-1",
      reply: async () => undefined,
    });

    expect(controlCodexTurn).toHaveBeenNthCalledWith(1, {
      computerId: "computer-1",
      controlKey: "discord-channel-1",
      action: "steer",
      content: "성능보다 안정성을 우선해서 검토해줘",
    });
    expect(controlCodexTurn).toHaveBeenNthCalledWith(2, {
      computerId: "computer-1",
      controlKey: "discord-channel-1",
      action: "interrupt",
    });
    expect(steerReplies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex steering" })],
      }),
    ]);

    finishRelay({
      jobId: "relay-job-1",
      result: {
        status: "failed",
        finalMessage: "",
        sessionId: "session-1",
      },
    });
    await relayTurn;
  });

  it("redirects a user away from the waiting side of an active relay", async () => {
    const replies: unknown[] = [];
    const submitCodexPrompt = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      resolveRelayPresence: async () => ({
        conversationId: "d90bcf0b-e471-4f9f-a2cf-c279d14d53d0",
        originThreadId: "discord-channel-1",
        peerThreadId: "discord-channel-2",
        activeThreadId: "discord-channel-2",
        expiresAtMs: Date.now() + 60_000,
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "이 조건도 같이 검토해줘",
      roleIds: ["role-operator"],
      reply: async (payload) => {
        replies.push(payload);
      },
    });

    expect(submitCodexPrompt).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.stringContaining("<#discord-channel-2>"),
    ]);
  });

  it("sends explicit Claude Code steering through the shared turn control", async () => {
    const replies: unknown[] = [];
    const controlCodexTurn = vi.fn().mockResolvedValue({
      status: "accepted",
      message: "Claude Code steering was accepted.",
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => claudeChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt: vi.fn(),
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      content: "steer 다른 방식으로 해줘",
      roleIds: ["role-operator"],
      reply: async (payload) => {
        replies.push(payload);
      },
    });

    expect(controlCodexTurn).toHaveBeenCalledWith({
      computerId: "computer-1",
      controlKey: "claude-channel-1",
      action: "steer",
      content: "다른 방식으로 해줘",
    });
    expect(replies[0]).toEqual(expect.objectContaining({
      embeds: [expect.objectContaining({
        title: "Claude Code steering",
        description: expect.stringContaining("accepted"),
      })],
    }));
  });

  it("steers an active Claude Code turn with an ordinary follow-up instead of queueing another job", async () => {
    let firstPromptWaiting = false;
    let finishFirstPrompt: (value: unknown) => void = () => {
      throw new Error("first Claude prompt completion was not initialized");
    };
    const submitClaudePrompt = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishFirstPrompt = resolve;
        firstPromptWaiting = true;
      }),
    );
    const controlCodexTurn = vi.fn().mockResolvedValue({
      status: "accepted",
      message: "Claude Code steering was accepted.",
      threadId: "claude-session-1",
    });
    const steerReplies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        claudeSessionId: "claude-session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const userMessage = (content: string, replies: unknown[] = []) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async (payload: unknown) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    const first = handleMessage(userMessage("첫 번째 긴 Claude 작업"));
    await vi.waitFor(() => expect(firstPromptWaiting).toBe(true));
    await handleMessage(userMessage("테스트보다 구현을 먼저 진행해줘", steerReplies));

    expect(controlCodexTurn).toHaveBeenCalledWith({
      computerId: "computer-1",
      controlKey: "claude-channel-1",
      action: "steer",
      content: "테스트보다 구현을 먼저 진행해줘",
    });
    expect(submitClaudePrompt).toHaveBeenCalledTimes(1);
    expect(steerReplies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Claude Code steering" })],
      }),
    ]);

    finishFirstPrompt({
      jobId: "claude-job-1",
      result: {
        status: "completed",
        finalMessage: "수정 지시까지 반영했습니다.",
        sessionId: "claude-session-1",
      },
    });
    await first;
  });

  it("queues a Claude /compact interaction behind an active turn instead of steering it", async () => {
    let firstPromptWaiting = false;
    let finishFirstPrompt: (value: unknown) => void = () => {
      throw new Error("first Claude prompt completion was not initialized");
    };
    const submitClaudePrompt = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishFirstPrompt = resolve;
          firstPromptWaiting = true;
        }),
      )
      .mockResolvedValueOnce({
        jobId: "claude-job-2",
        result: {
          status: "completed",
          finalMessage: "Compacted conversation.",
          sessionId: "claude-session-1",
        },
      });
    const controlCodexTurn = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        claudeSessionId: "claude-session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const userMessage = (content: string) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    const first = handleMessage(userMessage("첫 번째 긴 Claude 작업"));
    await vi.waitFor(() => expect(firstPromptWaiting).toBe(true));
    const compact = handleMessage(userMessage("__cdc_agent_compact 중요한 API 결정은 유지해줘"));

    expect(controlCodexTurn).not.toHaveBeenCalled();
    expect(submitClaudePrompt).toHaveBeenCalledTimes(1);

    finishFirstPrompt({
      jobId: "claude-job-1",
      result: {
        status: "completed",
        finalMessage: "첫 번째 작업을 마쳤습니다.",
        sessionId: "claude-session-1",
      },
    });
    await first;
    await compact;

    expect(submitClaudePrompt).toHaveBeenCalledTimes(2);
    expect(submitClaudePrompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "/compact 중요한 API 결정은 유지해줘",
          sessionId: "claude-session-1",
        }),
      }),
    );
  });

  it("keeps a Claude follow-up as the next queued turn when the active stdin is already closing", async () => {
    const completions: Array<(value: unknown) => void> = [];
    const submitClaudePrompt = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        completions.push(resolve);
      }),
    );
    const controlCodexTurn = vi.fn().mockResolvedValue({
      status: "failed",
      message: "Claude Code input stream is no longer writable.",
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        claudeSessionId: "claude-session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      controlCodexTurn,
      autoSteerRetryDelayMs: 0,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const userMessage = (content: string) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    const first = handleMessage(userMessage("첫 번째 Claude 작업"));
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const second = handleMessage(userMessage("이 지시는 다음 turn에서도 반드시 실행해줘"));

    await vi.waitFor(() => expect(controlCodexTurn).toHaveBeenCalledTimes(1));
    expect(submitClaudePrompt).toHaveBeenCalledTimes(1);

    completions[0]?.({
      jobId: "claude-job-1",
      result: {
        status: "completed",
        finalMessage: "첫 작업 완료",
        sessionId: "claude-session-1",
      },
    });
    await first;
    await vi.waitFor(() => expect(completions).toHaveLength(2));

    expect(submitClaudePrompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "이 지시는 다음 turn에서도 반드시 실행해줘",
          controlKey: "claude-channel-1",
        }),
      }),
    );
    completions[1]?.({
      jobId: "claude-job-2",
      result: {
        status: "completed",
        finalMessage: "후속 작업 완료",
        sessionId: "claude-session-1",
      },
    });
    await second;
  });

  it("allows interrupt while Claude Code is running", async () => {
    const replies: unknown[] = [];
    const controlCodexTurn = vi.fn().mockResolvedValue({
      status: "accepted",
      message: "Claude Code interrupt requested.",
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => claudeChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt: vi.fn(),
      controlCodexTurn,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      content: "interrupt",
      roleIds: ["role-operator"],
      reply: async (payload) => {
        replies.push(payload);
      },
    });

    expect(controlCodexTurn).toHaveBeenCalledWith({
      computerId: "computer-1",
      controlKey: "claude-channel-1",
      action: "interrupt",
    });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Claude Code interrupt" })],
      }),
    ]);
  });

  it("ignores bot and unmanaged channel messages", async () => {
    const submitCommandJob = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => null,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const reply = vi.fn();

    await handleMessage({
      authorBot: true,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "ls",
      roleIds: ["role-operator"],
      reply,
    });
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "unmanaged-channel",
      content: "ls",
      roleIds: ["role-operator"],
      reply,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(submitCommandJob).not.toHaveBeenCalled();
  });

  it("submits a Codex prompt and edits the queued reply with the answer", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const submitCommandJob = vi.fn();
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "이 프로젝트는 Discord에서 Codex를 제어하는 브리지입니다.",
        sessionId: "codex-session-1",
      },
    });
    const markDiscordRequestedCodexSession = vi.fn().mockResolvedValue(undefined);
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob,
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      markDiscordRequestedCodexSession,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 이 프로젝트 설명해줘",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(submitCommandJob).not.toHaveBeenCalled();
    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        computerId: "computer-1",
        payload: expect.objectContaining({
          workspaceRoot: "/repo",
          cwd: "/repo",
          prompt: "이 프로젝트 설명해줘",
          timeoutMs: DEFAULT_AGENT_PROMPT_TIMEOUT_MS,
          sessionId: null,
        }),
        onProgress: expect.any(Function),
      }),
    );
    expect(markDiscordRequestedCodexSession).toHaveBeenCalledWith("codex-session-1", {
      discordChannelId: "discord-channel-1",
    });
    expect(replies).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 시작**"),
        embeds: [],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 완료**"),
        embeds: [
          expect.objectContaining({
            title: "답변",
            description: "이 프로젝트는 Discord에서 Codex를 제어하는 브리지입니다.",
          }),
        ],
      }),
    ]);
  });

  it("materializes attachment-only messages before submitting them to Codex", async () => {
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "이미지를 확인했습니다.",
        sessionId: "codex-session-1",
      },
    });
    const materializeIncomingAttachments = vi.fn().mockImplementation(async (input) => ({
      files: [{
        name: "frame.png",
        localPath: "/repo/.connect/incoming-attachments/message-1/frame.png",
        contentType: "image/png",
        size: 123,
      }],
      content: `${input.content}\n\n첨부 경로: /repo/.connect/incoming-attachments/message-1/frame.png`,
    }));
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      materializeIncomingAttachments,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      messageId: "message-1",
      content: "",
      roleIds: ["role-operator"],
      attachments: [{
        id: "attachment-1",
        name: "frame.png",
        url: "https://cdn.discordapp.com/attachments/channel/message/frame.png",
        contentType: "image/png",
        size: 123,
      }],
      reply: async () => ({ edit: async () => undefined }),
    });

    expect(materializeIncomingAttachments).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message-1",
      content: "첨부된 파일을 확인해줘.",
      attachments: [expect.objectContaining({ name: "frame.png" })],
    }));
    expect(submitCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        prompt: expect.stringContaining("/repo/.connect/incoming-attachments/message-1/frame.png"),
      }),
    }));
  });

  it("passes materialized attachments to Claude Code and skips downloads for unauthorized users", async () => {
    const submitClaudePrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "영상을 확인했습니다.",
        sessionId: "claude-session-1",
      },
    });
    const materializeIncomingAttachments = vi.fn().mockImplementation(async (input) => ({
      files: [{
        name: "clip.mp4",
        localPath: "/repo/.connect/incoming-attachments/message-2/clip.mp4",
        contentType: "video/mp4",
        size: 456,
      }],
      content: `${input.content}\n\n첨부 경로: /repo/.connect/incoming-attachments/message-2/clip.mp4`,
    }));
    const replies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => claudeChannelContext,
      submitCommandJob: vi.fn(),
      submitClaudePrompt,
      materializeIncomingAttachments,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const attachment = {
      id: "attachment-2",
      name: "clip.mp4",
      url: "https://cdn.discordapp.com/attachments/channel/message/clip.mp4",
      contentType: "video/mp4",
      size: 456,
    };

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      messageId: "message-2",
      content: "이 영상의 장면을 확인해줘",
      roleIds: ["role-operator"],
      attachments: [attachment],
      reply: async () => ({ edit: async () => undefined }),
    });

    expect(submitClaudePrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        prompt: expect.stringContaining("/repo/.connect/incoming-attachments/message-2/clip.mp4"),
      }),
    }));

    await handleMessage({
      authorBot: false,
      userId: "discord-user-2",
      channelId: "claude-channel-1",
      messageId: "message-3",
      content: "이 파일도 확인해줘",
      roleIds: ["role-viewer"],
      attachments: [attachment],
      reply: async (payload) => {
        replies.push(payload);
      },
    });

    expect(materializeIncomingAttachments).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([expect.objectContaining({
      embeds: [expect.objectContaining({ title: "Permission denied" })],
    })]);
  });

  it("delivers /howtouse to the Claude Code session linked to the channel", async () => {
    const submitClaudePrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "파일 송수신 규칙을 확인했습니다.",
        sessionId: "claude-session-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        claudeSessionId: "claude-session-1",
      }),
      submitCommandJob: vi.fn(),
      submitClaudePrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-thread-1",
      content: "/howtouse",
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    expect(submitClaudePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionId: "claude-session-1",
          prompt: expect.stringContaining("codex-discord-send"),
        }),
      }),
    );
  });

  it("resolves Codex approval requests from Discord buttons while a prompt is running", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const statusReplies: unknown[] = [];
    let approvalDecision: unknown = null;
    const submitCodexPrompt = vi.fn(async (input) => {
      approvalDecision = await input.onApprovalRequest?.({
        kind: "command",
        title: "명령 실행 권한 요청",
        message: "Codex가 추가 확인이 필요한 명령을 실행하려고 합니다.",
        sessionId: "codex-session-1",
        cwd: "/repo",
        command: "pnpm test",
      });

      return {
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "승인 후 계속 진행했습니다.",
          sessionId: "codex-session-1",
        },
      };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const reply = async (message: unknown) => {
      replies.push(message);
      return {
        edit: async (nextMessage: unknown) => {
          edits.push(nextMessage);
        },
      };
    };

    const promptTask = handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 테스트 실행해줘",
      roleIds: ["role-operator"],
      reply,
    });

    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("<@&role-operator>"),
        allowedMentions: expect.objectContaining({ roles: ["role-operator"] }),
        embeds: [expect.objectContaining({ title: "명령 실행 권한 요청" })],
        components: expect.any(Array),
      }),
    );

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "status",
      roleIds: ["role-operator"],
      reply: async (message) => {
        statusReplies.push(message);
      },
    });
    expect(statusReplies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([
              { name: "Agent state", value: "`Codex waiting-for-approval`", inline: true },
            ]),
          }),
        ],
      }),
    ]);

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "__cdc_codex_approval 1 acceptForSession",
      roleIds: ["role-operator"],
      reply,
    });
    await promptTask;

    expect(approvalDecision).toEqual({ decision: "acceptForSession" });
    expect(replies[2]).toEqual(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "권한 응답 전달됨" })],
      }),
    );
    expect(edits.at(-1)).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: "승인 후 계속 진행했습니다." })],
      }),
    );
  });

  it("routes a natural Discord reply into a pending Codex request_user_input question", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const statusReplies: unknown[] = [];
    let userInputResponse: unknown = null;
    const controlCodexTurn = vi.fn();
    const submitCodexPrompt = vi.fn(async (input) => {
      userInputResponse = await input.onUserInputRequest?.({
        threadId: "codex-session-1",
        turnId: "turn-1",
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
      });

      return {
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "선택한 방식으로 구현했습니다.",
          sessionId: "codex-session-1",
        },
      };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      controlCodexTurn,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const reply = async (message: unknown) => {
      replies.push(message);
      return {
        edit: async (nextMessage: unknown) => {
          edits.push(nextMessage);
        },
      };
    };

    const promptTask = handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 구현해줘",
      roleIds: ["role-operator"],
      reply,
    });

    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toEqual(expect.objectContaining({
      content: expect.stringContaining("<@&role-operator>"),
      allowedMentions: expect.objectContaining({ roles: ["role-operator"] }),
      embeds: [expect.objectContaining({
        title: "Codex 질문 · 1/1 · 구현 방식",
        fields: [expect.objectContaining({ value: expect.stringContaining("2. 직접 수정") })],
      })],
    }));
    expect(replies[1]).not.toHaveProperty("components");

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "status",
      roleIds: ["role-operator"],
      reply: async (message) => {
        statusReplies.push(message);
      },
    });
    expect(statusReplies).toEqual([expect.objectContaining({
      embeds: [expect.objectContaining({
        fields: expect.arrayContaining([
          { name: "Agent state", value: "`Codex waiting-for-user-input`", inline: true },
        ]),
      })],
    })]);

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "2",
      roleIds: ["role-operator"],
      reply,
    });
    await promptTask;

    expect(userInputResponse).toEqual({
      answers: { implementation: { answers: ["직접 수정"] } },
    });
    expect(submitCodexPrompt).toHaveBeenCalledTimes(1);
    expect(controlCodexTurn).not.toHaveBeenCalled();
    expect(replies[2]).toEqual(expect.objectContaining({
      embeds: [expect.objectContaining({
        title: "Codex에 답변 전달됨",
        description: "`직접 수정`",
      })],
    }));
    expect(edits.at(-1)).toEqual(expect.objectContaining({
      content: expect.stringContaining("**Codex 작업 완료**"),
      embeds: [expect.objectContaining({ title: "답변", description: "선택한 방식으로 구현했습니다." })],
    }));
  });

  it("returns a media survey selection to the pending Codex turn", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-user-input-survey-"));
    const videoPath = path.join(tempRoot, "comparison.mp4");
    const replies: unknown[] = [];
    let userInputResponse: unknown = null;

    try {
      await writeFile(videoPath, "fake video");
      const submitCodexPrompt = vi.fn(async (input) => {
        userInputResponse = await input.onUserInputRequest?.({
          threadId: "codex-session-1",
          turnId: "turn-1",
          itemId: "question-1",
          questions: [{
            id: "quality",
            header: "품질 확인",
            question: [
              "두 항목을 확인해주세요.",
              "```codex-discord-survey",
              JSON.stringify({ files: [videoPath], multiple: true }),
              "```",
            ].join("\n"),
            isOther: true,
            isSecret: false,
            options: [
              { label: "싱크가 좋음", description: "입 모양이 잘 맞습니다." },
              { label: "화질이 좋음", description: "디테일이 선명합니다." },
              { label: "둘 다 수정", description: "추가 보정이 필요합니다." },
            ],
          }],
          autoResolutionMs: null,
        });

        return {
          jobId: "job-1",
          result: {
            status: "completed",
            finalMessage: "설문 결과를 반영했습니다.",
            sessionId: "codex-session-1",
          },
        };
      });
      const handleMessage = createDiscordMessageHandler({
        resolveChannelContext: async () => ({
          ...sessionChannelContext,
          discordDeliveryMode: "thread",
        }),
        submitCommandJob: vi.fn(),
        submitCodexPrompt,
        controlCodexTurn: vi.fn(),
        updateChannelCwd: vi.fn(),
        recordCommandAudit: vi.fn(),
      });
      const reply = async (message: unknown) => {
        replies.push(message);
        return { edit: async () => undefined };
      };
      const promptTask = handleMessage({
        authorBot: false,
        userId: "discord-user-1",
        channelId: "discord-channel-1",
        content: "두 영상을 비교해줘",
        roleIds: ["role-operator"],
        reply,
      });

      await vi.waitFor(() => expect(replies).toHaveLength(2));
      const surveyPayload = replies[1] as {
        files?: Array<{ attachment: string }>;
        components?: Array<{ components: Array<{ custom_id?: string; max_values?: number }> }>;
      };
      const customId = surveyPayload.components?.[0]?.components[0]?.custom_id;

      expect(surveyPayload.files).toEqual([{ attachment: videoPath, name: "comparison.mp4" }]);
      expect(surveyPayload.components?.[0]?.components[0]).toMatchObject({
        type: 3,
        max_values: 3,
      });
      expect(customId).toMatch(/^cdc:codex:user-input:/);

      const token = customId?.slice("cdc:codex:user-input:".length) ?? "";
      await handleMessage({
        authorBot: false,
        userId: "discord-user-1",
        channelId: "discord-channel-1",
        content: `__cdc_codex_user_input ${token} ${encodeURIComponent(JSON.stringify(["싱크가 좋음", "화질이 좋음"]))}`,
        roleIds: ["role-operator"],
        reply,
      });
      await promptTask;

      expect(userInputResponse).toEqual({
        answers: { quality: { answers: ["싱크가 좋음", "화질이 좋음"] } },
      });
      expect(replies[2]).toEqual(expect.objectContaining({
        embeds: [expect.objectContaining({
          title: "설문 응답 전달됨",
          description: "- 싱크가 좋음\n- 화질이 좋음",
        })],
      }));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks Codex prompts in the admin channel without submitting a Codex job", async () => {
    const replies: unknown[] = [];
    const submitCodexPrompt = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 이 프로젝트 설명해줘",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(submitCodexPrompt).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "이 채널에서는 실행할 수 없습니다",
            description: "main 채널은 운영 전용입니다.",
          }),
        ],
      }),
    ]);
  });

  it("stores a channel model preference and passes it to later Codex prompts", async () => {
    const replies: unknown[] = [];
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "모델 설정이 반영된 응답입니다.",
        sessionId: "codex-session-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "model gpt-5.4",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 이 모델로 답해줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex settings updated" })],
      }),
    ]);
    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          model: "gpt-5.4",
        }),
      }),
    );
  });

  it("uses extra high reasoning by default for Codex prompts", async () => {
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "기본 reasoning 응답입니다.",
        sessionId: "codex-session-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 기본 reasoning 확인해줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reasoningEffort: "xhigh",
        }),
      }),
    );
  });

  it("persists main defaults and applies them to Codex and Claude threads", async () => {
    let defaults = {
      codex: { model: null as string | null, effort: "xhigh" as const },
      claude: { model: null as string | null, effort: "max" as const },
    };
    const updateAgentDefaults = vi.fn(async (agent, patch) => {
      defaults = {
        ...defaults,
        [agent]: { ...defaults[agent as keyof typeof defaults], ...patch },
      } as typeof defaults;
      return defaults;
    });
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "codex-job",
      result: { status: "completed", finalMessage: "done", sessionId: "codex-session" },
    });
    const submitClaudePrompt = vi.fn().mockResolvedValue({
      jobId: "claude-job",
      result: { status: "completed", finalMessage: "done", sessionId: "claude-session" },
    });
    const contexts: Record<string, ManagedDiscordChannelContext> = {
      "codex-main": { ...channelContext, agentMain: "codex", agentDefaults: defaults },
      "codex-thread": { ...sessionChannelContext, agentDefaults: defaults },
      "claude-main": { ...claudeChannelContext, agentMain: "claude", agentDefaults: defaults },
      "claude-thread": { ...claudeChannelContext, agentDefaults: defaults },
    };
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async (channelId) => contexts[channelId] ?? null,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      submitClaudePrompt,
      updateAgentDefaults,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const send = (channelId: string, content: string) => handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId,
      content,
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    await send("codex-main", "model gpt-5.6-sol");
    await send("codex-main", "effort max");
    await send("claude-main", "model claude-fable-5[1m]");
    await send("claude-main", "effort max");
    await send("codex-thread", "이 설정으로 작업해줘");
    await send("claude-thread", "이 설정으로 작업해줘");

    expect(updateAgentDefaults).toHaveBeenCalledWith("codex", { model: "gpt-5.6-sol" });
    expect(updateAgentDefaults).toHaveBeenCalledWith("codex", { effort: "xhigh" });
    expect(updateAgentDefaults).toHaveBeenCalledWith("claude", { model: "claude-fable-5[1m]" });
    expect(updateAgentDefaults).toHaveBeenCalledWith("claude", { effort: "max" });
    expect(submitCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }),
    }));
    expect(submitClaudePrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "claude-fable-5[1m]", effort: "max" }),
    }));
  });

  it("persists thread overrides and includes effective settings in status", async () => {
    const replies: unknown[] = [];
    const updateSessionAgentSettings = vi.fn().mockResolvedValue(undefined);
    const submitClaudePrompt = vi.fn().mockResolvedValue({
      jobId: "claude-job",
      result: { status: "completed", finalMessage: "done", sessionId: "claude-session" },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        agentDefaults: {
          codex: { model: null, effort: "xhigh" },
          claude: { model: "claude-fable-5[1m]", effort: "max" },
        },
      }),
      submitCommandJob: vi.fn(),
      submitClaudePrompt,
      updateSessionAgentSettings,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const send = (content: string) => handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-thread",
      content,
      roleIds: ["role-operator"],
      reply: async (payload) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    await send("model sonnet");
    await send("effort high");
    await send("status");
    await send("설정을 확인해줘");

    expect(updateSessionAgentSettings).toHaveBeenNthCalledWith(1, "claude-thread", { model: "sonnet" });
    expect(updateSessionAgentSettings).toHaveBeenNthCalledWith(2, "claude-thread", { effort: "high" });
    expect(JSON.stringify(replies)).toContain("sonnet (thread override)");
    expect(JSON.stringify(replies)).toContain("high (thread override)");
    expect(submitClaudePrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "sonnet", effort: "high" }),
    }));
  });

  it("submits explicit Claude Code prompts and resumes the channel Claude session", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const submitClaudePrompt = vi.fn(async (input) => {
      await input.onProgress?.({ type: "thread-started", sessionId: "claude-session-1" });
      await input.onProgress?.({ type: "agent-message", text: "Claude가 작업 중입니다." });
      return {
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "Claude 답변입니다.",
          sessionId: "claude-session-1",
        },
      };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "claude README 요약해줘",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "claude 이어서 테스트 계획도 잡아줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(replies[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("Claude Code 작업 시작"),
      }),
    );
    expect(edits.at(-1)).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("**Claude Code 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: expect.stringContaining("Claude 답변입니다.") })],
      }),
    );
    expect(submitClaudePrompt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "README 요약해줘",
          sessionId: null,
        }),
      }),
    );
    expect(submitClaudePrompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "이어서 테스트 계획도 잡아줘",
          sessionId: "claude-session-1",
        }),
      }),
    );
  });

  it("submits bare Claude Code channel messages to Claude Code", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const recordClaudeSession = vi.fn();
    const submitClaudePrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "Claude 답변입니다.",
        sessionId: "claude-session-1",
      },
    });
    const submitCodexPrompt = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => claudeChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      submitClaudePrompt,
      recordClaudeSession,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "현재 GPU 사용량 봐봐",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "where",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async () => undefined,
        };
      },
    });

    expect(recordClaudeSession).toHaveBeenCalledWith({
      discordChannelId: "discord-channel-1",
      claudeSessionId: "claude-session-1",
    });
    expect(edits.at(-1)).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("**Claude Code 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: expect.stringContaining("Claude 답변입니다.") })],
      }),
    );
    expect(replies.at(-1)).toEqual(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            fields: expect.arrayContaining([
              { name: "Claude session", value: "`claude-session-1`", inline: false },
            ]),
          }),
        ],
      }),
    );

    expect(submitClaudePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "현재 GPU 사용량 봐봐",
          sessionId: null,
        }),
      }),
    );
    expect(submitCodexPrompt).not.toHaveBeenCalled();
  });

  it("forks a linked Claude Code session into a new Discord thread", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const recordClaudeSession = vi.fn();
    const createForkedSessionThread = vi.fn().mockResolvedValue({
      discordChannelId: "fork-thread-1",
      discordCategoryId: null,
      channelName: "gpu-experiment",
      threadName: "GPU experiment",
      cwd: "/repo",
      workspaceRoot: "/repo",
      workspaceDisplayName: "repo",
      pendingSession: true,
      initialPrompt: null,
      discordDeliveryMode: "thread",
      channelMode: "claude-code",
    });
    const submitClaudePrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "새 fork 세션이 준비되었습니다.",
        sessionId: "claude-fork-session-1",
      },
    });
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "notice-1" });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        claudeSessionId: "claude-source-session-1",
        discordDeliveryMode: "thread",
        discordParentChannelId: "claude-parent-channel",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      createForkedSessionThread,
      recordClaudeSession,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "__cdc_fork_session %7B%22name%22%3A%22GPU%20experiment%22%7D",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(createForkedSessionThread).toHaveBeenCalledWith({
      guild: expect.any(Object),
      sourceDiscordChannelId: "discord-channel-1",
      sourceSessionId: "claude-source-session-1",
      name: "GPU experiment",
    });
    expect(submitClaudePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionId: "claude-source-session-1",
          forkSession: true,
          sessionName: "GPU experiment",
          cwd: "/repo",
        }),
      }),
    );
    expect(recordClaudeSession).toHaveBeenCalledWith({
      discordChannelId: "fork-thread-1",
      claudeSessionId: "claude-fork-session-1",
    });
    expect(sendTextMessage).toHaveBeenCalledWith(
      "fork-thread-1",
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Claude Code fork 연결됨" })],
      }),
      { mentionRoleIds: ["role-operator"] },
    );
    expect(replies[0]).toEqual(expect.objectContaining({ embeds: [expect.objectContaining({ title: "Claude Code fork 준비 중" })] }));
    expect(edits.at(-1)).toEqual(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Claude Code fork ready" })],
      }),
    );
  });

  it("forks a linked Codex session into a new Discord thread", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const createForkedSessionThread = vi.fn().mockResolvedValue({
      discordChannelId: "codex-fork-thread-1",
      discordCategoryId: null,
      channelName: "refactor-branch",
      threadName: "Refactor branch",
      cwd: "/repo",
      workspaceRoot: "/repo",
      workspaceDisplayName: "repo",
      pendingSession: true,
      initialPrompt: null,
      discordDeliveryMode: "thread",
      channelMode: "session-linked",
    });
    const submitCodexPrompt = vi.fn(async (input) => {
      await input.onProgress?.({ type: "thread-started", sessionId: "codex-fork-session-1" });
      return {
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "새 Codex fork 세션이 준비되었습니다.",
          sessionId: "codex-fork-session-1",
        },
      };
    });
    const submitClaudePrompt = vi.fn();
    const linkNewCodexSession = vi.fn().mockResolvedValue(undefined);
    const markDiscordRequestedCodexSession = vi.fn().mockResolvedValue(undefined);
    const setSessionStreaming = vi.fn();
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "notice-1" });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "codex-source-session-1",
        discordDeliveryMode: "thread",
        discordParentChannelId: "codex-parent-channel",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      submitClaudePrompt,
      createForkedSessionThread,
      linkNewCodexSession,
      markDiscordRequestedCodexSession,
      setSessionStreaming,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "__cdc_fork_session %7B%22name%22%3A%22Refactor%20branch%22%7D",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(createForkedSessionThread).toHaveBeenCalledWith({
      guild: expect.any(Object),
      sourceDiscordChannelId: "discord-channel-1",
      sourceSessionId: "codex-source-session-1",
      name: "Refactor branch",
    });
    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionId: "codex-source-session-1",
          forkSession: true,
          sessionName: "Refactor branch",
          cwd: "/repo",
          reasoningEffort: "xhigh",
        }),
      }),
    );
    expect(submitClaudePrompt).not.toHaveBeenCalled();
    expect(setSessionStreaming).toHaveBeenNthCalledWith(1, "codex-fork-session-1", true);
    expect(setSessionStreaming).toHaveBeenLastCalledWith("codex-fork-session-1", false);
    expect(markDiscordRequestedCodexSession).toHaveBeenCalledWith("codex-fork-session-1", {
      discordChannelId: "codex-fork-thread-1",
      completionMentionSent: true,
    });
    expect(linkNewCodexSession).toHaveBeenCalledWith({
      discordChannelId: "codex-fork-thread-1",
      codexSessionId: "codex-fork-session-1",
      threadName: "Refactor branch",
    });
    expect(sendTextMessage).toHaveBeenCalledWith(
      "codex-fork-thread-1",
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex fork 연결됨" })],
      }),
      { mentionRoleIds: ["role-operator"] },
    );
    expect(replies[0]).toEqual(expect.objectContaining({ embeds: [expect.objectContaining({ title: "Codex fork 준비 중" })] }));
    expect(edits.at(-1)).toEqual(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex fork ready" })],
      }),
    );
  });

  it("discards a failed Codex fork instead of linking the source session to two threads", async () => {
    const edits: unknown[] = [];
    const createForkedSessionThread = vi.fn().mockResolvedValue({
      discordChannelId: "failed-fork-thread",
      discordCategoryId: null,
      channelName: "failed-fork",
      threadName: "Failed fork",
      cwd: "/repo",
      workspaceRoot: "/repo",
      workspaceDisplayName: "repo",
      pendingSession: true,
      initialPrompt: null,
      discordDeliveryMode: "thread",
      channelMode: "session-linked",
    });
    const linkNewCodexSession = vi.fn();
    const markDiscordRequestedCodexSession = vi.fn();
    const discardForkedSessionThread = vi.fn().mockResolvedValue(true);
    const sendTextMessage = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "source-session",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn().mockResolvedValue({
        jobId: "job-1",
        result: {
          status: "failed",
          finalMessage: "app-server fork failed",
          sessionId: "source-session",
        },
      }),
      createForkedSessionThread,
      discardForkedSessionThread,
      linkNewCodexSession,
      markDiscordRequestedCodexSession,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      sendTextMessage,
    };

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "source-thread",
      content: "__cdc_fork_session %7B%22name%22%3A%22Failed%20fork%22%7D",
      roleIds: ["role-operator"],
      guild,
      reply: async () => ({
        edit: async (payload) => {
          edits.push(payload);
        },
      }),
    });

    expect(linkNewCodexSession).not.toHaveBeenCalled();
    expect(markDiscordRequestedCodexSession).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(discardForkedSessionThread).toHaveBeenCalledWith({
      guild,
      discordChannelId: "failed-fork-thread",
    });
    expect(edits.at(-1)).toEqual(expect.objectContaining({
      embeds: [expect.objectContaining({
        title: "Session fork failed",
        description: expect.stringContaining("app-server fork failed"),
      })],
    }));
  });

  it("keeps source and fork Discord channels on their own Codex session IDs", async () => {
    const contexts = new Map<string, ManagedDiscordChannelContext>([
      ["source-channel", { ...sessionChannelContext, codexSessionId: "source-session" }],
      ["fork-channel", { ...sessionChannelContext, codexSessionId: "fork-session" }],
    ]);
    const submitCodexPrompt = vi.fn(async (input) => ({
      jobId: `job-${input.payload.sessionId}`,
      result: {
        status: "completed",
        finalMessage: `answer-${input.payload.sessionId}`,
        sessionId: input.payload.sessionId,
      },
    }));
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async (channelId) => contexts.get(channelId) ?? null,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const send = (channelId: string, content: string) => handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId,
      content,
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    await Promise.all([
      send("source-channel", "원본에서 계속해줘"),
      send("fork-channel", "fork에서 다른 작업을 해줘"),
    ]);

    expect(submitCodexPrompt).toHaveBeenCalledTimes(2);
    expect(submitCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        prompt: "원본에서 계속해줘",
        sessionId: "source-session",
        controlKey: "source-channel",
      }),
    }));
    expect(submitCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        prompt: "fork에서 다른 작업을 해줘",
        sessionId: "fork-session",
        controlKey: "fork-channel",
      }),
    }));
  });

  it("stores a channel Codex run mode and passes reasoning effort to later prompts", async () => {
    const replies: unknown[] = [];
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "빠른 모드 응답입니다.",
        sessionId: "codex-session-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "fast",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 빠르게 답해줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex mode updated" })],
      }),
    ]);
    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reasoningEffort: "low",
        }),
      }),
    );
  });

  it("runs Codex review requests through review mode instead of a slash-command prompt", async () => {
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "리뷰 완료",
        sessionId: "review-session-1",
      },
    });
    const markDiscordRequestedCodexSession = vi.fn().mockResolvedValue(undefined);
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      markDiscordRequestedCodexSession,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "__cdc_codex_review 보안 위험 위주",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          mode: "review",
          prompt: "보안 위험 위주",
        }),
      }),
    );
    expect(markDiscordRequestedCodexSession).toHaveBeenCalledWith("review-session-1", {
      discordChannelId: "discord-channel-1",
    });
  });

  it("creates a new pending Codex chat channel from the admin channel", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const createNewCodexChat = vi.fn().mockResolvedValue({
      discordChannelId: "new-channel-1",
      discordCategoryId: null,
      channelName: "general-codex-chat",
      threadName: "General Codex chat",
      cwd: "/repo",
      workspaceRoot: "/repo",
      workspaceDisplayName: "General Chat",
      pendingSession: true,
      initialPrompt: null,
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      createNewCodexChat,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "chat new",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
      },
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(createNewCodexChat).toHaveBeenCalledWith({
      guild: expect.any(Object),
      name: null,
      cwd: null,
      currentCwd: channelContext.cwd,
      useCategory: false,
      initialPrompt: null,
      channelMode: "session-linked",
      sessionThreadParentChannelId: "discord-channel-1",
    });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Creating Codex chat" })],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex chat channel ready" })],
      }),
    ]);
  });

  it("creates a new Claude Code chat thread from a Claude Code channel", async () => {
    const createNewCodexChat = vi.fn().mockResolvedValue({
      discordChannelId: "claude-thread-1",
      discordCategoryId: null,
      channelName: "claude-scratch",
      threadName: "Claude scratch",
      cwd: "/repo",
      workspaceRoot: "/repo",
      workspaceDisplayName: "repo",
      pendingSession: true,
      initialPrompt: null,
      discordDeliveryMode: "thread",
      channelMode: "claude-code",
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        discordDeliveryMode: "channel",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      createNewCodexChat,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-parent-channel",
      content: "chat new name:Claude scratch",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createThread: vi.fn(),
        createTextChannel: vi.fn(),
      },
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(createNewCodexChat).toHaveBeenCalledWith({
      guild: expect.any(Object),
      name: "Claude scratch",
      cwd: null,
      currentCwd: claudeChannelContext.cwd,
      useCategory: false,
      initialPrompt: null,
      channelMode: "claude-code",
      sessionThreadParentChannelId: "claude-parent-channel",
    });
  });

  it("creates scheduled commands through the message handler", async () => {
    const replies: unknown[] = [];
    const scheduleCommand = vi.fn().mockResolvedValue({
      status: "created",
      schedule: {
        id: "sched-1",
        channelId: "discord-channel-1",
        userId: "discord-user-1",
        roleIds: ["role-operator"],
        command: "shell pwd",
        schedule: { type: "interval", everyMs: 600_000 },
        enabled: true,
        nextRunAt: "2026-04-24T01:10:00.000Z",
        createdAt: "2026-04-24T01:00:00.000Z",
        updatedAt: "2026-04-24T01:00:00.000Z",
        runCount: 0,
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      scheduleCommand,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "schedule every 10m command:shell pwd",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(scheduleCommand).toHaveBeenCalledWith({
      request: {
        action: "create",
        mode: "every",
        every: "10m",
        command: "shell pwd",
      },
      channelId: "discord-channel-1",
      userId: "discord-user-1",
      roleIds: ["role-operator"],
    });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Schedule created" })],
      }),
    ]);
  });

  it("links a pending new-chat channel to the Codex session opened by the first prompt", async () => {
    const pendingSessionChannelContext: ManagedDiscordChannelContext = {
      ...channelContext,
      channelMode: "session-linked",
      workspaceDisplayName: "General Chat",
      codexSessionId: null,
      discordDeliveryMode: "thread",
    };
    const linkNewCodexSession = vi.fn().mockResolvedValue(undefined);
    const markDiscordRequestedCodexSession = vi.fn().mockResolvedValue(undefined);
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "completion-mention-1" });
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "새 채팅을 시작했습니다.",
        sessionId: "session-new",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => pendingSessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      linkNewCodexSession,
      markDiscordRequestedCodexSession,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "new-channel-1",
      content: "첫 작업 시작해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionId: null,
        }),
      }),
    );
    expect(linkNewCodexSession).toHaveBeenCalledWith({
      discordChannelId: "new-channel-1",
      codexSessionId: "session-new",
      threadName: "첫 작업 시작해줘",
    });
    expect(sendTextMessage).toHaveBeenCalledWith(
      "new-channel-1",
      "**Codex 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    );
    expect(markDiscordRequestedCodexSession).toHaveBeenCalledWith(
      "session-new",
      { discordChannelId: "new-channel-1", completionMentionSent: true },
    );
  });

  it("posts Codex progress without mentions and mentions the role only on completion", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const submitCodexPrompt = vi.fn(async (input) => {
      await input.onProgress?.({ type: "thread-started", sessionId: "session-1" });
      await input.onProgress?.({ type: "operation-progress", label: "작업 단계 실행 중", detail: "작업해줘" });
      await input.onProgress?.({ type: "operation-progress", label: "생각 중" });
      await input.onProgress?.({ type: "operation-progress", label: "답변 작성 중" });
      await input.onProgress?.({ type: "agent-message", text: "관련 파일을 먼저 확인하겠습니다." });
      await input.onProgress?.({ type: "agent-message", text: "관련 파일을 먼저 확인하겠습니다." });
      await input.onProgress?.({
        type: "operation-progress",
        label: "생각 정리",
        detail: "설정 파일과 실행 경로를 함께 수정해야 합니다.",
      });
      await input.onProgress?.({
        type: "operation-progress",
        label: "파일 수정 완료",
        detail: "편집함 src/index.ts",
      });
      await input.onProgress?.({ type: "operation-progress", label: "item.started" });
      await input.onProgress?.({ type: "agent-message", text: "수정을 완료했습니다." });
      return {
        jobId: "job-1",
        result: {
          status: "completed",
          sessionId: "session-1",
        },
      };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content: "작업해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async (payload) => {
        replies.push(payload);
        return { edit: async (editedPayload) => { edits.push(editedPayload); } };
      },
    });

    expect(replies[0]).toEqual(expect.objectContaining({
      allowedMentions: { parse: [] },
      content: expect.not.stringContaining("<@&role-operator>"),
    }));
    expect(edits.at(-1)).toEqual(expect.objectContaining({
      content: expect.stringContaining("최종 답변을 아래 새 메시지에 표시했습니다."),
    }));
    expect(sendTextMessage).toHaveBeenCalledTimes(4);
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.objectContaining({
        allowedMentions: { parse: [] },
        content: expect.stringContaining("관련 파일을 먼저 확인하겠습니다."),
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.objectContaining({
        allowedMentions: { parse: [] },
        content: expect.stringContaining("수정을 완료했습니다."),
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      3,
      "thread-1",
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: expect.stringContaining("수정을 완료했습니다.") })],
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      4,
      "thread-1",
      "**Codex 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    );
  });

  it("uses the same unmentioned progress feed for Claude Code", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const submitClaudePrompt = vi.fn(async (input) => {
      await input.onProgress?.({ type: "agent-message", text: "Claude가 로그를 확인하고 있습니다." });
      await input.onProgress?.({ type: "agent-message", text: "로그 확인을 마쳤습니다." });
      return {
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "로그 확인을 마쳤습니다.",
          sessionId: "claude-session-1",
        },
      };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-thread-1",
      content: "로그 확인해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({ edit: async () => undefined }),
    });

    expect(sendTextMessage).toHaveBeenNthCalledWith(
      1,
      "claude-thread-1",
      expect.objectContaining({
        allowedMentions: { parse: [] },
        content: expect.stringContaining("Claude가 로그를 확인하고 있습니다."),
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      2,
      "claude-thread-1",
      expect.objectContaining({
        allowedMentions: { parse: [] },
        content: expect.stringContaining("로그 확인을 마쳤습니다."),
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      3,
      "claude-thread-1",
      expect.objectContaining({
        content: expect.stringContaining("**Claude Code 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: expect.stringContaining("로그 확인을 마쳤습니다.") })],
      }),
    );
    expect(sendTextMessage).toHaveBeenNthCalledWith(
      4,
      "claude-thread-1",
      "**Claude Code 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    );
  });

  it("blocks plain messages in the Claude main channel and offers new-chat buttons", async () => {
    const submitClaudePrompt = vi.fn();
    const replies: unknown[] = [];
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        agentMain: "claude",
        discordDeliveryMode: "channel",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-main-1",
      content: "안녕, 이 폴더 정리해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage: vi.fn(),
      },
      reply: async (payload) => {
        replies.push(payload);
        return { edit: async () => undefined };
      },
    });

    expect(submitClaudePrompt).not.toHaveBeenCalled();
    const guidance = replies[0] as { content?: string; components?: Array<{ components: Array<{ custom_id: string }> }> };
    expect(guidance.content).toContain("스레드 단위로 관리");
    const buttonIds = (guidance.components ?? []).flatMap((row) => row.components.map((component) => component.custom_id));
    expect(buttonIds).toEqual(expect.arrayContaining(["cdc:chat:new:current", "cdc:cwdpick:open"]));

    // The Codex main channel gets the same guidance for plain prompts.
    const submitCodexPrompt = vi.fn();
    const codexReplies: unknown[] = [];
    const handleCodexMainMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        agentMain: "codex",
        discordDeliveryMode: "channel",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    await handleCodexMainMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "codex-main-1",
      content: "codex 이 폴더 정리해줘",
      roleIds: ["role-operator"],
      guild: { createCategory: vi.fn(), createTextChannel: vi.fn(), sendTextMessage: vi.fn() },
      reply: async (payload) => {
        codexReplies.push(payload);
        return { edit: async () => undefined };
      },
    });
    expect(submitCodexPrompt).not.toHaveBeenCalled();
    expect((codexReplies[0] as { content?: string }).content).toContain("Codex 세션은 스레드 단위로 관리");

    // Session threads keep working as before.
    const threadPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: { status: "completed", finalMessage: "done", sessionId: "claude-session-1" },
    });
    const handleThreadMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt: threadPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    await handleThreadMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-thread-1",
      content: "이어서 진행해줘",
      roleIds: ["role-operator"],
      guild: { createCategory: vi.fn(), createTextChannel: vi.fn(), sendTextMessage: vi.fn() },
      reply: async () => ({ edit: async () => undefined }),
    });
    expect(threadPrompt).toHaveBeenCalled();
  });

  it("posts long Claude thoughts in a plain channel, split across messages instead of truncated", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const longThought = "긴 생각 조각입니다. ".repeat(250).trim();
    const submitClaudePrompt = vi.fn(async (input) => {
      await input.onProgress?.({ type: "agent-thought", text: longThought });
      return {
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: "확인 완료",
          sessionId: "claude-session-1",
        },
      };
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        discordDeliveryMode: "channel",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-channel-1",
      content: "분석해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({ edit: async () => undefined }),
    });

    const thoughtMessages = sendTextMessage.mock.calls.filter(([, payload]) =>
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { content?: unknown }).content === "string" &&
      ((payload as { content: string }).content.includes("Claude Code 생각")),
    );
    expect(thoughtMessages.length).toBeGreaterThanOrEqual(2);
    expect(thoughtMessages[0]?.[1]).toEqual(expect.objectContaining({
      content: expect.stringContaining("긴 생각 조각입니다."),
    }));
    expect((thoughtMessages[1]?.[1] as { content: string }).content).toContain("(계속)");
    const combined = thoughtMessages
      .map(([, payload]) => (payload as { content: string }).content)
      .join("\n");
    expect(combined.length).toBeGreaterThan(2_000);
  });

  it.each([
    ["Codex", "codex", "thread-1", sessionChannelContext],
    ["Claude Code", "claude", "claude-thread-1", claudeChannelContext],
  ] as const)(
    "mentions the operator on a final %s question without a duplicate completion mention",
    async (agentLabel, agent, channelId, context) => {
      const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
      const submitPrompt = vi.fn().mockResolvedValue({
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: [
            "두 결과를 준비했습니다.",
            "",
            "```codex-discord-survey",
            JSON.stringify({
              question: "어느 결과로 진행할까요?",
              options: ["첫 번째 결과", "두 번째 결과"],
            }),
            "```",
          ].join("\n"),
          sessionId: agent === "codex" ? "session-1" : "claude-session-1",
        },
      });
      const handleMessage = createDiscordMessageHandler({
        resolveChannelContext: async () => ({
          ...context,
          ...(agent === "codex" ? { codexSessionId: "session-1" } : {}),
          discordDeliveryMode: "thread",
        }),
        submitCommandJob: vi.fn(),
        submitCodexPrompt: agent === "codex" ? submitPrompt : vi.fn(),
        ...(agent === "claude" ? { submitClaudePrompt: submitPrompt } : {}),
        updateChannelCwd: vi.fn(),
        recordCommandAudit: vi.fn(),
      });

      await handleMessage({
        authorBot: false,
        userId: "discord-user-1",
        channelId,
        content: "결과를 비교해줘",
        roleIds: ["role-operator"],
        guild: {
          createCategory: vi.fn(),
          createTextChannel: vi.fn(),
          sendTextMessage,
        },
        reply: async () => ({ edit: async () => undefined }),
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        1,
        channelId,
        expect.objectContaining({
          content: expect.stringContaining(`**${agentLabel} 작업 완료**`),
          embeds: [expect.objectContaining({ title: "답변", description: "두 결과를 준비했습니다." })],
        }),
      );
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        2,
        channelId,
        expect.objectContaining({
          embeds: [expect.objectContaining({
            title: "미디어 설문",
            description: expect.stringContaining("어느 결과로 진행할까요?"),
          })],
        }),
        { mentionRoleIds: ["role-operator"] },
      );
      expect(sendTextMessage.mock.calls).not.toContainEqual([
        channelId,
        `**${agentLabel} 작업 완료**`,
        { mentionRoleIds: ["role-operator"] },
      ]);
    },
  );

  it("sends generated attachments after the answer in a file-only message", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "discord-result-attachment-"));
    const videoPath = path.join(tempRoot, "preview.mp4");
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });

    try {
      await writeFile(videoPath, "fake video");
      const submitCodexPrompt = vi.fn().mockResolvedValue({
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: [
            "영상 생성이 끝났습니다.",
            "",
            "```codex-discord-send",
            JSON.stringify({ files: [{ path: videoPath, name: "preview.mp4" }] }),
            "```",
          ].join("\n"),
          sessionId: "session-1",
        },
      });
      const handleMessage = createDiscordMessageHandler({
        resolveChannelContext: async () => ({
          ...sessionChannelContext,
          codexSessionId: "session-1",
          discordDeliveryMode: "thread",
        }),
        submitCommandJob: vi.fn(),
        submitCodexPrompt,
        updateChannelCwd: vi.fn(),
        recordCommandAudit: vi.fn(),
      });

      await handleMessage({
        authorBot: false,
        userId: "discord-user-1",
        channelId: "thread-1",
        content: "영상 만들어줘",
        roleIds: ["role-operator"],
        guild: {
          createCategory: vi.fn(),
          createTextChannel: vi.fn(),
          sendTextMessage,
        },
        reply: async () => ({ edit: async () => undefined }),
      });

      expect(sendTextMessage).toHaveBeenNthCalledWith(
        1,
        "thread-1",
        expect.objectContaining({
          content: expect.stringContaining("**Codex 작업 완료**"),
          embeds: [expect.objectContaining({ description: "영상 생성이 끝났습니다." })],
        }),
      );
      expect(sendTextMessage.mock.calls[0]?.[1]?.files).toBeUndefined();
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        2,
        "thread-1",
        {
          allowedMentions: { parse: [] },
          embeds: [],
          files: [{ attachment: videoPath, name: "preview.mp4" }],
        },
      );
      expect(sendTextMessage).toHaveBeenNthCalledWith(
        3,
        "thread-1",
        "**Codex 작업 완료**",
        { mentionRoleIds: ["role-operator"] },
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("sends every long Codex answer chunk before the completion mention", async () => {
    const edits: unknown[] = [];
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const longFinalMessage = Array.from(
      { length: 180 },
      (_, index) => `Codex 결과 ${index + 1}: ${"상세 내용 ".repeat(18)}`,
    ).join("\n");
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn().mockResolvedValue({
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: longFinalMessage,
          sessionId: "session-1",
        },
      }),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content: "긴 결과를 작성해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({
        edit: async (payload) => {
          edits.push(payload);
        },
      }),
    });

    const continuationCalls = sendTextMessage.mock.calls.slice(0, -1);
    expect(edits).toHaveLength(1);
    expect(continuationCalls.length).toBeGreaterThan(1);
    expect(continuationCalls.every(([, payload]) => (
      typeof payload === "object" && payload !== null && "embeds" in payload &&
      Array.isArray(payload.embeds) &&
      typeof payload.embeds[0]?.description === "string" &&
      payload.embeds[0].description.length <= 1_900
    ))).toBe(true);
    expect(continuationCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      embeds: [expect.objectContaining({ description: expect.stringContaining("Codex 결과 180:") })],
    }));
    expect(sendTextMessage.mock.calls.at(-1)).toEqual([
      "thread-1",
      "**Codex 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    ]);
  });

  it("uses the same multi-message final-answer delivery for Claude Code", async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ id: "message-1" });
    const longFinalMessage = Array.from(
      { length: 140 },
      (_, index) => `Claude 결과 ${index + 1}: ${"상세 내용 ".repeat(18)}`,
    ).join("\n");
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...claudeChannelContext,
        discordDeliveryMode: "thread",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      submitClaudePrompt: vi.fn().mockResolvedValue({
        jobId: "job-1",
        result: {
          status: "completed",
          finalMessage: longFinalMessage,
          sessionId: "claude-session-1",
        },
      }),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "claude-thread-1",
      content: "긴 결과를 작성해줘",
      roleIds: ["role-operator"],
      guild: {
        createCategory: vi.fn(),
        createTextChannel: vi.fn(),
        sendTextMessage,
      },
      reply: async () => ({ edit: async () => undefined }),
    });

    expect(sendTextMessage.mock.calls.slice(0, -1).length).toBeGreaterThan(1);
    expect(sendTextMessage.mock.calls.at(-1)).toEqual([
      "claude-thread-1",
      "**Claude Code 작업 완료**",
      { mentionRoleIds: ["role-operator"] },
    ]);
  });

  it("uses a synced channel's Codex session id when submitting a session-linked prompt", async () => {
    const sessionChannelContext: ManagedDiscordChannelContext = {
      ...channelContext,
      channelMode: "session-linked",
      codexSessionId: "session-1",
    };
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "이어받았습니다.",
        sessionId: "session-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "session-channel-1",
      content: "이전 작업 이어서 요약해줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "이전 작업 이어서 요약해줘",
          sessionId: "session-1",
        }),
      }),
    );
  });

  it("continues a completed Codex session from an admin notification reply", async () => {
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "요청한 후속 작업을 완료했습니다.",
        sessionId,
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const content = `__cdc_codex_continue ${encodeURIComponent(JSON.stringify({
      sessionId,
      prompt: "마저 테스트해줘",
    }))}`;

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "admin-channel-1",
      content,
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(submitCodexPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prompt: "마저 테스트해줘",
          sessionId,
        }),
      }),
    );
  });

  it("refreshes a synced channel transcript before resuming chat in on-chat mode", async () => {
    const sessionChannelContext: ManagedDiscordChannelContext = {
      ...channelContext,
      channelMode: "session-linked",
      codexSessionId: "session-1",
    };
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      deleteChannel: vi.fn(),
      deleteCategory: vi.fn(),
    };
    const syncTranscriptUpdates = vi.fn().mockResolvedValue({
      checkedChannels: 1,
      updatedChannels: 1,
      postedMessages: 1,
      skippedByMode: false,
      mode: "on-chat",
    });
    const submitCodexPrompt = vi.fn().mockResolvedValue({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "이어받았습니다.",
        sessionId: "session-1",
      },
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      syncTranscriptUpdates,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "session-channel-1",
      content: "이전 작업 이어서 요약해줘",
      roleIds: ["role-operator"],
      guild,
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(syncTranscriptUpdates).toHaveBeenCalledWith({
      guild,
      discordChannelId: "session-channel-1",
      trigger: "on-chat",
      postUpdates: false,
    });
    expect(syncTranscriptUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      submitCodexPrompt.mock.invocationCallOrder[0],
    );
  });

  it("edits the queued Codex reply with streaming progress before the final answer", async () => {
    const edits: unknown[] = [];
    const submitCodexPrompt = vi
      .fn()
      .mockImplementation(
        async (input: { onProgress?: (event: { type: string; sessionId?: string; text?: string }) => Promise<void> | void }) => {
          await input.onProgress?.({ type: "thread-started", sessionId: "session-1" });
          await input.onProgress?.({ type: "agent-message", text: "중간 답변을 작성 중입니다." });

          return {
            jobId: "job-1",
            result: {
              status: "completed",
              finalMessage: "최종 답변입니다.",
              sessionId: "session-1",
            },
          };
        },
    );
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 진행상황 보여줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async (nextMessage: unknown) => {
          edits.push(nextMessage);
        },
      }),
    });

    expect(edits).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("진행: 세션 연결됨"),
        embeds: [],
      }),
      expect.objectContaining({
        content: expect.stringContaining("중간 답변을 작성 중입니다."),
        embeds: [],
      }),
      expect.objectContaining({
        content: expect.stringContaining("**Codex 작업 완료**"),
        embeds: [expect.objectContaining({ title: "답변", description: "최종 답변입니다." })],
      }),
    ]);
  });

  it("shows readable operation progress from Codex tool activity", async () => {
    const edits: unknown[] = [];
    const submitCodexPrompt = vi
      .fn()
      .mockImplementation(
        async (input: {
          onProgress?: (event: {
            type: string;
            label?: string;
            detail?: string;
            sessionId?: string;
          }) => Promise<void> | void;
        }) => {
          await input.onProgress?.({
            type: "operation-progress",
            label: "파일 탐색 중",
            detail: "42개 파일 · rg --files",
          });

          return {
            jobId: "job-1",
            result: {
              status: "completed",
              finalMessage: "최종 답변입니다.",
              sessionId: "session-1",
            },
          };
        },
    );
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "codex 진행상황 보여줘",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async (nextMessage: unknown) => {
          edits.push(nextMessage);
        },
      }),
    });

    expect(edits[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("진행: 파일 탐색 중"),
        embeds: [],
      }),
    );
    expect((edits[0] as { content: string }).content).toContain("42개의 파일 탐색중...");
  });

  it("runs immediate admin sync only when an admin channel receives sync all", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      deleteChannel: vi.fn(),
      deleteCategory: vi.fn(),
    };
    const syncCodexSessions = vi.fn().mockResolvedValue({
      createdCategories: 1,
      existingCategories: 0,
      createdChannels: 2,
      existingChannels: 0,
      skippedSessions: 0,
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync all",
      roleIds: ["role-operator"],
      guild,
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(syncCodexSessions).toHaveBeenCalledWith(
      expect.objectContaining({ guild, limit: 25, onProgress: expect.any(Function) }),
    );
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex session sync started" })],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex session sync complete" })],
      }),
    ]);
  });

  it("shows the current channel target without running shell commands", async () => {
    const replies: unknown[] = [];
    const submitCommandJob = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "where",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(submitCommandJob).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Current channel target" })],
      }),
    ]);
  });

  it("reports a running Codex turn immediately without waiting behind it", async () => {
    let promptIsWaiting = false;
    let finishPrompt: (response: {
      jobId: string;
      result: { status: string; finalMessage: string; sessionId: string };
    }) => void = () => {
      throw new Error("prompt completion was not initialized");
    };
    const statusReplies: unknown[] = [];
    const submitCodexPrompt = vi.fn(async (input) => {
      await input.onProgress?.({ type: "thread-started", sessionId: "session-1" });
      await input.onProgress?.({ type: "agent-message", text: "데이터를 처리하고 있습니다." });

      return new Promise<{
        jobId: string;
        result: { status: string; finalMessage: string; sessionId: string };
      }>((resolve) => {
        finishPrompt = resolve;
        promptIsWaiting = true;
      });
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => ({
        ...sessionChannelContext,
        codexSessionId: "session-1",
      }),
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    const runningTurn = handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content: "긴 파이프라인을 실행해줘",
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    await vi.waitFor(() => expect(promptIsWaiting).toBe(true));
    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "thread-1",
      content: "status",
      roleIds: ["role-operator"],
      reply: async (payload) => {
        statusReplies.push(payload);
      },
    });

    finishPrompt({
      jobId: "job-1",
      result: {
        status: "completed",
        finalMessage: "처리를 완료했습니다.",
        sessionId: "session-1",
      },
    });
    await runningTurn;

    expect(statusReplies).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            description: expect.stringContaining("아직 실행 중입니다"),
            fields: expect.arrayContaining([
              { name: "Agent state", value: "`Codex running`", inline: true },
              { name: "Active request", value: "`긴 파이프라인을 실행해줘`", inline: false },
              { name: "Queue", value: "`0 pending`", inline: true },
              expect.objectContaining({ name: "Started" }),
              expect.objectContaining({ name: "Last activity" }),
            ]),
          }),
        ],
      }),
    ]);
  });

  it("shows the maintenance panel from a button-only route", async () => {
    const replies: unknown[] = [];
    const submitCommandJob = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "maintenance",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(submitCommandJob).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "유지보수 패널" })],
      }),
    ]);
  });

  it("shows direct sync status from the state store summary", async () => {
    const replies: unknown[] = [];
    const getSyncStatus = vi.fn().mockResolvedValue({
      workspaceCount: 2,
      sessionChannelCount: 5,
      archivedSessionCount: 3,
      contextPostedCount: 4,
      transcriptSyncMode: "on-chat",
      transcriptSyncedChannelCount: 2,
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      getSyncStatus,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync status",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(getSyncStatus).toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex sync status" })],
      }),
    ]);
  });

  it("updates the transcript sync mode from an admin channel", async () => {
    const replies: unknown[] = [];
    const setTranscriptSyncMode = vi.fn().mockResolvedValue({
      mode: "realtime",
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      setTranscriptSyncMode,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync mode realtime",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(setTranscriptSyncMode).toHaveBeenCalledWith("realtime");
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Transcript sync mode updated" })],
      }),
    ]);
  });

  it("reloads Discord bot commands from an admin channel", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const reloadBot = vi.fn().mockResolvedValue({
      mode: "commands",
      commandCount: 18,
      restarting: false,
      startedAt: "2026-04-23T12:00:00.000Z",
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      reloadBot,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "reload",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(reloadBot).toHaveBeenCalledWith({
      mode: "commands",
      execution: { activeCount: 0, pendingCount: 0 },
      force: false,
    });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Bot reload started" })],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Bot reload complete" })],
      }),
    ]);
  });

  it("requires confirmation before restarting the Discord bot", async () => {
    const replies: unknown[] = [];
    const reloadBot = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      reloadBot,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "reload restart",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(reloadBot).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Bot restart confirmation" })],
        components: expect.any(Array),
      }),
    ]);
  });

  it("defers a confirmed restart until active work and queued requests finish", async () => {
    let finishActiveCommand: (value: unknown) => void = () => {
      throw new Error("active command was not started");
    };
    const submitCommandJob = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishActiveCommand = resolve;
        }),
      )
      .mockResolvedValueOnce({
        jobId: "job-2",
        result: { status: "completed", stdout: "", stderr: "", exitCode: 0 },
      });
    const reloadBot = vi.fn().mockImplementation(
      async ({ mode, execution }: {
        mode: "commands" | "restart";
        execution: { activeCount: number; pendingCount: number };
      }) => {
        const deferred = mode === "restart" && (execution.activeCount > 0 || execution.pendingCount > 0);
        return {
          mode,
          commandCount: 18,
          restarting: mode === "restart" && !deferred,
          deferred,
          ...execution,
          startedAt: "2026-04-23T12:00:00.000Z",
        };
      },
    );
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      reloadBot,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const message = (channelId: string, content: string, replies: unknown[] = []) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId,
      content,
      roleIds: ["role-operator"],
      reply: async (payload: unknown) => {
        replies.push(payload);
        return {
          edit: async (nextPayload: unknown) => {
            replies.push(nextPayload);
          },
        };
      },
    });

    const active = handleMessage(message("work-thread", "pwd"));
    await vi.waitFor(() => expect(submitCommandJob).toHaveBeenCalledTimes(1));
    const pending = handleMessage(message("work-thread", "ls"));
    const reloadReplies: unknown[] = [];

    await handleMessage(message("admin-thread", "reload restart confirm", reloadReplies));

    expect(reloadBot).toHaveBeenNthCalledWith(1, {
      mode: "restart",
      execution: { activeCount: 1, pendingCount: 1 },
      force: false,
    });
    expect(reloadReplies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Bot restart deferred" })],
      }),
    ]));

    const blockedReplies: unknown[] = [];
    await handleMessage(message("new-thread", "echo should-not-run", blockedReplies));
    expect(blockedReplies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Bot restart pending" })],
      }),
    ]);

    finishActiveCommand({
      jobId: "job-1",
      result: { status: "completed", stdout: "", stderr: "", exitCode: 0 },
    });
    await active;
    await pending;
    await vi.waitFor(() => expect(reloadBot).toHaveBeenCalledTimes(2));

    expect(reloadBot).toHaveBeenNthCalledWith(2, {
      mode: "restart",
      execution: { activeCount: 0, pendingCount: 0 },
      force: false,
    });
    expect(submitCommandJob).toHaveBeenCalledTimes(2);
  });

  it("allows a forced restart to override a deferred restart while work is active", async () => {
    let finishActiveCommand: (value: unknown) => void = () => {
      throw new Error("active command was not started");
    };
    const submitCommandJob = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finishActiveCommand = resolve;
      }),
    );
    const reloadBot = vi.fn().mockImplementation(
      async ({ mode, execution, force }: {
        mode: "commands" | "restart";
        execution: { activeCount: number; pendingCount: number };
        force: boolean;
      }) => {
        const deferred = mode === "restart" && !force && execution.activeCount > 0;
        return {
          mode,
          commandCount: 18,
          restarting: mode === "restart" && !deferred,
          deferred,
          forced: force,
          ...execution,
          startedAt: "2026-04-23T12:00:00.000Z",
        };
      },
    );
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob,
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      reloadBot,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });
    const message = (channelId: string, content: string) => ({
      authorBot: false,
      userId: "discord-user-1",
      channelId,
      content,
      roleIds: ["role-operator"],
      reply: async () => ({ edit: async () => undefined }),
    });

    const active = handleMessage(message("work-thread", "pwd"));
    await vi.waitFor(() => expect(submitCommandJob).toHaveBeenCalledTimes(1));
    await handleMessage(message("admin-thread", "reload restart confirm"));
    await handleMessage(message("admin-thread", "reload restart force confirm"));

    expect(reloadBot).toHaveBeenNthCalledWith(1, {
      mode: "restart",
      execution: { activeCount: 1, pendingCount: 0 },
      force: false,
    });
    expect(reloadBot).toHaveBeenNthCalledWith(2, {
      mode: "restart",
      execution: { activeCount: 1, pendingCount: 0 },
      force: true,
    });

    finishActiveCommand({
      jobId: "job-1",
      result: { status: "completed", stdout: "", stderr: "", exitCode: 0 },
    });
    await active;
    expect(reloadBot).toHaveBeenCalledTimes(2);
  });

  it("shows a selectable Codex session sync picker", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const previewSelectableCodexSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
          threadName: "Codex Discord sync design",
          updatedAt: "2026-04-23T10:00:00.000Z",
          workspaceDisplayName: "repo",
        },
      ],
      totalAvailable: 1,
      limit: 25,
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      previewSelectableCodexSessions,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync",
      roleIds: ["role-operator"],
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(previewSelectableCodexSessions).toHaveBeenCalledWith({ limit: 25 });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Loading Codex session picker" })],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Select Codex sessions to sync" })],
        components: expect.any(Array),
      }),
    ]);
  });

  it("runs selected session sync when session ids are selected", async () => {
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      deleteChannel: vi.fn(),
      deleteCategory: vi.fn(),
    };
    const syncCodexSessions = vi.fn().mockResolvedValue({
      createdCategories: 0,
      existingCategories: 1,
      createdChannels: 2,
      existingChannels: 0,
      skippedSessions: 0,
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content:
        "sync selected 019db2be-b2b3-7e82-9e61-8c84b28ad287 019db2be-b2b3-7e82-9e61-8c84b28ad288",
      roleIds: ["role-operator"],
      guild,
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(syncCodexSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        guild,
        limit: 2,
        sessionIds: [
          "019db2be-b2b3-7e82-9e61-8c84b28ad287",
          "019db2be-b2b3-7e82-9e61-8c84b28ad288",
        ],
        onProgress: expect.any(Function),
      }),
    );
  });

  it("edits the sync reply with live progress events", async () => {
    const edits: unknown[] = [];
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      deleteChannel: vi.fn(),
      deleteCategory: vi.fn(),
    };
    const syncCodexSessions = vi
      .fn()
      .mockImplementation(async (input: { onProgress?: (event: unknown) => Promise<void> | void }) => {
        await input.onProgress?.({
          phase: "syncing",
          processedSessions: 1,
          totalSessions: 3,
          filteredSessions: 2,
          currentSessionName: "Codex Discord planning",
          createdChannels: 1,
          existingChannels: 0,
          skippedSessions: 2,
        });

        return {
          createdCategories: 1,
          existingCategories: 0,
          createdChannels: 1,
          existingChannels: 0,
          skippedSessions: 2,
        };
      });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync all",
      roleIds: ["role-operator"],
      guild,
      reply: async () => ({
        edit: async (nextMessage: unknown) => {
          edits.push(nextMessage);
        },
      }),
    });

    expect(edits).toEqual([
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Codex session sync in progress",
            fields: expect.arrayContaining([
              { name: "Progress", value: "`1 / 3`", inline: true },
              { name: "Filtered out", value: "`2`", inline: true },
              { name: "Current session", value: "`Codex Discord planning`", inline: false },
            ]),
          }),
        ],
      }),
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Codex session sync complete" })],
      }),
    ]);
  });

  it("archives the current session-linked channel without sending the command to Codex", async () => {
    const sessionChannelContext: ManagedDiscordChannelContext = {
      ...channelContext,
      channelMode: "session-linked",
      codexSessionId: "session-1",
    };
    const archiveSyncedSession = vi.fn().mockResolvedValue({
      codexSessionId: "session-1",
      deletedChannel: true,
      removedChannelMapping: true,
      wasAlreadyArchived: false,
    });
    const submitCodexPrompt = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => sessionChannelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt,
      syncCodexSessions: vi.fn(),
      archiveSyncedSession,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "session-channel-1",
      content: "archive confirm",
      roleIds: ["role-operator"],
      reply: async () => ({
        edit: async () => undefined,
      }),
    });

    expect(submitCodexPrompt).not.toHaveBeenCalled();
    expect(archiveSyncedSession).toHaveBeenCalledWith({
      guild: null,
      discordChannelId: "session-channel-1",
      codexSessionId: "session-1",
    });
  });

  it("previews synced channel deletion without deleting Discord resources", async () => {
    const replies: unknown[] = [];
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      deleteChannel: vi.fn(),
      deleteCategory: vi.fn(),
    };
    const previewSyncedChannelsDelete = vi.fn().mockResolvedValue({
      mode: "all",
      channelCount: 2,
      categoryCount: 1,
      channelNames: ["build-bridge", "fix-sync"],
      categoryNames: ["repo"],
    });
    const deleteSyncedChannels = vi.fn();
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      previewSyncedChannelsDelete,
      deleteSyncedChannels,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync delete preview",
      roleIds: ["role-operator"],
      guild,
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(previewSyncedChannelsDelete).toHaveBeenCalledWith({ mode: "all" });
    expect(deleteSyncedChannels).not.toHaveBeenCalled();
    expect(guild.deleteChannel).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Synced channel delete preview" })],
      }),
    ]);
  });

  it("deletes synced channels only when the request is confirmed", async () => {
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    const guild = {
      createCategory: vi.fn(),
      createTextChannel: vi.fn(),
      deleteChannel: vi.fn(),
      deleteCategory: vi.fn(),
    };
    const deleteSyncedChannels = vi.fn().mockResolvedValue({
      mode: "all",
      deletedChannels: 2,
      deletedCategories: 1,
      missingChannels: 0,
      missingCategories: 0,
    });
    const handleMessage = createDiscordMessageHandler({
      resolveChannelContext: async () => channelContext,
      submitCommandJob: vi.fn(),
      submitCodexPrompt: vi.fn(),
      syncCodexSessions: vi.fn(),
      previewSyncedChannelsDelete: vi.fn(),
      deleteSyncedChannels,
      updateChannelCwd: vi.fn(),
      recordCommandAudit: vi.fn(),
    });

    await handleMessage({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync delete all confirm",
      roleIds: ["role-operator"],
      guild,
      reply: async (message) => {
        replies.push(message);
        return {
          edit: async (nextMessage: unknown) => {
            edits.push(nextMessage);
          },
        };
      },
    });

    expect(deleteSyncedChannels).toHaveBeenCalledWith({ guild, mode: "all" });
    expect(replies).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Deleting synced channels" })],
      }),
    ]);
    expect(edits).toEqual([
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Synced channels deleted" })],
      }),
    ]);
  });
});
