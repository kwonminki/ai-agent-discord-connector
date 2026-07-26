import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  delete process.env.CONNECT_MODE;
  process.env.CONNECT_CONFIG_PATH = path.join(
    os.tmpdir(),
    `codex-discord-missing-${randomUUID()}.json`,
  );
});

afterEach(() => {
  delete process.env.DISCORD_TOKEN;
  delete process.env.CONNECT_MODE;
  delete process.env.CONNECT_CONFIG_PATH;
  vi.resetModules();
  vi.unmock("./discordClient.js");
});

describe("bot entrypoint", () => {
  it("uses fast realtime polling without auto-creating session channels", async () => {
    const {
      createBackgroundPollState,
      recordBackgroundPollResult,
      resolveBackgroundMaxNormalizedLoad,
      resolveRealtimeIntervalMs,
      shouldDeferBotRestart,
      shouldRunBackgroundPoll,
      shouldRunRealtimeSessionAutosync,
      shouldSkipBackgroundPolling,
    } = await import("./index.js");

    expect(resolveRealtimeIntervalMs(undefined, 1_000)).toBe(1_000);
    expect(resolveRealtimeIntervalMs("250", 1_000)).toBe(500);
    expect(resolveRealtimeIntervalMs("2000", 1_000)).toBe(2_000);
    expect(resolveRealtimeIntervalMs("bad", 1_000)).toBe(1_000);
    expect(resolveBackgroundMaxNormalizedLoad(undefined, 0.7)).toBe(0.7);
    expect(resolveBackgroundMaxNormalizedLoad("0", 0.7)).toBe(0);
    expect(resolveBackgroundMaxNormalizedLoad("2", 0.7)).toBe(2);
    expect(shouldSkipBackgroundPolling({ loadAverage: 7, cpuCount: 10, maxNormalizedLoad: 0.7 })).toBe(true);
    expect(shouldSkipBackgroundPolling({ loadAverage: 3, cpuCount: 10, maxNormalizedLoad: 0.7 })).toBe(false);
    expect(shouldDeferBotRestart({ activeCount: 1, pendingCount: 0 })).toBe(true);
    expect(shouldDeferBotRestart({ activeCount: 0, pendingCount: 1 })).toBe(true);
    expect(shouldDeferBotRestart({ activeCount: 0, pendingCount: 0 })).toBe(false);

    const pollState = createBackgroundPollState(1_000, 5_000);
    expect(shouldRunBackgroundPoll(pollState, 1_000)).toBe(true);
    recordBackgroundPollResult(pollState, {
      now: 1_000,
      baseIntervalMs: 5_000,
      maxIntervalMs: 20_000,
      changed: false,
    });
    expect(pollState.currentIntervalMs).toBe(10_000);
    expect(shouldRunBackgroundPoll(pollState, 10_000)).toBe(false);
    recordBackgroundPollResult(pollState, {
      now: 12_000,
      baseIntervalMs: 5_000,
      maxIntervalMs: 20_000,
      changed: true,
    });
    expect(pollState.currentIntervalMs).toBe(5_000);
    expect(
      shouldRunRealtimeSessionAutosync({
        mode: "realtime",
        now: 10_000,
        lastAutoSyncAt: 0,
        intervalMs: 10_000,
      }),
    ).toBe(false);
    expect(
      shouldRunRealtimeSessionAutosync({
        mode: "on-chat",
        now: 10_000,
        lastAutoSyncAt: 0,
        intervalMs: 10_000,
      }),
    ).toBe(false);
  });

  it("does not start the bot when imported", async () => {
    const login = vi.fn();
    const once = vi.fn();
    const attachDiscordMessageHandler = vi.fn();
    const attachDiscordInteractionHandler = vi.fn();
    const registerDiscordApplicationCommands = vi.fn();
    const createDiscordClient = vi.fn(() => ({
      login,
      once,
    }));

    vi.doMock("./discordClient.js", () => ({
      attachDiscordInteractionHandler,
      attachDiscordMessageHandler,
      createDiscordGuildSurface: vi.fn(() => null),
      createDiscordClient,
      registerDiscordApplicationCommands,
    }));

    await expect(import("./index.js")).resolves.toBeTruthy();
    expect(createDiscordClient).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
  }, 15_000);

  it("starts the bot when requested", async () => {
    process.env.DISCORD_TOKEN = "discord-token";

    const login = vi.fn().mockResolvedValue("logged-in");
    const once = vi.fn();
    const on = vi.fn();
    const attachDiscordMessageHandler = vi.fn();
    const attachDiscordInteractionHandler = vi.fn();
    const registerDiscordApplicationCommands = vi.fn();
    const createDiscordClient = vi.fn(() => ({
      login,
      once,
      on,
    }));

    vi.doMock("./discordClient.js", () => ({
      attachDiscordInteractionHandler,
      attachDiscordMessageHandler,
      createDiscordGuildSurface: vi.fn(() => null),
      createDiscordClient,
      registerDiscordApplicationCommands,
    }));

    const { startBot } = await import("./index.js");
    await startBot();

    expect(createDiscordClient).toHaveBeenCalledTimes(1);
    expect(once).toHaveBeenCalledWith("clientReady", expect.any(Function));
    expect(attachDiscordMessageHandler).toHaveBeenCalledWith(
      { login, once, on },
      expect.any(Function),
      { answerCopyStore: expect.any(Object), locale: "ko" },
    );
    expect(attachDiscordInteractionHandler).toHaveBeenCalledWith(
      { login, once, on },
      expect.any(Function),
      {
        cwdPicker: false,
        isManagedChannel: expect.any(Function),
        modelAutocomplete: expect.any(Function),
        answerCopyStore: expect.any(Object),
        locale: "ko",
      },
    );
    expect(login).toHaveBeenCalledWith("discord-token");
  }, 15_000);

  it("starts the bot from a generated direct mode config", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "direct-config-"));
    const configPath = path.join(tempRoot, "config.json");
    process.env.CONNECT_CONFIG_PATH = configPath;

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          mode: "direct",
          discord: {
            token: "discord-token",
            guildId: "guild-1",
            allowedRoleIds: ["role-operator"],
            locale: "en",
          },
          direct: {
            computerId: "local-dev",
            computerDisplayName: "Local Dev",
            workspaceId: "local-dev:/repo",
            workspaceRoot: "/repo",
            workspaceDisplayName: "repo",
            channelId: "channel-1",
            channelMode: "shell-admin",
            timeoutMs: 30_000,
            codexHome: "/Users/me/.codex",
            relay: {
              trustedBotUserIds: ["relay-bot-1"],
              controlChannelId: "relay-control-1",
            },
          },
        }),
        "utf8",
      );

      const login = vi.fn().mockResolvedValue("logged-in");
      const once = vi.fn();
      const on = vi.fn();
      const attachDiscordMessageHandler = vi.fn();
      const attachDiscordInteractionHandler = vi.fn();
      const registerDiscordApplicationCommands = vi.fn().mockResolvedValue(undefined);
      const createDiscordClient = vi.fn(() => ({
        login,
        once,
        on,
      }));

      vi.doMock("./discordClient.js", () => ({
        attachDiscordInteractionHandler,
        attachDiscordMessageHandler,
        createDiscordGuildSurface: vi.fn(() => null),
        createDiscordClient,
        registerDiscordApplicationCommands,
      }));

      const { startBot } = await import("./index.js");
      await startBot();

      expect(attachDiscordMessageHandler).toHaveBeenCalledWith(
        { login, once, on },
        expect.any(Function),
        {
          answerCopyStore: expect.any(Object),
          locale: "en",
          onConnectorDiscovery: expect.any(Function),
          onRelayState: expect.any(Function),
          relayControlChannelId: "relay-control-1",
          trustedRelayBotUserIds: ["relay-bot-1"],
        },
      );
      const discoveryOptions = attachDiscordMessageHandler.mock.calls[0]?.[2] as {
        onConnectorDiscovery(discoveryId: string, guild: unknown): Promise<unknown>;
      };
      await expect(
        discoveryOptions.onConnectorDiscovery(
          "30519a6b-5fd5-4944-9fd2-2e3293c1c925",
          {
            createCategory: vi.fn(),
            createTextChannel: vi.fn(),
            createThread: vi.fn().mockResolvedValue({ id: "maintenance-thread-1" }),
            findThreadByName: vi.fn().mockResolvedValue(null),
            ensureChannelAvailable: vi.fn().mockResolvedValue(true),
          },
        ),
      ).resolves.toMatchObject({
        computerId: "local-dev",
        computerDisplayName: "Local Dev",
        connectorVersion: "1.4.2",
        preferredAgent: "codex",
        channels: {
          codex: "channel-1",
          claude: null,
        },
        maintenance: {
          agent: "codex",
          channelId: "maintenance-thread-1",
        },
      });
      expect(attachDiscordInteractionHandler).toHaveBeenCalledWith(
        { login, once, on },
        expect.any(Function),
        {
          cwdPicker: true,
          isManagedChannel: expect.any(Function),
          modelAutocomplete: expect.any(Function),
          answerCopyStore: expect.any(Object),
          locale: "en",
        },
      );
      expect(login).toHaveBeenCalledWith("discord-token");

      const readyHandler = once.mock.calls.find(([eventName]) => eventName === "clientReady")?.[1] as
        | (() => void)
        | undefined;
      readyHandler?.();
      expect(registerDiscordApplicationCommands).toHaveBeenCalledWith({ login, once, on }, "guild-1", "en");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects startBot without a token", async () => {
    const login = vi.fn();
    const once = vi.fn();
    const attachDiscordMessageHandler = vi.fn();
    const attachDiscordInteractionHandler = vi.fn();
    const registerDiscordApplicationCommands = vi.fn();
    const createDiscordClient = vi.fn(() => ({
      login,
      once,
    }));

    vi.doMock("./discordClient.js", () => ({
      attachDiscordInteractionHandler,
      attachDiscordMessageHandler,
      createDiscordGuildSurface: vi.fn(() => null),
      createDiscordClient,
      registerDiscordApplicationCommands,
    }));

    const { startBot } = await import("./index.js");

    await expect(startBot()).rejects.toThrow("DISCORD_TOKEN is required");
    expect(createDiscordClient).not.toHaveBeenCalled();
  });
});
