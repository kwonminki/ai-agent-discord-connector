import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  formatConnectorDiscoveryMarker,
  parseConnectorPresenceMarker,
} from "../../../packages/core/src/index.js";
import { createAnswerCopyStore } from "./answerCopyStore.js";
import {
  attachDiscordMessageHandler,
  attachDiscordInteractionHandler,
  createDiscordGuildSurface,
} from "./discordClient.js";
import {
  formatAgentAck,
  formatAgentProgressUpdate,
  formatAgentResultUpdate,
  withRoleMentions,
} from "./responses.js";

describe("attachDiscordMessageHandler", () => {
  it("ignores Discord system messages such as channel renames", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (message: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    attachDiscordMessageHandler(client, handleMessage);
    handlers.get("messageCreate")?.({
      id: "system-message-1",
      channelId: "claude-thread-1",
      content: "이름바꾸기",
      system: true,
      attachments: new Map(),
      author: { bot: false, id: "discord-user-1" },
      member: { roles: { cache: new Map() } },
      reply: vi.fn(),
      guild: { channels: { fetch: vi.fn() } },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("accepts trusted relay requests only through the private control channel", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (message: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const onRelayState = vi.fn().mockResolvedValue(undefined);
    const messageBase = {
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      reply: vi.fn(),
      guild: { channels: { fetch: vi.fn() } },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("상대 agent의 답변을 검토해줘")));

    attachDiscordMessageHandler(client, handleMessage, {
      trustedRelayBotUserIds: ["relay-bot-1"],
      relayControlChannelId: "relay-control",
      onRelayState,
    });
    handlers.get("messageCreate")?.({
      ...messageBase,
      id: "relay-message-1",
      channelId: "relay-control",
      content: "agent-relay-request:123456789012345678",
      attachments: new Map([
        ["prompt", {
          id: "prompt",
          name: "agent-relay-prompt.txt",
          url: "https://cdn.example/agent-relay-prompt.txt",
          contentType: "text/plain",
          size: 45,
        }],
      ]),
      author: { bot: true, id: "relay-bot-1" },
    });
    handlers.get("messageCreate")?.({
      ...messageBase,
      id: "relay-public-message",
      channelId: "123456789012345678",
      content: "Agent relay 대화를 시작했습니다.",
      attachments: new Map(),
      author: { bot: true, id: "relay-bot-1" },
    });
    handlers.get("messageCreate")?.({
      ...messageBase,
      id: "relay-cancel-message",
      channelId: "relay-control",
      content: "agent-relay-cancel:123456789012345678:relay-message-1",
      attachments: new Map(),
      author: { bot: true, id: "relay-bot-1" },
    });
    handlers.get("messageCreate")?.({
      ...messageBase,
      id: "relay-state-message",
      channelId: "relay-control",
      content: "agent-relay-state:d90bcf0b-e471-4f9f-a2cf-c279d14d53d0:active:123456789012345678:123456789012345679:123456789012345678:1784772000000",
      attachments: new Map(),
      author: { bot: true, id: "relay-bot-1" },
    });

    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(3));
    expect(onRelayState).toHaveBeenCalledWith({
      conversationId: "d90bcf0b-e471-4f9f-a2cf-c279d14d53d0",
      status: "active",
      originThreadId: "123456789012345678",
      peerThreadId: "123456789012345679",
      activeThreadId: "123456789012345678",
      expiresAtMs: 1784772000000,
    });
    const adaptedMessages = handleMessage.mock.calls.map(([adapted]) => adapted);
    expect(adaptedMessages).toContainEqual(expect.objectContaining({
      authorBot: true,
      relayRequest: true,
      userId: "relay-bot-1",
      channelId: "123456789012345678",
      content: "상대 agent의 답변을 검토해줘",
    }));
    expect(adaptedMessages).toContainEqual(expect.objectContaining({
      messageId: "relay-public-message",
      channelId: "123456789012345678",
    }));
    expect(adaptedMessages.find((adapted) => adapted.messageId === "relay-public-message"))
      .not.toHaveProperty("relayRequest");
    expect(adaptedMessages).toContainEqual(expect.objectContaining({
      authorBot: true,
      relayRequest: true,
      relayCancelRequestId: "relay-message-1",
      userId: "relay-bot-1",
      channelId: "123456789012345678",
      content: "interrupt",
    }));
    vi.unstubAllGlobals();
  });

  it("answers trusted connector discovery without creating an agent request", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (message: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const discoveryId = "30519a6b-5fd5-4944-9fd2-2e3293c1c925";

    attachDiscordMessageHandler(client, handleMessage, {
      trustedRelayBotUserIds: ["relay-bot-1"],
      relayControlChannelId: "relay-control",
      onConnectorDiscovery: (receivedDiscoveryId) => ({
        version: 1,
        discoveryId: receivedDiscoveryId,
        computerId: "server-a",
        computerDisplayName: "Server A",
        connectorVersion: "1.3.0",
        preferredAgent: "codex",
        channels: { codex: "100", claude: "101" },
        maintenance: { agent: "codex", channelId: "102" },
        registeredAt: "2026-07-24T00:00:00.000Z",
      }),
    });

    handlers.get("messageCreate")?.({
      id: "discovery-message",
      channelId: "relay-control",
      content: formatConnectorDiscoveryMarker(discoveryId),
      attachments: new Map(),
      author: { bot: true, id: "relay-bot-1" },
      member: null,
      reply,
      guild: null,
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(handleMessage).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { content: string };
    expect(parseConnectorPresenceMarker(payload.content)).toEqual(expect.objectContaining({
      discoveryId,
      computerId: "server-a",
      preferredAgent: "codex",
    }));
  });

  it("adapts Discord messageCreate events into the pure message handler", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (message: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const guild = {
      channels: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "category-1" })
          .mockResolvedValueOnce({ id: "channel-1" }),
        fetch: vi.fn().mockResolvedValue({
          delete: vi.fn().mockResolvedValue(undefined),
        }),
      },
    };

    attachDiscordMessageHandler(client, handleMessage);
    handlers.get("messageCreate")?.({
      id: "discord-message-1",
      author: { bot: false, id: "discord-user-1" },
      channelId: "discord-channel-1",
      content: "ls",
      attachments: new Map([
        ["attachment-1", {
          id: "attachment-1",
          name: "frame.png",
          url: "https://cdn.discordapp.com/attachments/channel/message/frame.png",
          contentType: "image/png",
          size: 123,
        }],
      ]),
      member: {
        roles: {
          cache: new Map([
            ["role-operator", { id: "role-operator" }],
            ["role-extra", { id: "role-extra" }],
          ]),
        },
      },
      reply,
      guild,
    });

    expect(client.on).toHaveBeenCalledWith("messageCreate", expect.any(Function));
    expect(handleMessage).toHaveBeenCalledWith({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "ls",
      roleIds: ["role-operator", "role-extra"],
      messageId: "discord-message-1",
      attachments: [{
        id: "attachment-1",
        name: "frame.png",
        url: "https://cdn.discordapp.com/attachments/channel/message/frame.png",
        contentType: "image/png",
        size: 123,
      }],
      guild: expect.any(Object),
      clearMessages: expect.any(Function),
      reply: expect.any(Function),
    });

    const payload = { embeds: [{ title: "pong" }] };
    const adaptedMessage = handleMessage.mock.calls[0][0] as { reply(message: unknown): Promise<unknown> };
    await adaptedMessage.reply(payload);
    expect(reply).toHaveBeenCalledWith(payload);

    const adaptedGuild = handleMessage.mock.calls[0][0].guild as {
      createCategory(input: { name: string }): Promise<{ id: string }>;
      createTextChannel(input: { name: string; parentId: string; topic?: string }): Promise<{ id: string }>;
      deleteChannel(id: string): Promise<void>;
      deleteCategory(id: string): Promise<void>;
    };
    await expect(adaptedGuild.createCategory({ name: "repo" })).resolves.toEqual({ id: "category-1" });
    await expect(
      adaptedGuild.createTextChannel({
        name: "session",
        parentId: "category-1",
        topic: "Codex session",
      }),
    ).resolves.toEqual({ id: "channel-1" });
    await expect(adaptedGuild.deleteChannel("channel-1")).resolves.toBeUndefined();
    await expect(adaptedGuild.deleteCategory("category-1")).resolves.toBeUndefined();
    expect(guild.channels.create).toHaveBeenCalledTimes(2);
    expect(guild.channels.fetch).toHaveBeenCalledWith("channel-1");
    expect(guild.channels.fetch).toHaveBeenCalledWith("category-1");
  });

  it("creates threads and allows explicit role mentions for sent messages", async () => {
    const threadCreate = vi.fn().mockResolvedValue({ id: "thread-1" });
    const send = vi.fn().mockResolvedValue({ id: "message-1" });
    const guild = {
      channels: {
        fetch: vi.fn((channelId: string) =>
          Promise.resolve(
            channelId === "admin-channel"
              ? { threads: { create: threadCreate } }
              : { send },
          ),
        ),
      },
    };
    const guildSurface = createDiscordGuildSurface(guild as never);

    await expect(
      guildSurface?.createThread?.({
        parentChannelId: "admin-channel",
        name: "session-thread",
        autoArchiveDuration: 10_080,
        reason: "Codex session",
      }),
    ).resolves.toEqual({ id: "thread-1" });
    await expect(
      guildSurface?.sendTextMessage?.("thread-1", "작업 완료", {
        mentionRoleIds: ["operator-role"],
      }),
    ).resolves.toEqual({ id: "message-1" });

    expect(threadCreate).toHaveBeenCalledWith({
      name: "session-thread",
      autoArchiveDuration: 10_080,
      reason: "Codex session",
    });
    expect(send).toHaveBeenCalledWith({
      allowedMentions: { parse: [], roles: ["operator-role"] },
      content: "<@&operator-role>\n작업 완료",
      embeds: [],
    });
  });

  it("adds a durable answer copy button when sending a final answer", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "answer-copy-client-"));
    const answerCopyStore = createAnswerCopyStore(tempRoot);
    const send = vi.fn().mockResolvedValue({ id: "message-1" });
    const guild = {
      channels: {
        fetch: vi.fn().mockResolvedValue({ send }),
      },
    };

    try {
      const payload = formatAgentResultUpdate(
        {
          computerDisplayName: "Local Dev",
          workspaceDisplayName: "repo",
          cwd: "/repo",
          prompt: "요약해줘",
        },
        {
          result: {
            status: "completed",
            finalMessage: "복사할 최종 답변입니다.",
            sessionId: "session-1",
          },
        },
      );
      const guildSurface = createDiscordGuildSurface(guild as never, { answerCopyStore });

      await guildSurface?.sendTextMessage?.("thread-1", payload);

      const sentPayload = send.mock.calls[0]?.[0];
      const copyButton = sentPayload.components[0].components.find(
        (component: { custom_id?: string }) => component.custom_id?.startsWith("cdc:answer:copy:"),
      );
      const copyId = copyButton.custom_id.slice("cdc:answer:copy:".length);

      expect(copyButton).toMatchObject({ label: "답변 복사", style: 2 });
      await expect(answerCopyStore.read(copyId)).resolves.toBe("복사할 최종 답변입니다.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves role mentions while editing a Codex progress message", async () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (message: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue({ id: "progress-message-1" });
    const reply = vi.fn().mockResolvedValue({ id: "progress-message-1", edit });

    attachDiscordMessageHandler(client, handleMessage);
    handlers.get("messageCreate")?.({
      author: { bot: false, id: "discord-user-1" },
      channelId: "thread-1",
      content: "작업해줘",
      member: { roles: { cache: new Map([["operator-role", { id: "operator-role" }]]) } },
      reply,
      guild: null,
    });

    const adaptedMessage = handleMessage.mock.calls[0][0] as { reply(message: unknown): Promise<{ edit(message: unknown): Promise<unknown> }> };
    const input = {
      computerDisplayName: "Kwon Mac",
      workspaceDisplayName: "repo",
      cwd: "/repo",
      prompt: "작업해줘",
    };
    const queuedReply = await adaptedMessage.reply(
      withRoleMentions(formatAgentAck(input), ["operator-role"]),
    );

    await queuedReply.edit(
      withRoleMentions(
        formatAgentProgressUpdate(input, { status: "item.started", recentEvents: ["파일 확인 중"] }),
        ["operator-role"],
      ),
    );

    await queuedReply.edit(
      withRoleMentions(
        formatAgentResultUpdate(
          { ...input, agentLabel: "Claude Code" },
          {
            result: {
              status: "completed",
              finalMessage: "Claude 최종 답변입니다.",
              sessionId: "claude-session-1",
            },
          },
        ),
        ["operator-role"],
      ),
    );

    expect(edit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowedMentions: { parse: [], roles: ["operator-role"] },
        content: expect.stringContaining("<@&operator-role>"),
      }),
    );
    expect(edit.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining("**Claude Code 작업 완료**"),
        embeds: [expect.objectContaining({ description: "Claude 최종 답변입니다." })],
      }),
    );
  });
});

describe("attachDiscordInteractionHandler", () => {
  it("returns channel-aware model autocomplete choices", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn();
    const isManagedChannel = vi.fn().mockResolvedValue(true);
    const modelAutocomplete = vi.fn().mockResolvedValue([
      { name: "default", value: "default" },
      { name: "GPT-5.6-Sol", value: "gpt-5.6-sol" },
    ]);
    const respond = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage, {
      isManagedChannel,
      modelAutocomplete,
    });
    handlers.get("interactionCreate")?.({
      isAutocomplete: () => true,
      commandName: "model",
      channelId: "codex-thread-1",
      options: {
        getFocused: () => ({ name: "model", value: "sol" }),
      },
      respond,
    });

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(isManagedChannel).toHaveBeenCalledWith("codex-thread-1");
    expect(modelAutocomplete).toHaveBeenCalledWith("codex-thread-1", "sol");
    expect(respond).toHaveBeenCalledWith([
      { name: "default", value: "default" },
      { name: "GPT-5.6-Sol", value: "gpt-5.6-sol" },
    ]);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("returns published Harness choices through native autocomplete", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn();
    const harnessAutocomplete = vi.fn().mockResolvedValue([
      { name: "safe-review · latest 1.2.0", value: "safe-review" },
    ]);
    const respond = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage, {
      isManagedChannel: vi.fn().mockResolvedValue(true),
      harnessAutocomplete,
    });
    handlers.get("interactionCreate")?.({
      isAutocomplete: () => true,
      commandName: "harness",
      channelId: "codex-thread-1",
      options: {
        getFocused: () => ({ name: "harness", value: "safe" }),
      },
      respond,
    });

    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(harnessAutocomplete).toHaveBeenCalledWith("codex-thread-1", "safe");
    expect(respond).toHaveBeenCalledWith([
      { name: "safe-review · latest 1.2.0", value: "safe-review" },
    ]);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("opens short answers in a copyable modal and returns long answers as text files", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "answer-copy-interaction-"));
    const answerCopyStore = createAnswerCopyStore(tempRoot);
    const shortAnswer = "짧은 답변 전체입니다.";
    const secondShortAnswer = "두 번째 답변은 다른 내용입니다.";
    const longAnswer = "긴 답변입니다. ".repeat(700);
    const shortId = await answerCopyStore.save(shortAnswer);
    const secondShortId = await answerCopyStore.save(secondShortAnswer);
    const longId = await answerCopyStore.save(longAnswer);
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn();
    const showModal = vi.fn().mockResolvedValue(undefined);
    const shortReply = vi.fn().mockResolvedValue(undefined);

    try {
      attachDiscordInteractionHandler(client, handleMessage, { answerCopyStore });
      handlers.get("interactionCreate")?.({
        isButton: () => true,
        customId: `cdc:answer:copy:${shortId}`,
        user: { id: "discord-user-1" },
        channelId: "thread-1",
        member: { roles: { cache: new Map() } },
        guild: null,
        reply: shortReply,
        showModal,
      });

      await vi.waitFor(() => expect(showModal).toHaveBeenCalled());
      expect(showModal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "답변 복사",
          custom_id: `cdc:answer:copy:modal:${shortId}`,
          components: [
            expect.objectContaining({
              components: [expect.objectContaining({
                custom_id: `answer-${shortId}`,
                value: shortAnswer,
              })],
            }),
          ],
        }),
      );
      expect(shortReply).not.toHaveBeenCalled();

      handlers.get("interactionCreate")?.({
        isButton: () => true,
        customId: `cdc:answer:copy:${secondShortId}`,
        user: { id: "discord-user-1" },
        channelId: "thread-1",
        member: { roles: { cache: new Map() } },
        guild: null,
        reply: shortReply,
        showModal,
      });

      await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(2));
      expect(showModal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          custom_id: `cdc:answer:copy:modal:${secondShortId}`,
          components: [
            expect.objectContaining({
              components: [expect.objectContaining({
                custom_id: `answer-${secondShortId}`,
                value: secondShortAnswer,
              })],
            }),
          ],
        }),
      );

      const longReply = vi.fn().mockResolvedValue(undefined);
      handlers.get("interactionCreate")?.({
        isButton: () => true,
        customId: `cdc:answer:copy:${longId}`,
        user: { id: "discord-user-1" },
        channelId: "thread-1",
        member: { roles: { cache: new Map() } },
        guild: null,
        reply: longReply,
        showModal,
      });

      await vi.waitFor(() => expect(longReply).toHaveBeenCalled());
      const longPayload = longReply.mock.calls[0]?.[0];
      expect(longPayload).toMatchObject({
        ephemeral: true,
        files: [{ name: "answer.txt" }],
      });
      expect(longPayload.files[0].attachment.toString("utf8")).toBe(longAnswer.trimEnd());
      expect(handleMessage).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("adapts Discord native slash command interactions into the pure message handler", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isChatInputCommand: () => true,
      commandName: "compact",
      options: {
        getString: (name: string) => (name === "prompt" ? "지금까지 맥락 정리" : null),
        getInteger: () => null,
        getBoolean: () => null,
      },
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      reply,
      guild: null,
    });

    expect(client.on).toHaveBeenCalledWith("interactionCreate", expect.any(Function));
    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        authorBot: false,
        userId: "discord-user-1",
        channelId: "discord-channel-1",
        content: "__cdc_agent_compact 지금까지 맥락 정리",
        roleIds: ["role-operator"],
      }),
    );
  });

  it("defers slash command replies before long handler work", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const sentMessage = { id: "slash-message-1", edit: vi.fn() };
    const editReply = vi.fn().mockResolvedValue(sentMessage);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isChatInputCommand: () => true,
      commandName: "howtouse",
      options: {
        getString: () => null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      deferReply,
      reply,
      editReply,
      fetchReply: vi.fn().mockResolvedValue(sentMessage),
      guild: null,
    });

    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalled());
    expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(handleMessage.mock.invocationCallOrder[0]);

    const adaptedMessage = handleMessage.mock.calls[0][0] as { reply(message: unknown): Promise<unknown> };
    const payload = { embeds: [{ title: "Codex 작업 시작" }] };
    await adaptedMessage.reply(payload);

    expect(reply).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(payload);
  });

  it("ignores slash command interactions in unmanaged channels before deferring replies", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const isManagedChannel = vi.fn().mockResolvedValue(false);

    attachDiscordInteractionHandler(client, handleMessage, { isManagedChannel });
    handlers.get("interactionCreate")?.({
      isChatInputCommand: () => true,
      commandName: "howtouse",
      options: {
        getString: () => null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      user: { id: "discord-user-1" },
      channelId: "unmanaged-channel",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      deferReply,
      reply,
      guild: null,
    });

    await vi.waitFor(() => expect(isManagedChannel).toHaveBeenCalledWith("unmanaged-channel"));
    expect(deferReply).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("shows Harness help even when the channel has no managed agent session", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const isManagedChannel = vi.fn().mockResolvedValue(false);
    const reply = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage, { isManagedChannel });
    handlers.get("interactionCreate")?.({
      isChatInputCommand: () => true,
      commandName: "harness-help",
      options: {
        getString: () => null,
        getInteger: () => null,
        getBoolean: () => null,
        getSubcommand: () => null,
      },
      user: { id: "discord-user-1" },
      channelId: "unmanaged-channel",
      member: { roles: { cache: new Map() } },
      reply,
      guild: null,
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
      content: expect.stringContaining("**Harness 사용법**"),
    }));
    expect(isManagedChannel).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("adapts Discord button interactions into the pure message handler", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const guild = {
      channels: {
        create: vi.fn(),
        fetch: vi.fn(),
      },
    };

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "cdc:sync:25",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      reply,
      guild,
    });

    expect(client.on).toHaveBeenCalledWith("interactionCreate", expect.any(Function));
    expect(handleMessage).toHaveBeenCalledWith({
      authorBot: false,
      userId: "discord-user-1",
      channelId: "discord-channel-1",
      content: "sync select 25",
      roleIds: ["role-operator"],
      guild: expect.any(Object),
      reply: expect.any(Function),
    });

    const adaptedInteraction = handleMessage.mock.calls[0][0] as { reply(message: unknown): Promise<unknown> };
    const payload = { embeds: [{ title: "syncing" }] };
    await adaptedInteraction.reply(payload);
    expect(reply).toHaveBeenCalledWith(payload);
  });

  it("acknowledges a final media survey immediately before queueing the agent follow-up", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: "survey-followup-1" });

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => false,
      isStringSelectMenu: () => true,
      customId: "cdc:agent:survey:claude",
      values: ["1:B가 좋음"],
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      reply,
      channel: { send },
      guild: null,
    });

    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({
      allowedMentions: { parse: [] },
      ephemeral: true,
      content: "설문 선택을 접수했습니다. 같은 agent 세션의 다음 작업으로 전달합니다.",
    });
    expect(reply.mock.invocationCallOrder[0]).toBeLessThan(handleMessage.mock.invocationCallOrder[0]);
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("/queue prompt:claude Discord 미디어 설문"),
    }));

    const adaptedMessage = handleMessage.mock.calls[0][0] as { reply(message: unknown): Promise<unknown> };
    const payload = { embeds: [{ title: "Claude Code 작업 시작" }] };
    await adaptedMessage.reply(payload);
    expect(send).toHaveBeenCalledWith(payload);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("opens a free-text survey modal and queues the submitted answer", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const showModal = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "cdc:survey:other:agent:claude",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply: vi.fn(),
      showModal,
    });

    await vi.waitFor(() => expect(showModal).toHaveBeenCalled());
    expect(showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: "기타 답변",
      custom_id: "cdc:survey:other:agent:claude",
    }));
    expect(handleMessage).not.toHaveBeenCalled();

    const reply = vi.fn().mockResolvedValue(undefined);
    handlers.get("interactionCreate")?.({
      isModalSubmit: () => true,
      customId: "cdc:survey:other:agent:claude",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply,
      fields: {
        getTextInputValue: (fieldId: string) =>
          fieldId === "answer" ? "두 결과의 장점을 섞어주세요" : "",
      },
    });

    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: "자유 답변을 접수했습니다. 같은 agent 세션의 다음 작업으로 전달합니다.",
    }));
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining(
        "/queue prompt:claude Discord 미디어 설문에서 사용자가 자유 입력으로 답했습니다:",
      ),
    }));
  });

  it("ignores button interactions in unmanaged channels before replying", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const isManagedChannel = vi.fn().mockResolvedValue(false);

    attachDiscordInteractionHandler(client, handleMessage, { isManagedChannel });
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "cdc:sync:25",
      user: { id: "discord-user-1" },
      channelId: "unmanaged-channel",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      reply,
      guild: null,
    });

    await vi.waitFor(() => expect(isManagedChannel).toHaveBeenCalledWith("unmanaged-channel"));
    expect(reply).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("ignores modal submit interactions in unmanaged channels", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const isManagedChannel = vi.fn().mockResolvedValue(false);

    attachDiscordInteractionHandler(client, handleMessage, { isManagedChannel });
    handlers.get("interactionCreate")?.({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "cdc:codex:submit",
      user: { id: "discord-user-1" },
      channelId: "unmanaged-channel",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      reply,
      guild: null,
      fields: {
        getTextInputValue: () => "README 요약해줘",
      },
    });

    await vi.waitFor(() => expect(isManagedChannel).toHaveBeenCalledWith("unmanaged-channel"));
    expect(reply).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("sends additional interaction replies through the channel", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ id: "followup-message-1" });

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "cdc:sync:25",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      reply,
      channel: { send },
      guild: null,
    });

    const adaptedInteraction = handleMessage.mock.calls[0][0] as { reply(message: unknown): Promise<unknown> };
    const firstPayload = { embeds: [{ title: "queued" }] };
    const secondPayload = { embeds: [{ title: "approval required" }] };

    await adaptedInteraction.reply(firstPayload);
    await adaptedInteraction.reply(secondPayload);

    expect(reply).toHaveBeenCalledWith(firstPayload);
    expect(send).toHaveBeenCalledWith(secondPayload);
  });

  it("adapts Discord select menu interactions into the pure message handler", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => false,
      isStringSelectMenu: () => true,
      customId: "cdc:fs:open",
      values: ["docs"],
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: {
        roles: {
          cache: new Map([["role-operator", { id: "role-operator" }]]),
        },
      },
      reply,
      guild: null,
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "__cdc_exec __cdc_open docs",
        channelId: "discord-channel-1",
      }),
    );
  });

  it("shows a Codex prompt modal and dispatches submitted text", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const showModal = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "cdc:codex:ask",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply: vi.fn(),
      showModal,
    });

    expect(showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Codex에게 요청",
        custom_id: "cdc:codex:submit",
      }),
    );
    expect(handleMessage).not.toHaveBeenCalled();

    handlers.get("interactionCreate")?.({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "cdc:codex:submit",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply: vi.fn(),
      fields: {
        getTextInputValue: (fieldId: string) => (fieldId === "prompt" ? "README 요약해줘" : ""),
      },
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "codex README 요약해줘",
      }),
    );
  });

  it("shows a new chat modal from chat buttons and dispatches submitted details", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const showModal = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "cdc:chat:new:current",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply: vi.fn(),
      showModal,
    });

    expect(showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "현재 폴더에서 새 채팅",
        custom_id: "cdc:chat:submit:current",
      }),
    );
    expect(handleMessage).not.toHaveBeenCalled();

    handlers.get("interactionCreate")?.({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "cdc:chat:submit:current",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply: vi.fn(),
      fields: {
        getTextInputValue: (fieldId: string) =>
          fieldId === "name" ? "UI 점검" : fieldId === "prompt" ? "버튼 흐름을 점검해줘" : "",
      },
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "__cdc_new_chat %7B%22name%22%3A%22UI%20%EC%A0%90%EA%B2%80%22%2C%22cwd%22%3A%22.%22%2C%22useCategory%22%3Atrue%2C%22initialPrompt%22%3A%22%EB%B2%84%ED%8A%BC%20%ED%9D%90%EB%A6%84%EC%9D%84%20%EC%A0%90%EA%B2%80%ED%95%B4%EC%A4%98%22%7D",
      }),
    );
  });

  it("shows a fork modal from /fork and dispatches the submitted thread name", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn().mockResolvedValue(undefined);
    const showModal = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isChatInputCommand: () => true,
      commandName: "fork",
      options: {
        getString: () => null,
        getInteger: () => null,
        getBoolean: () => null,
      },
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      deferReply,
      reply: vi.fn(),
      showModal,
    });

    expect(showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "새 fork 스레드",
        custom_id: "cdc:fork:submit",
      }),
    );
    expect(deferReply).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();

    handlers.get("interactionCreate")?.({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "cdc:fork:submit",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
      guild: null,
      reply: vi.fn(),
      fields: {
        getTextInputValue: (fieldId: string) => (fieldId === "name" ? "GPU 실험" : ""),
      },
    });

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "__cdc_fork_session %7B%22name%22%3A%22GPU%20%EC%8B%A4%ED%97%98%22%7D",
      }),
    );
  });

  it("keeps final answer text separate from attachments when editing a progress message", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-progress-attachment-"));
    const videoPath = path.join(tempRoot, "review.mp4");

    try {
      await writeFile(videoPath, "fake video");

      const handlers = new Map<string, (message: unknown) => void>();
      const client = {
        on: vi.fn((eventName: string, handler: (message: unknown) => void) => {
          handlers.set(eventName, handler);
          return client;
        }),
      };
      const sentMessage = {
        id: "message-1",
        edit: vi.fn().mockResolvedValue(undefined),
      };
      const handleMessage = vi.fn(async (message) => {
        const queued = await message.reply(
          formatAgentProgressUpdate(
            {
              computerDisplayName: "Local Dev",
              workspaceDisplayName: "CodexDiscordConnector",
              cwd: "/repo",
              prompt: "샘플 보내줘",
            },
            {
              status: "답변 작성 중",
              latestMessage: "샘플을 정리합니다.",
              recentEvents: ["생각중..."],
            },
          ),
        );

        await queued?.edit(
          formatAgentResultUpdate(
            {
              computerDisplayName: "Local Dev",
              workspaceDisplayName: "CodexDiscordConnector",
              cwd: "/repo",
              prompt: "샘플 보내줘",
            },
            {
              result: {
                status: "completed",
                finalMessage: [
                  "우선 판단 가치가 높은 샘플을 보냅니다.",
                  "",
                  "```codex-discord-send",
                  JSON.stringify({
                    message: "검토 포인트입니다.",
                    files: [{ path: videoPath, name: "review.mp4" }],
                  }),
                  "```",
                ].join("\n"),
                sessionId: "session-1",
              },
            },
          ),
        );
      });
      const reply = vi.fn().mockResolvedValue(sentMessage);

      attachDiscordMessageHandler(client, handleMessage);
      handlers.get("messageCreate")?.({
        author: { bot: false, id: "discord-user-1" },
        channelId: "discord-channel-1",
        content: "샘플 보내줘",
        member: { roles: { cache: new Map([["role-operator", { id: "role-operator" }]]) } },
        reply,
        guild: null,
      });

      await vi.waitFor(() => expect(sentMessage.edit).toHaveBeenCalled());
      expect(sentMessage.edit).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("**Codex 작업 완료**"),
          embeds: [
            expect.objectContaining({
              description: expect.stringContaining("우선 판단 가치가 높은 샘플을 보냅니다."),
            }),
          ],
        }),
      );
      expect(sentMessage.edit.mock.calls[0]?.[0]?.files).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("acknowledges unknown buttons without dispatching a command", async () => {
    const handlers = new Map<string, (interaction: unknown) => void>();
    const client = {
      on: vi.fn((eventName: string, handler: (interaction: unknown) => void) => {
        handlers.set(eventName, handler);
        return client;
      }),
    };
    const handleMessage = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);

    attachDiscordInteractionHandler(client, handleMessage);
    handlers.get("interactionCreate")?.({
      isButton: () => true,
      customId: "unknown",
      user: { id: "discord-user-1" },
      channelId: "discord-channel-1",
      member: { roles: { cache: new Map() } },
      reply,
      guild: null,
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      allowedMentions: { parse: [] },
      ephemeral: true,
      content: "이 버튼은 더 이상 사용할 수 없습니다. `help`를 다시 눌러 최신 버튼을 열어주세요.",
    });
  });
});
