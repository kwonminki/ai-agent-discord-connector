import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Guild,
  type Message,
} from "discord.js";
import {
  AGENT_RELAY_PROMPT_ATTACHMENT_NAME,
  type AgentRelayStateMarker,
  type ConnectorPresence,
  formatConnectorPresenceMarker,
  localizeConnectorText,
  parseAgentRelayCancelMarker,
  parseConnectorDiscoveryMarker,
  parseAgentRelayRequestMarker,
  parseAgentRelayStateMarker,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";
import type { AnswerCopyStore } from "./answerCopyStore.js";
import type { ModelAutocompleteChoice } from "./modelAutocomplete.js";
import {
  DISCORD_APPLICATION_COMMANDS,
  isHarnessHelpInteraction,
  registerDiscordApplicationCommands,
  routeDiscordApplicationCommand,
} from "./applicationCommands.js";
import type { DiscordGuildSurface } from "./codexSessionSync.js";
import type { DiscordMessageLike } from "./messageHandler.js";
import {
  COMPONENT_IDS,
  parseAgentSurveyOtherCustomId,
  routeAgentSurveyOtherAnswer,
  routeDiscordComponent,
} from "./componentRouter.js";
import {
  CWD_PICKER_IDS,
  buildCwdPickerPayload,
  cwdPickerChildPath,
  cwdPickerHomePath,
  cwdPickerParentPath,
  isCwdPickerComponent,
  parseCwdPickerState,
} from "./cwdPicker.js";
import { localizeDiscordModal, localizeDiscordOutgoing } from "./i18n.js";
import { formatHarnessHelp } from "./harnessPrompts.js";
import {
  getAnswerCopyText,
  withRoleMentions,
  withAnswerCopyButton,
  type DiscordMessagePayload,
} from "./responses.js";

export { registerDiscordApplicationCommands };

interface DiscordMessageEventClient {
  on(eventName: "messageCreate", listener: (message: Message) => void): unknown;
}

interface DiscordInteractionEventClient {
  on(eventName: "interactionCreate", listener: (interaction: unknown) => void): unknown;
}

interface DiscordInteractionHandlerOptions {
  isManagedChannel?(channelId: string): boolean | Promise<boolean>;
  modelAutocomplete?(
    channelId: string,
    query: string,
  ): ModelAutocompleteChoice[] | Promise<ModelAutocompleteChoice[]>;
  harnessAutocomplete?(
    channelId: string,
    query: string,
  ): ModelAutocompleteChoice[] | Promise<ModelAutocompleteChoice[]>;
  answerCopyStore?: AnswerCopyStore;
  locale?: ConnectorLocale;
  // Enables the interactive cwd picker for /chat-new. Requires the bot to run
  // on the same machine as the workspaces (direct mode).
  cwdPicker?: boolean;
}

interface DiscordMessageHandlerOptions {
  answerCopyStore?: AnswerCopyStore;
  locale?: ConnectorLocale;
  trustedRelayBotUserIds?: string[];
  relayControlChannelId?: string;
  onRelayState?(state: AgentRelayStateMarker): Promise<void> | void;
  onConnectorDiscovery?(
    discoveryId: string,
    guild: DiscordGuildSurface | null,
  ): Promise<ConnectorPresence | null> | ConnectorPresence | null;
}

const MAX_RELAY_PROMPT_ATTACHMENT_BYTES = 1024 * 1024;

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

function getMemberRoleIds(member: unknown): string[] {
  const roles =
    typeof member === "object" && member !== null && "roles" in member
      ? (member as { roles?: unknown }).roles
      : null;

  if (Array.isArray(roles)) {
    return roles.filter((roleId): roleId is string => typeof roleId === "string");
  }

  if (typeof roles === "object" && roles !== null && "cache" in roles) {
    const cache = (roles as { cache?: unknown }).cache;

    if (cache instanceof Map) {
      return [...cache.keys()].filter((roleId): roleId is string => typeof roleId === "string");
    }
  }

  return [];
}

function getRoleIds(message: Message): string[] {
  return getMemberRoleIds(message.member);
}

interface EditableDiscordMessageLike {
  id: string;
  content?: string;
  edit?(message: unknown): Promise<unknown>;
}

interface InteractionReplySource {
  deferReply?(): Promise<unknown>;
  reply(message: unknown): Promise<unknown>;
  editReply?(message: unknown): Promise<unknown>;
  fetchReply?(): Promise<unknown>;
  followUp?(message: unknown): Promise<unknown>;
  channel?: {
    send?(message: unknown): Promise<unknown>;
  } | null;
}

interface ClearableDiscordChannelLike {
  messages?: {
    fetch(input: { limit: number }): Promise<{ size: number }>;
  };
  bulkDelete?(messages: unknown, filterOld?: boolean): Promise<{ size: number }>;
}

interface ThreadParentDiscordChannelLike {
  threads?: {
    create(input: {
      name: string;
      autoArchiveDuration?: number;
      reason?: string;
    }): Promise<{ id: string }>;
    fetchActive?(): Promise<unknown>;
    fetchArchived?(options?: { fetchAll?: boolean; type?: "public" | "private" }): Promise<unknown>;
  };
}

interface DiscordThreadLike {
  id: string;
  name?: string;
  parentId?: string | null;
  archived?: boolean | null;
  setArchived?(archived: boolean, reason?: string): Promise<unknown>;
}

function discordThreadsFrom(value: unknown): DiscordThreadLike[] {
  const collection =
    typeof value === "object" && value !== null && "threads" in value
      ? (value as { threads?: unknown }).threads
      : value;
  if (
    typeof collection !== "object" ||
    collection === null ||
    !("values" in collection) ||
    typeof (collection as { values?: unknown }).values !== "function"
  ) {
    return [];
  }

  return [...(collection as { values(): IterableIterator<unknown> }).values()].filter(
    (thread): thread is DiscordThreadLike =>
      typeof thread === "object" &&
      thread !== null &&
      typeof (thread as DiscordThreadLike).id === "string",
  );
}

function isUnknownDiscordChannelError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === 10_003 ||
      (error as { code?: unknown }).code === "Unknown Channel")
  );
}

async function clearChannelMessages(input: {
  guild: Guild | null;
  channelId: string;
  mode: "all" | "count";
  count?: number;
}): Promise<{ deletedCount: number; requestedCount?: number | null }> {
  if (!input.guild) {
    throw new Error("Discord guild context is required for message deletion.");
  }

  const channel = (await input.guild.channels.fetch(input.channelId)) as ClearableDiscordChannelLike | null;

  if (!channel?.messages || typeof channel.bulkDelete !== "function") {
    throw new Error("Discord channel does not support bulk message deletion.");
  }

  const requestedCount = input.mode === "count" ? Math.min(Math.max(input.count ?? 1, 1), 100) : null;
  let remaining = requestedCount ?? Number.POSITIVE_INFINITY;
  let deletedCount = 0;

  while (remaining > 0) {
    const limit = Math.min(remaining, 100);
    const messages = await channel.messages.fetch({ limit });

    if (messages.size === 0) {
      break;
    }

    const deleted = await channel.bulkDelete(messages, true);
    deletedCount += deleted.size;

    if (input.mode === "count") {
      break;
    }

    if (messages.size < 100 || deleted.size === 0) {
      break;
    }
  }

  return {
    deletedCount,
    requestedCount,
  };
}

function isEditableDiscordMessage(message: unknown): message is EditableDiscordMessageLike {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    typeof (message as { id?: unknown }).id === "string"
  );
}

async function prepareOutgoingMessage(
  content: string | DiscordMessagePayload,
  options?: { mentionRoleIds?: string[] },
  answerCopyStore?: AnswerCopyStore,
  locale: ConnectorLocale = "ko",
): Promise<string | DiscordMessagePayload> {
  const mentionRoleIds = options?.mentionRoleIds?.filter(Boolean) ?? [];
  let preparedContent = mentionRoleIds.length > 0 ? withRoleMentions(content, mentionRoleIds) : content;

  if (typeof preparedContent !== "string" && answerCopyStore) {
    const answer = getAnswerCopyText(preparedContent);

    if (answer) {
      try {
        const copyId = await answerCopyStore.save(answer);
        preparedContent = withAnswerCopyButton(preparedContent, copyId);
      } catch (error) {
        console.warn("discord-bot failed to cache an answer for copying", error);
      }
    }
  }

  return localizeDiscordOutgoing(preparedContent, locale);
}

export function createDiscordGuildSurface(
  guild: Guild | null,
  surfaceOptions: { answerCopyStore?: AnswerCopyStore; locale?: ConnectorLocale } = {},
): DiscordGuildSurface | null {
  if (!guild) {
    return null;
  }

  return {
    async createCategory(input) {
      const category = await guild.channels.create({
        name: input.name,
        type: ChannelType.GuildCategory,
      });

      return { id: category.id };
    },
    async createTextChannel(input) {
      const channel = await guild.channels.create({
        name: input.name,
        type: ChannelType.GuildText,
        parent: input.parentId ?? undefined,
        topic: input.topic,
      });

      return { id: channel.id };
    },
    async createThread(input) {
      const parentChannel = (await guild.channels.fetch(input.parentChannelId)) as ThreadParentDiscordChannelLike | null;

      if (typeof parentChannel?.threads?.create !== "function") {
        throw new Error("Discord channel cannot create threads.");
      }

      const thread = await parentChannel.threads.create({
        name: input.name,
        autoArchiveDuration: input.autoArchiveDuration,
        reason: input.reason?.slice(0, 512),
      });

      return { id: thread.id };
    },
    async findThreadByName(input) {
      const parentChannel = (await guild.channels.fetch(input.parentChannelId)) as ThreadParentDiscordChannelLike | null;
      const threadManager = parentChannel?.threads;
      if (!threadManager) {
        return null;
      }

      const candidates: DiscordThreadLike[] = [];
      if (typeof threadManager.fetchActive === "function") {
        candidates.push(...discordThreadsFrom(await threadManager.fetchActive()));
      }
      if (typeof threadManager.fetchArchived === "function") {
        candidates.push(...discordThreadsFrom(await threadManager.fetchArchived({
          type: "public",
          fetchAll: true,
        })));
      }
      const matchingThread = candidates.find(
        (thread) =>
          thread.name === input.name &&
          (!thread.parentId || thread.parentId === input.parentChannelId),
      );
      if (!matchingThread) {
        return null;
      }
      if (matchingThread.archived && typeof matchingThread.setArchived === "function") {
        await matchingThread.setArchived(false, "AI Agent Discord Connector release maintenance");
      }
      return { id: matchingThread.id };
    },
    async ensureChannelAvailable(id) {
      try {
        const channel = (await guild.channels.fetch(id)) as DiscordThreadLike | null;
        if (!channel) {
          return false;
        }
        if (channel.archived && typeof channel.setArchived === "function") {
          await channel.setArchived(false, "AI Agent Discord Connector release maintenance");
        }
        return true;
      } catch (error) {
        if (isUnknownDiscordChannelError(error)) {
          return false;
        }
        throw error;
      }
    },
    async sendTextMessage(channelId, content, options) {
      const channel = await guild.channels.fetch(channelId);
      const sender = channel as { send?: (message: string | DiscordMessagePayload) => Promise<unknown> } | null;
      if (typeof sender?.send !== "function") {
        throw new Error("Discord channel cannot receive text messages.");
      }

      const preparedContent = await prepareOutgoingMessage(
        content,
        options,
        surfaceOptions.answerCopyStore,
        surfaceOptions.locale,
      );
      const sentMessage = await sender.send(preparedContent);
      return isEditableDiscordMessage(sentMessage) ? { id: sentMessage.id } : undefined;
    },
    async editTextMessage(channelId, messageId, content) {
      const channel = await guild.channels.fetch(channelId);
      const messages =
        typeof channel === "object" && channel !== null && "messages" in channel
          ? (channel as { messages?: { fetch?(id: string): Promise<unknown> } }).messages
          : null;
      const message = await messages?.fetch?.(messageId);

      if (!isEditableDiscordMessage(message) || typeof message.edit !== "function") {
        throw new Error("Discord message cannot be edited.");
      }

      const preparedContent = await prepareOutgoingMessage(
        content,
        undefined,
        surfaceOptions.answerCopyStore,
        surfaceOptions.locale,
      );
      const editedMessage = await message.edit(preparedContent);
      return isEditableDiscordMessage(editedMessage) ? { id: editedMessage.id } : { id: message.id };
    },
    async deleteChannel(id) {
      const channel = await guild.channels.fetch(id);
      await channel?.delete();
    },
    async deleteCategory(id) {
      const category = await guild.channels.fetch(id);
      await category?.delete();
    },
  };
}

export function attachDiscordMessageHandler(
  client: DiscordMessageEventClient,
  handleMessage: (message: DiscordMessageLike) => Promise<void>,
  options: DiscordMessageHandlerOptions = {},
): void {
  const trustedRelayBotUserIds = new Set(options.trustedRelayBotUserIds?.filter(Boolean) ?? []);

  client.on("messageCreate", (message) => {
    const discordMessage = message as Message;

    // Discord system messages (channel renames, pins, thread events, ...) are
    // not user prompts and must never reach an agent session.
    if (discordMessage.system) {
      return;
    }

    const rawAttachments = discordMessage.attachments
      ? [...discordMessage.attachments.values()].map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          url: attachment.url,
          contentType: attachment.contentType,
          size: attachment.size,
        }))
      : [];

    void (async () => {
      const trustedRelayBot = discordMessage.author.bot && trustedRelayBotUserIds.has(discordMessage.author.id);
      const relayControlMessage = trustedRelayBot && discordMessage.channelId === options.relayControlChannelId;
      const relayTargetThreadId = relayControlMessage
        ? parseAgentRelayRequestMarker(discordMessage.content)
        : null;
      const relayCancellation = relayControlMessage
        ? parseAgentRelayCancelMarker(discordMessage.content)
        : null;
      const relayState = relayControlMessage
        ? parseAgentRelayStateMarker(discordMessage.content)
        : null;
      const connectorDiscoveryId = relayControlMessage
        ? parseConnectorDiscoveryMarker(discordMessage.content)
        : null;
      if (relayState) {
        await options.onRelayState?.(relayState);
        return;
      }
      if (connectorDiscoveryId) {
        const presence = await options.onConnectorDiscovery?.(
          connectorDiscoveryId,
          createDiscordGuildSurface(discordMessage.guild, options),
        );
        if (presence) {
          await discordMessage.reply({
            content: formatConnectorPresenceMarker(presence),
            allowedMentions: { parse: [] },
          });
        }
        return;
      }
      let content = discordMessage.content;
      let attachments = rawAttachments;

      if (relayTargetThreadId) {
        const promptAttachment = rawAttachments.find(
          (attachment) => attachment.name === AGENT_RELAY_PROMPT_ATTACHMENT_NAME,
        );
        if (!promptAttachment || promptAttachment.size > MAX_RELAY_PROMPT_ATTACHMENT_BYTES) {
          throw new Error("Agent relay control request has no valid prompt attachment.");
        }
        const response = await fetch(promptAttachment.url);
        if (!response.ok) {
          throw new Error(`Agent relay prompt download failed with HTTP ${response.status}.`);
        }
        const promptBytes = Buffer.from(await response.arrayBuffer());
        if (promptBytes.byteLength > MAX_RELAY_PROMPT_ATTACHMENT_BYTES) {
          throw new Error("Agent relay prompt attachment exceeded 1MiB.");
        }
        content = promptBytes.toString("utf8");
        attachments = rawAttachments.filter((attachment) => attachment.id !== promptAttachment.id);
      } else if (relayCancellation) {
        content = "interrupt";
        attachments = [];
      }

      await handleMessage({
        authorBot: discordMessage.author.bot,
        ...(relayTargetThreadId || relayCancellation ? { relayRequest: true } : {}),
        ...(relayCancellation
          ? { relayCancelRequestId: relayCancellation.requestMessageId }
          : {}),
        userId: discordMessage.author.id,
        channelId:
          relayTargetThreadId ??
          relayCancellation?.targetThreadId ??
          discordMessage.channelId,
        content,
        roleIds: getRoleIds(discordMessage),
        ...(discordMessage.id ? { messageId: discordMessage.id } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        guild: createDiscordGuildSurface(discordMessage.guild, options),
        clearMessages: (clearInput) =>
          clearChannelMessages({
            guild: discordMessage.guild,
            channelId:
              relayTargetThreadId ??
              relayCancellation?.targetThreadId ??
              discordMessage.channelId,
            ...clearInput,
          }),
        reply: async (replyMessage) => {
          const preparedReply = await prepareOutgoingMessage(
            replyMessage,
            undefined,
            options.answerCopyStore,
            options.locale,
          );
          const sentMessage = await discordMessage.reply(preparedReply);

          if (!isEditableDiscordMessage(sentMessage) || typeof sentMessage.edit !== "function") {
            return sentMessage;
          }

          return {
            edit: async (nextMessage) => {
              const preparedMessage = await prepareOutgoingMessage(
                nextMessage,
                undefined,
                options.answerCopyStore,
                options.locale,
              );
              return sentMessage.edit(preparedMessage);
            },
          };
        },
      });
    })().catch((error) => {
      console.error("discord-bot failed to handle message", error);
    });
  });
}

function isButtonInteraction(interaction: unknown): interaction is {
  isButton(): boolean;
  isStringSelectMenu?(): boolean;
  customId: string;
  values?: string[];
  user: { id: string };
  channelId: string;
  member?: unknown;
  guild: Guild | null;
  message?: EditableDiscordMessageLike;
  reply(message: unknown): Promise<unknown>;
  editReply?(message: unknown): Promise<unknown>;
  fetchReply?(): Promise<unknown>;
  followUp?(message: unknown): Promise<unknown>;
  channel?: { send?(message: unknown): Promise<unknown> } | null;
  update?(message: unknown): Promise<unknown>;
  showModal?(modal: unknown): Promise<unknown>;
} {
  return (
    typeof interaction === "object" &&
    interaction !== null &&
    "isButton" in interaction &&
    typeof (interaction as { isButton?: unknown }).isButton === "function" &&
    "customId" in interaction &&
    typeof (interaction as { customId?: unknown }).customId === "string"
  );
}

function isSupportedComponentInteraction(interaction: unknown): interaction is {
  isButton(): boolean;
  isStringSelectMenu?(): boolean;
  customId: string;
  values?: string[];
  user: { id: string };
  channelId: string;
  member?: unknown;
  guild: Guild | null;
  message?: EditableDiscordMessageLike;
  reply(message: unknown): Promise<unknown>;
  editReply?(message: unknown): Promise<unknown>;
  fetchReply?(): Promise<unknown>;
  followUp?(message: unknown): Promise<unknown>;
  channel?: { send?(message: unknown): Promise<unknown> } | null;
  update?(message: unknown): Promise<unknown>;
  showModal?(modal: unknown): Promise<unknown>;
} {
  if (!isButtonInteraction(interaction)) {
    return false;
  }

  if (interaction.isButton()) {
    return true;
  }

  return typeof interaction.isStringSelectMenu === "function" && interaction.isStringSelectMenu();
}

function isModalSubmitInteraction(interaction: unknown): interaction is {
  isModalSubmit(): boolean;
  customId: string;
  user: { id: string };
  channelId: string;
  member?: unknown;
  guild: Guild | null;
  reply(message: unknown): Promise<unknown>;
  editReply?(message: unknown): Promise<unknown>;
  fetchReply?(): Promise<unknown>;
  followUp?(message: unknown): Promise<unknown>;
  channel?: { send?(message: unknown): Promise<unknown> } | null;
  fields: { getTextInputValue(fieldId: string): string };
} {
  return (
    typeof interaction === "object" &&
    interaction !== null &&
    "isModalSubmit" in interaction &&
    typeof (interaction as { isModalSubmit?: unknown }).isModalSubmit === "function" &&
    "customId" in interaction &&
    typeof (interaction as { customId?: unknown }).customId === "string"
  );
}

function isChatInputCommandInteraction(interaction: unknown): interaction is {
  isChatInputCommand(): boolean;
  commandName: string;
  user: { id: string };
  channelId: string;
  member?: unknown;
  guild: Guild | null;
  deferReply?(): Promise<unknown>;
  reply(message: unknown): Promise<unknown>;
  editReply?(message: unknown): Promise<unknown>;
  fetchReply?(): Promise<unknown>;
  followUp?(message: unknown): Promise<unknown>;
  channel?: { send?(message: unknown): Promise<unknown> } | null;
  options: {
    getString(name: string, required?: boolean): string | null;
    getInteger?(name: string, required?: boolean): number | null;
    getBoolean?(name: string, required?: boolean): boolean | null;
    getSubcommand?(required?: boolean): string | null;
  };
} {
  return (
    typeof interaction === "object" &&
    interaction !== null &&
    "isChatInputCommand" in interaction &&
    typeof (interaction as { isChatInputCommand?: unknown }).isChatInputCommand === "function" &&
    "commandName" in interaction &&
    typeof (interaction as { commandName?: unknown }).commandName === "string" &&
    "options" in interaction &&
    typeof (interaction as { options?: unknown }).options === "object" &&
    (interaction as { options?: unknown }).options !== null
  );
}

function isAutocompleteInteraction(interaction: unknown): interaction is {
  isAutocomplete(): boolean;
  commandName: string;
  channelId: string;
  options: {
    getFocused(required?: boolean): string | { name: string; value: string | number };
  };
  respond(choices: ModelAutocompleteChoice[]): Promise<unknown>;
} {
  return (
    typeof interaction === "object" &&
    interaction !== null &&
    "isAutocomplete" in interaction &&
    typeof (interaction as { isAutocomplete?: unknown }).isAutocomplete === "function" &&
    "commandName" in interaction &&
    typeof (interaction as { commandName?: unknown }).commandName === "string" &&
    "options" in interaction &&
    typeof (interaction as { options?: unknown }).options === "object" &&
    (interaction as { options?: unknown }).options !== null &&
    "respond" in interaction &&
    typeof (interaction as { respond?: unknown }).respond === "function"
  );
}

function codexPromptModal() {
  return {
    title: "Codex에게 요청",
    custom_id: COMPONENT_IDS.codexSubmit,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "prompt",
            label: "요청 내용",
            style: 2,
            required: true,
            min_length: 1,
            max_length: 2_000,
            placeholder: "예: README 요약해줘 / 테스트 실패 고쳐줘",
          },
        ],
      },
    ],
  };
}

function agentSurveyOtherModal(customId: string) {
  return {
    title: "기타 답변",
    custom_id: customId,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "answer",
            label: "자유 답변",
            style: 2,
            required: true,
            max_length: 4_000,
            placeholder: "선택지에 없는 답변을 입력하세요.",
          },
        ],
      },
    ],
  };
}

function codexContinueModal(sessionId: string) {
  return {
    title: "완료된 작업에 답장",
    custom_id: `cdc:codex:continue:submit:${sessionId}`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "prompt",
            label: "이어 할 요청",
            style: 2,
            required: true,
            min_length: 1,
            max_length: 2_000,
            placeholder: "예: 방금 수정한 내용 테스트까지 돌려줘",
          },
        ],
      },
    ],
  };
}

const ANSWER_COPY_MODAL_PREFIX = "cdc:answer:copy:modal:";
const MAX_ANSWER_COPY_MODAL_LENGTH = 4_000;

function answerCopyModal(answer: string, copyId: string) {
  return {
    title: "답변 복사",
    custom_id: `${ANSWER_COPY_MODAL_PREFIX}${copyId}`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: `answer-${copyId}`,
            label: "전체 선택 후 복사",
            style: 2,
            required: false,
            max_length: MAX_ANSWER_COPY_MODAL_LENGTH,
            value: answer,
          },
        ],
      },
    ],
  };
}

function parseAnswerCopyButton(customId: string): string | null {
  if (!customId.startsWith(COMPONENT_IDS.answerCopyPrefix)) {
    return null;
  }

  const copyId = customId.slice(COMPONENT_IDS.answerCopyPrefix.length).toLowerCase();
  return /^[a-f0-9]{32}$/.test(copyId) ? copyId : null;
}

function parseAnswerCopyModal(customId: string): string | null {
  if (!customId.startsWith(ANSWER_COPY_MODAL_PREFIX)) {
    return null;
  }

  const copyId = customId.slice(ANSWER_COPY_MODAL_PREFIX.length).toLowerCase();
  return /^[a-f0-9]{32}$/.test(copyId) ? copyId : null;
}

function parseCodexContinueButton(customId: string): string | null {
  const match = customId.match(/^cdc:codex:continue:([0-9a-f-]{32,36})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseCodexContinueSubmit(customId: string): string | null {
  const match = customId.match(/^cdc:codex:continue:submit:([0-9a-f-]{32,36})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function encodedCodexContinueCommand(input: {
  sessionId: string;
  prompt: string;
}): string {
  return `__cdc_codex_continue ${encodeURIComponent(JSON.stringify(input))}`;
}

function encodedNewChatCommand(input: {
  name: string | null;
  cwd: string | null;
  useCategory: boolean;
  initialPrompt: string | null;
}): string {
  return `__cdc_new_chat ${encodeURIComponent(JSON.stringify(input))}`;
}

interface CwdPickerInteractionLike {
  customId: string;
  values?: string[];
  user: { id: string };
  channelId: string;
  member?: unknown;
  guild: Guild | null;
  message?: EditableDiscordMessageLike;
  reply(message: unknown): Promise<unknown>;
  editReply?(message: unknown): Promise<unknown>;
  fetchReply?(): Promise<unknown>;
  followUp?(message: unknown): Promise<unknown>;
  channel?: { send?(message: unknown): Promise<unknown> } | null;
  update?(message: unknown): Promise<unknown>;
}

async function handleCwdPickerInteraction(
  componentInteraction: CwdPickerInteractionLike,
  handleMessage: (message: DiscordMessageLike) => Promise<void>,
  options: DiscordInteractionHandlerOptions,
  locale: ConnectorLocale,
): Promise<void> {
  const respondEphemeral = async (content: string) => {
    await componentInteraction.reply({
      allowedMentions: { parse: [] },
      ephemeral: true,
      content: localizeConnectorText(content, locale),
    }).catch((error) => {
      console.warn("discord-bot failed to send a cwd picker notice", error);
    });
  };

  if (!options.cwdPicker) {
    await respondEphemeral("폴더 찾아보기는 direct 모드에서만 사용할 수 있습니다. cwd 옵션에 경로를 직접 입력해주세요.");
    return;
  }

  const customId = componentInteraction.customId;

  if (customId === CWD_PICKER_IDS.open) {
    await componentInteraction.reply(await buildCwdPickerPayload({ path: cwdPickerHomePath() }));
    return;
  }

  if (typeof componentInteraction.update !== "function") {
    await respondEphemeral("이 Discord 클라이언트는 메시지 갱신을 지원하지 않습니다.");
    return;
  }

  const state = parseCwdPickerState(componentInteraction.message?.content);

  if (!state) {
    await respondEphemeral("폴더 선택 상태를 읽을 수 없습니다. /chat-new location:browse로 다시 열어주세요.");
    return;
  }

  if (customId === CWD_PICKER_IDS.cancel) {
    await componentInteraction.update({
      allowedMentions: { parse: [] },
      content: localizeConnectorText("폴더 선택을 취소했습니다.", locale),
      embeds: [],
      components: [],
    });
    return;
  }

  if (customId === CWD_PICKER_IDS.confirm) {
    await componentInteraction.update({
      allowedMentions: { parse: [] },
      content: localizeConnectorText(`📁 \`${state.path}\` 폴더로 새 채팅을 만드는 중...`, locale),
      embeds: [],
      components: [],
    });
    await handleMessage({
      authorBot: false,
      userId: componentInteraction.user.id,
      channelId: componentInteraction.channelId,
      content: encodedNewChatCommand({
        name: state.name,
        cwd: state.path,
        useCategory: true,
        initialPrompt: state.prompt,
      }),
      roleIds: getMemberRoleIds(componentInteraction.member),
      guild: createDiscordGuildSurface(componentInteraction.guild, options),
      reply: interactionReplyAdapter(componentInteraction, {
        initialReplySent: true,
        answerCopyStore: options.answerCopyStore,
        locale,
      }),
    });
    return;
  }

  let nextPath = state.path;
  let nextPage = state.page;

  if (customId === CWD_PICKER_IDS.up) {
    nextPath = cwdPickerParentPath(state.path);
    nextPage = 1;
  } else if (customId === CWD_PICKER_IDS.home) {
    nextPath = cwdPickerHomePath();
    nextPage = 1;
  } else if (customId === CWD_PICKER_IDS.enter) {
    const selected = componentInteraction.values?.[0]?.trim();

    if (!selected) {
      return;
    }

    nextPath = cwdPickerChildPath(state.path, selected);
    nextPage = 1;
  } else if (customId === CWD_PICKER_IDS.pagePrev) {
    nextPage = Math.max(1, state.page - 1);
  } else if (customId === CWD_PICKER_IDS.pageNext) {
    nextPage = state.page + 1;
  } else {
    await respondEphemeral("지원하지 않는 폴더 선택 동작입니다.");
    return;
  }

  await componentInteraction.update(await buildCwdPickerPayload({
    path: nextPath,
    page: nextPage,
    name: state.name,
    prompt: state.prompt,
  }));
}

function newChatModal(kind: "general" | "current") {
  return {
    title: kind === "current" ? "현재 폴더에서 새 채팅" : "새 일반 채팅",
    custom_id: kind === "current" ? "cdc:chat:submit:current" : "cdc:chat:submit:general",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "name",
            label: "채널 이름",
            style: 1,
            required: false,
            max_length: 90,
            placeholder: kind === "current" ? "예: 지금 폴더 작업" : "예: 자유 메모",
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "prompt",
            label: "첫 요청",
            style: 2,
            required: false,
            max_length: 2_000,
            placeholder: "비워두면 채널만 만들고, 새 채널에서 직접 요청할 수 있습니다.",
          },
        ],
      },
    ],
  };
}

function forkSessionModal() {
  return {
    title: "새 fork 스레드",
    custom_id: "cdc:fork:submit",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "name",
            label: "스레드 이름",
            style: 1,
            required: true,
            min_length: 1,
            max_length: 90,
            placeholder: "예: 실험 브랜치 / 다른 접근 테스트",
          },
        ],
      },
    ],
  };
}

function encodedForkSessionCommand(input: { name: string }): string {
  return `__cdc_fork_session ${encodeURIComponent(JSON.stringify(input))}`;
}

function isNewChatButton(customId: string): customId is
  | typeof COMPONENT_IDS.newGeneralChat
  | typeof COMPONENT_IDS.newCurrentFolderChat
  | typeof COMPONENT_IDS.newHereChat {
  return (
    customId === COMPONENT_IDS.newGeneralChat ||
    customId === COMPONENT_IDS.newCurrentFolderChat ||
    customId === COMPONENT_IDS.newHereChat
  );
}

function isNewChatSubmit(customId: string): customId is "cdc:chat:submit:general" | "cdc:chat:submit:current" {
  return customId === "cdc:chat:submit:general" || customId === "cdc:chat:submit:current";
}

async function fetchInteractionReply(interaction: { fetchReply?(): Promise<unknown> }): Promise<unknown> {
  if (typeof interaction.fetchReply !== "function") {
    return null;
  }

  try {
    return await interaction.fetchReply();
  } catch {
    return null;
  }
}

function interactionReplyAdapter(
  interaction: InteractionReplySource,
  options: {
    initialReplyDeferred?: boolean;
    initialReplySent?: boolean;
    answerCopyStore?: AnswerCopyStore;
    locale?: ConnectorLocale;
  } = {},
) {
  let hasInitialReply = options.initialReplySent ?? false;

  const prepareReply = async (message: unknown): Promise<unknown> => {
    if (
      typeof message !== "string" &&
      (typeof message !== "object" || message === null || !("embeds" in message))
    ) {
      return message;
    }

    return prepareOutgoingMessage(
      message as string | DiscordMessagePayload,
      undefined,
      options.answerCopyStore,
      options.locale,
    );
  };

  return async (replyMessage: unknown) => {
    const preparedReply = await prepareReply(replyMessage);

    if (options.initialReplyDeferred && !hasInitialReply) {
      const editedInitialMessage =
        typeof interaction.editReply === "function" ? await interaction.editReply(preparedReply) : null;
      hasInitialReply = true;
      const initialMessage = isEditableDiscordMessage(editedInitialMessage)
        ? editedInitialMessage
        : await fetchInteractionReply(interaction);

      if (!isEditableDiscordMessage(initialMessage) || typeof interaction.editReply !== "function") {
        return undefined;
      }

      return {
        edit: async (nextMessage: unknown) => {
          return interaction.editReply?.(await prepareReply(nextMessage));
        },
      };
    }

    if (hasInitialReply) {
      const sentMessage =
        typeof interaction.channel?.send === "function"
          ? await interaction.channel.send(preparedReply)
          : typeof interaction.followUp === "function"
            ? await interaction.followUp(preparedReply)
            : null;

      if (!isEditableDiscordMessage(sentMessage) || typeof sentMessage.edit !== "function") {
        return undefined;
      }

      return {
        edit: async (nextMessage: unknown) => {
          return sentMessage.edit?.(await prepareReply(nextMessage));
        },
      };
    }

    await interaction.reply(preparedReply);
    hasInitialReply = true;
    const initialMessage = await fetchInteractionReply(interaction);

    if (!isEditableDiscordMessage(initialMessage) || typeof interaction.editReply !== "function") {
      return undefined;
    }

    return {
      edit: async (nextMessage: unknown) => {
        return interaction.editReply?.(await prepareReply(nextMessage));
      },
    };
  };
}

async function shouldHandleInteractionChannel(
  channelId: string,
  options: DiscordInteractionHandlerOptions,
): Promise<boolean> {
  if (!options.isManagedChannel) {
    return true;
  }

  try {
    return Boolean(await options.isManagedChannel(channelId));
  } catch (error) {
    console.error("discord-bot failed to check interaction channel ownership", error);
    return false;
  }
}

export function attachDiscordInteractionHandler(
  client: DiscordInteractionEventClient,
  handleMessage: (message: DiscordMessageLike) => Promise<void>,
  options: DiscordInteractionHandlerOptions = {},
): void {
  const locale = options.locale ?? "ko";

  client.on("interactionCreate", (interaction) => {
    if (isAutocompleteInteraction(interaction) && interaction.isAutocomplete()) {
      void (async () => {
        if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
          return;
        }

        const focused = interaction.options.getFocused(true);
        if (typeof focused === "string") {
          await interaction.respond([]);
          return;
        }

        const commandName = interaction.commandName.toLowerCase();
        const choices = commandName === "model" && focused.name === "model"
          ? await options.modelAutocomplete?.(interaction.channelId, String(focused.value)) ?? []
          : commandName === "harness" && focused.name === "harness"
            ? await options.harnessAutocomplete?.(interaction.channelId, String(focused.value)) ?? []
            : [];
        await interaction.respond(choices.slice(0, 25));
      })().catch((error) => {
        console.error("discord-bot failed to handle slash command autocomplete", error);
        void interaction.respond([]).catch(() => undefined);
      });
      return;
    }

    if (isChatInputCommandInteraction(interaction) && interaction.isChatInputCommand()) {
      void (async () => {
        if (isHarnessHelpInteraction(interaction)) {
          await interaction.reply({
            allowedMentions: { parse: [] },
            content: formatHarnessHelp(locale),
          });
          return;
        }

        if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
          return;
        }

        const commandName = interaction.commandName.trim() || "(empty)";

        if (commandName.toLowerCase() === "fork") {
          const showModal = (interaction as { showModal?: (modal: unknown) => Promise<unknown> }).showModal;

          if (typeof showModal !== "function") {
            await interaction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText("이 Discord 클라이언트는 모달을 열 수 없습니다.", locale),
            });
            return;
          }

          await showModal.call(interaction, localizeDiscordModal(forkSessionModal(), locale));
          return;
        }

        const deferReply = interaction.deferReply;
        const initialReplyDeferred = typeof deferReply === "function";

        if (initialReplyDeferred) {
          await deferReply.call(interaction);
        }

        if (
          commandName.toLowerCase() === "chat-new" &&
          (interaction.options.getString("location")?.trim().toLowerCase() ?? "") === "browse"
        ) {
          const pickerPayload = options.cwdPicker
            ? await buildCwdPickerPayload({
                path: cwdPickerHomePath(),
                name: interaction.options.getString("name")?.trim() || null,
                prompt: interaction.options.getString("prompt")?.trim() || null,
              })
            : {
                allowedMentions: { parse: [] },
                content: localizeConnectorText(
                  "폴더 찾아보기는 direct 모드에서만 사용할 수 있습니다. cwd 옵션에 경로를 직접 입력해주세요.",
                  locale,
                ),
              };

          if (initialReplyDeferred && typeof interaction.editReply === "function") {
            await interaction.editReply(pickerPayload);
          } else {
            await interaction.reply(pickerPayload);
          }
          return;
        }

        const content = routeDiscordApplicationCommand(interaction, locale);

        if (!content) {
          console.warn("discord-bot received unhandled slash command", {
            commandName,
            knownCommands: DISCORD_APPLICATION_COMMANDS.map((command) => command.name),
          });

          const fallback = {
            allowedMentions: { parse: [] },
            content: localizeConnectorText(
              `이 slash command는 아직 연결되어 있지 않습니다: /${commandName}`,
              locale,
            ),
          };

          if (initialReplyDeferred && typeof interaction.editReply === "function") {
            await interaction.editReply(fallback);
          } else {
            await interaction.reply({ ...fallback, ephemeral: true });
          }
          return;
        }

        await handleMessage({
          authorBot: false,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          content,
          roleIds: getMemberRoleIds(interaction.member),
          guild: createDiscordGuildSurface(interaction.guild, options),
          clearMessages: (clearInput) =>
            clearChannelMessages({
              guild: interaction.guild,
              channelId: interaction.channelId,
              ...clearInput,
            }),
          reply: interactionReplyAdapter(interaction, {
            initialReplyDeferred,
            answerCopyStore: options.answerCopyStore,
            locale,
          }),
        });
      })().catch((error) => {
        console.error("discord-bot failed to handle slash command", error);
      });
      return;
    }

    if (
      isModalSubmitInteraction(interaction) &&
      interaction.isModalSubmit() &&
      parseAnswerCopyModal(interaction.customId)
    ) {
      void interaction.reply({
        allowedMentions: { parse: [] },
        ephemeral: true,
        content: localizeConnectorText("복사용 창을 닫았습니다.", locale),
      }).catch((error) => {
        console.error("discord-bot failed to close the answer copy modal", error);
      });
      return;
    }

    if (isModalSubmitInteraction(interaction) && interaction.isModalSubmit()) {
      const surveyTarget = parseAgentSurveyOtherCustomId(interaction.customId);

      if (surveyTarget) {
        void (async () => {
          if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
            return;
          }

          const content = routeAgentSurveyOtherAnswer(
            surveyTarget,
            interaction.fields.getTextInputValue("answer"),
          );
          if (!content) {
            await interaction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText("자유 답변이 비어 있습니다.", locale),
            });
            return;
          }

          const queuedAgentSurvey = surveyTarget.kind === "agent";
          if (queuedAgentSurvey) {
            await interaction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText(
                "자유 답변을 접수했습니다. 같은 agent 세션의 다음 작업으로 전달합니다.",
                locale,
              ),
            });
          }

          await handleMessage({
            authorBot: false,
            userId: interaction.user.id,
            channelId: interaction.channelId,
            content,
            roleIds: getMemberRoleIds(interaction.member),
            guild: createDiscordGuildSurface(interaction.guild, options),
            reply: interactionReplyAdapter(interaction, {
              initialReplySent: queuedAgentSurvey,
              answerCopyStore: options.answerCopyStore,
              locale,
            }),
          });
        })().catch((error) => {
          console.error("discord-bot failed to handle survey free-text answer", error);
        });
        return;
      }
    }

    if (
      isModalSubmitInteraction(interaction) &&
      interaction.isModalSubmit() &&
      interaction.customId === COMPONENT_IDS.codexSubmit
    ) {
      void (async () => {
        if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
          return;
        }

        const prompt = interaction.fields.getTextInputValue("prompt").trim();

        if (prompt.length === 0) {
          await interaction.reply({
            allowedMentions: { parse: [] },
            ephemeral: true,
            content: localizeConnectorText("요청 내용이 비어 있습니다.", locale),
          });
          return;
        }

        await handleMessage({
          authorBot: false,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          content: `codex ${prompt}`,
          roleIds: getMemberRoleIds(interaction.member),
          guild: createDiscordGuildSurface(interaction.guild, options),
          reply: interactionReplyAdapter(interaction, {
            answerCopyStore: options.answerCopyStore,
            locale,
          }),
        });
      })().catch((error) => {
        console.error("discord-bot failed to handle Codex modal submit", error);
      });
      return;
    }

    if (isModalSubmitInteraction(interaction) && interaction.isModalSubmit()) {
      const continueSessionId = parseCodexContinueSubmit(interaction.customId);

      if (continueSessionId) {
        void (async () => {
          if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
            return;
          }

          const prompt = interaction.fields.getTextInputValue("prompt").trim();

          if (prompt.length === 0) {
            await interaction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText("요청 내용이 비어 있습니다.", locale),
            });
            return;
          }

          await handleMessage({
            authorBot: false,
            userId: interaction.user.id,
            channelId: interaction.channelId,
            content: encodedCodexContinueCommand({
              sessionId: continueSessionId,
              prompt,
            }),
            roleIds: getMemberRoleIds(interaction.member),
            guild: createDiscordGuildSurface(interaction.guild, options),
            reply: interactionReplyAdapter(interaction, {
              answerCopyStore: options.answerCopyStore,
              locale,
            }),
          });
        })().catch((error) => {
          console.error("discord-bot failed to handle Codex continue modal submit", error);
        });
        return;
      }
    }

    if (isModalSubmitInteraction(interaction) && interaction.isModalSubmit() && isNewChatSubmit(interaction.customId)) {
      void (async () => {
        if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
          return;
        }

        const name = interaction.fields.getTextInputValue("name").trim() || null;
        const initialPrompt = interaction.fields.getTextInputValue("prompt").trim() || null;
        const isCurrent = interaction.customId === "cdc:chat:submit:current";

        await handleMessage({
          authorBot: false,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          content: encodedNewChatCommand({
            name,
            cwd: isCurrent ? "." : null,
            useCategory: isCurrent,
            initialPrompt,
          }),
          roleIds: getMemberRoleIds(interaction.member),
          guild: createDiscordGuildSurface(interaction.guild, options),
          reply: interactionReplyAdapter(interaction, {
            answerCopyStore: options.answerCopyStore,
            locale,
          }),
        });
      })().catch((error) => {
        console.error("discord-bot failed to handle new chat modal submit", error);
      });
      return;
    }

    if (isModalSubmitInteraction(interaction) && interaction.isModalSubmit() && interaction.customId === "cdc:fork:submit") {
      void (async () => {
        if (options.isManagedChannel && !(await shouldHandleInteractionChannel(interaction.channelId, options))) {
          return;
        }

        const name = interaction.fields.getTextInputValue("name").trim();

        if (name.length === 0) {
          await interaction.reply({
            allowedMentions: { parse: [] },
            ephemeral: true,
            content: localizeConnectorText("스레드 이름이 비어 있습니다.", locale),
          });
          return;
        }

        await handleMessage({
          authorBot: false,
          userId: interaction.user.id,
          channelId: interaction.channelId,
          content: encodedForkSessionCommand({ name }),
          roleIds: getMemberRoleIds(interaction.member),
          guild: createDiscordGuildSurface(interaction.guild, options),
          reply: interactionReplyAdapter(interaction, {
            answerCopyStore: options.answerCopyStore,
            locale,
          }),
        });
      })().catch((error) => {
        console.error("discord-bot failed to handle fork modal submit", error);
      });
      return;
    }

    if (!isSupportedComponentInteraction(interaction)) {
      return;
    }

    const componentInteraction = interaction;

    void (async () => {
      if (options.isManagedChannel && !(await shouldHandleInteractionChannel(componentInteraction.channelId, options))) {
        return;
      }

      if (componentInteraction.isButton()) {
        const surveyTarget = parseAgentSurveyOtherCustomId(componentInteraction.customId);

        if (surveyTarget) {
          if (typeof componentInteraction.showModal !== "function") {
            await componentInteraction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText("이 Discord 클라이언트는 모달을 열 수 없습니다.", locale),
            });
            return;
          }

          await componentInteraction.showModal(
            localizeDiscordModal(
              agentSurveyOtherModal(componentInteraction.customId),
              locale,
            ),
          );
          return;
        }

        const answerCopyId = parseAnswerCopyButton(componentInteraction.customId);

        if (answerCopyId) {
          const answer = await options.answerCopyStore?.read(answerCopyId);

          if (!answer) {
            await componentInteraction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText(
                "복사용 답변이 만료되었거나 이 봇 인스턴스에 없습니다.",
                locale,
              ),
            });
            return;
          }

          if (answer.length <= MAX_ANSWER_COPY_MODAL_LENGTH && typeof componentInteraction.showModal === "function") {
            await componentInteraction.showModal(
              localizeDiscordModal(answerCopyModal(answer, answerCopyId), locale),
            );
            return;
          }

          await componentInteraction.reply({
            allowedMentions: { parse: [] },
            ephemeral: true,
            content: localizeConnectorText(
              "답변이 길어서 전체 원문을 텍스트 파일로 준비했습니다.",
              locale,
            ),
            files: [{ attachment: Buffer.from(answer, "utf8"), name: "answer.txt" }],
          });
          return;
        }

        const continueSessionId = parseCodexContinueButton(componentInteraction.customId);

        if (continueSessionId) {
          if (typeof componentInteraction.showModal !== "function") {
            await componentInteraction.reply({
              allowedMentions: { parse: [] },
              ephemeral: true,
              content: localizeConnectorText("이 Discord 클라이언트는 모달을 열 수 없습니다.", locale),
            });
            return;
          }

          await componentInteraction.showModal(
            localizeDiscordModal(codexContinueModal(continueSessionId), locale),
          );
          return;
        }
      }

      if (componentInteraction.isButton() && componentInteraction.customId === COMPONENT_IDS.codexAsk) {
        if (typeof componentInteraction.showModal !== "function") {
          await componentInteraction.reply({
            allowedMentions: { parse: [] },
            ephemeral: true,
            content: localizeConnectorText("이 Discord 클라이언트는 모달을 열 수 없습니다.", locale),
          });
          return;
        }

        await componentInteraction.showModal(localizeDiscordModal(codexPromptModal(), locale));
        return;
      }

      if (componentInteraction.isButton() && isNewChatButton(componentInteraction.customId)) {
        if (typeof componentInteraction.showModal !== "function") {
          await componentInteraction.reply({
            allowedMentions: { parse: [] },
            ephemeral: true,
            content: localizeConnectorText("이 Discord 클라이언트는 모달을 열 수 없습니다.", locale),
          });
          return;
        }

        const kind = componentInteraction.customId === COMPONENT_IDS.newGeneralChat ? "general" : "current";
        await componentInteraction.showModal(localizeDiscordModal(newChatModal(kind), locale));
        return;
      }

      if (isCwdPickerComponent(componentInteraction.customId)) {
        await handleCwdPickerInteraction(componentInteraction, handleMessage, options, locale);
        return;
      }

      const content = routeDiscordComponent(componentInteraction.customId, componentInteraction.values ?? []);

      if (!content) {
        await componentInteraction.reply({
          allowedMentions: { parse: [] },
          ephemeral: true,
          content: localizeConnectorText(
            "이 버튼은 더 이상 사용할 수 없습니다. `help`를 다시 눌러 최신 버튼을 열어주세요.",
            locale,
          ),
        });
        return;
      }

      const queuedSurveySelection = componentInteraction.customId.startsWith(COMPONENT_IDS.agentSurveyPrefix);

      if (queuedSurveySelection) {
        await componentInteraction.reply({
          allowedMentions: { parse: [] },
          ephemeral: true,
          content: localizeConnectorText(
            "설문 선택을 접수했습니다. 같은 agent 세션의 다음 작업으로 전달합니다.",
            locale,
          ),
        });
      }

      await handleMessage({
        authorBot: false,
        userId: componentInteraction.user.id,
        channelId: componentInteraction.channelId,
        content,
        roleIds: getMemberRoleIds(componentInteraction.member),
        guild: createDiscordGuildSurface(componentInteraction.guild, options),
        reply: interactionReplyAdapter(componentInteraction, {
          initialReplySent: queuedSurveySelection,
          answerCopyStore: options.answerCopyStore,
          locale,
        }),
      });
    })().catch((error) => {
      console.error("discord-bot failed to handle interaction", error);
    });
  });
}
