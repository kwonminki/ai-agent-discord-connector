import { describe, expect, it, vi } from "vitest";

import {
  DISCORD_APPLICATION_COMMANDS,
  discordApplicationCommands,
  isHarnessHelpInteraction,
  registerDiscordApplicationCommands,
  routeDiscordApplicationCommand,
} from "./applicationCommands.js";

function options(input: Record<string, string | number | boolean | null>) {
  return {
    getString: vi.fn((name: string) => {
      const value = input[name];
      return typeof value === "string" ? value : null;
    }),
    getInteger: vi.fn((name: string) => {
      const value = input[name];
      return typeof value === "number" ? value : null;
    }),
    getBoolean: vi.fn((name: string) => {
      const value = input[name];
      return typeof value === "boolean" ? value : null;
    }),
    getSubcommand: vi.fn(() => {
      const value = input.__subcommand;
      return typeof value === "string" ? value : null;
    }),
  };
}

describe("Discord application commands", () => {
  it("defines native slash commands for common Codex and bridge actions", () => {
    expect(DISCORD_APPLICATION_COMMANDS.map((command) => command.name)).toEqual([
      "codex",
      "codex-command",
      "compact",
      "skill",
      "harness",
      "harness-help",
      "model",
      "effort",
      "settings",
      "fast",
      "task",
      "codex-mode",
      "status",
      "diff",
      "review",
      "fix-tests",
      "summarize",
      "chat-resume",
      "howtouse",
      "where",
      "reload",
      "clear",
      "sync",
      "sync-all",
      "sync-select",
      "sync-status",
      "sync-mode",
      "sync-delete",
      "sync-archive",
      "schedule",
      "chat-new",
      "fork",
      "steer",
      "interrupt",
      "queue",
      "queue-clear",
      "archive",
      "browse",
      "shell",
    ]);
  });

  it("routes /codex into a Codex prompt", () => {
    expect(
      routeDiscordApplicationCommand({
        commandName: "codex",
        options: options({ prompt: "README 요약해줘" }),
      }),
    ).toBe("codex README 요약해줘");
  });

  it("uses native choices for the reload mode option", () => {
    const reloadCommand = DISCORD_APPLICATION_COMMANDS.find((command) => command.name === "reload");

    expect(reloadCommand?.options?.[0]).toEqual(
      expect.objectContaining({
        name: "mode",
        choices: [
          { name: "commands", value: "commands" },
          { name: "restart", value: "restart" },
        ],
      }),
    );
  });

  it("enables model autocomplete without restricting custom model names", () => {
    const modelCommand = DISCORD_APPLICATION_COMMANDS.find((command) => command.name === "model");

    expect(modelCommand?.options?.[0]).toEqual(
      expect.objectContaining({
        name: "model",
        required: true,
        autocomplete: true,
      }),
    );
    expect(modelCommand?.options?.[0]?.choices).toBeUndefined();
  });

  it("uses selectable Harness subcommands and asks only for action-specific inputs", () => {
    const harness = DISCORD_APPLICATION_COMMANDS.find((command) => command.name === "harness");
    const create = harness?.options?.find((option) => option.name === "create");
    const run = harness?.options?.find((option) => option.name === "run");

    expect(harness?.options?.map((option) => option.name)).toEqual([
      "create",
      "publish-run",
      "publish",
      "run",
      "status",
      "list",
      "leave",
      "cancel",
      "help",
    ]);
    expect(harness?.options?.every((option) => option.type === 1)).toBe(true);
    expect(create?.options?.find((option) => option.name === "goal")).toEqual(
      expect.objectContaining({ required: true }),
    );
    expect(create?.options?.find((option) => option.name === "source")?.choices).toEqual([
      { name: "현재 세션 이어서 (추천)", value: "current" },
      { name: "새 문맥에서 시작", value: "fresh" },
    ]);
    expect(run?.options?.find((option) => option.name === "harness")).toEqual(
      expect.objectContaining({ required: true, autocomplete: true }),
    );
  });

  it("registers English slash command descriptions without changing command names", () => {
    const commands = discordApplicationCommands("en");
    const codex = commands.find((command) => command.name === "codex");
    const compact = commands.find((command) => command.name === "compact");
    const harness = commands.find((command) => command.name === "harness");

    expect(codex?.description).toBe("Send a natural-language request to Codex.");
    expect(codex?.options?.[0]?.name).toBe("prompt");
    expect(codex?.options?.[0]?.description).toBe("Request to send to Codex");
    expect(compact?.description).toBe("Compact the context of the current Codex or Claude Code session.");
    expect(compact?.options?.[0]?.description).toBe("Additional instructions for context compaction");
    expect(harness?.description).toBe("Build a reusable Harness through conversation and run an immutable version.");
    const create = harness?.options?.find((option) => option.name === "create");
    expect(create?.description).toBe("Design a new Harness by answering guided questions.");
    expect(create?.options?.find((option) => option.name === "goal")?.description)
      .toBe("Goal of the repeatable task you want to create");
  });

  it("registers Chinese and Japanese slash command descriptions", () => {
    const chinese = discordApplicationCommands("zh").find((command) => command.name === "codex");
    const japanese = discordApplicationCommands("ja").find((command) => command.name === "codex");
    const chineseCompact = discordApplicationCommands("zh").find((command) => command.name === "compact");
    const japaneseCompact = discordApplicationCommands("ja").find((command) => command.name === "compact");
    const chineseHarness = discordApplicationCommands("zh").find((command) => command.name === "harness");
    const japaneseHarness = discordApplicationCommands("ja").find((command) => command.name === "harness");

    expect(chinese?.description).toBe("向 Codex 发送自然语言请求。");
    expect(chinese?.options?.[0]?.description).toBe("发送给 Codex 的请求");
    expect(japanese?.description).toBe("Codex に自然言語で依頼します。");
    expect(japanese?.options?.[0]?.description).toBe("Codex に送るリクエスト");
    expect(chineseCompact?.description).toBe("压缩当前 Codex 或 Claude Code 会话的上下文。");
    expect(japaneseCompact?.description).toBe("現在の Codex または Claude Code セッションのコンテキストを圧縮します。");
    expect(chineseHarness?.description).toBe("通过问答创建可复用的 Harness，并运行不可变版本。");
    expect(japaneseHarness?.description).toBe("対話で再利用可能な Harness を作成し、不変バージョンを実行します。");
  });

  it("uses English for generated agent prompts in an English installation", () => {
    expect(routeDiscordApplicationCommand({
      commandName: "fix-tests",
      options: options({}),
    }, "en")).toBe("codex Run the tests, analyze any failures, fix them, and run the tests again.");
    expect(routeDiscordApplicationCommand({
      commandName: "compact",
      options: options({ prompt: "Keep API compatibility." }),
    }, "en")).toBe("__cdc_agent_compact Keep API compatibility.");
  });

  it("preserves /compact until the channel-aware router selects the agent", () => {
    expect(
      routeDiscordApplicationCommand({
        commandName: "compact",
        options: options({ prompt: "이번 작업 맥락 정리" }),
      }),
    ).toBe("__cdc_agent_compact 이번 작업 맥락 정리");

    expect(
      routeDiscordApplicationCommand({
        commandName: "compact",
        options: options({}),
      }),
    ).toBe("__cdc_agent_compact");
  });

  it("routes /skill as an exec-compatible skill request prompt", () => {
    expect(
      routeDiscordApplicationCommand({
        commandName: "skill",
        options: options({
          name: "frontend-design",
          prompt: "Discord UI를 더 직관적으로 개선해줘",
        }),
      }),
    ).toBe("codex frontend-design skill을 적용해서 다음 요청을 처리해줘: Discord UI를 더 직관적으로 개선해줘");
  });

  it("encodes /harness without exposing internal command fields to shell routing", () => {
    const command = routeDiscordApplicationCommand({
      commandName: "harness",
      options: options({
        __subcommand: "create",
        source: "current",
        thread_name: "PR Review Builder",
        goal: "반복 가능한 PR 리뷰 workflow를 만들고 싶어",
      }),
    });

    expect(command).toMatch(/^__cdc_harness /);
    expect(JSON.parse(decodeURIComponent(command!.slice("__cdc_harness ".length)))).toEqual({
      action: "create",
      source: "current",
      name: "PR Review Builder",
      harnessId: null,
      version: null,
      prompt: "반복 가능한 PR 리뷰 workflow를 만들고 싶어",
    });
  });

  it("recognizes both global and subcommand Harness help without a session route", () => {
    expect(isHarnessHelpInteraction({
      commandName: "harness-help",
      options: options({}),
    })).toBe(true);
    expect(isHarnessHelpInteraction({
      commandName: "harness",
      options: options({ __subcommand: "help" }),
    })).toBe(true);
    expect(isHarnessHelpInteraction({
      commandName: "harness",
      options: options({ __subcommand: "create" }),
    })).toBe(false);
  });

  it("routes /howtouse through the channel-aware agent shortcut", () => {
    const prompt = routeDiscordApplicationCommand({
      commandName: "howtouse",
      options: options({}),
    });

    expect(prompt).toBe("/howtouse");
    expect(
      routeDiscordApplicationCommand({
        commandName: "HOW-TO-USE",
        options: options({}),
      }),
    ).toBe("/howtouse");
  });

  it("routes supported /codex-command shortcuts to working bridge commands", () => {
    expect(
      routeDiscordApplicationCommand({
        commandName: "codex-command",
        options: options({ command: "model", prompt: "gpt-5.4" }),
      }),
    ).toBe("model gpt-5.4");
    expect(
      routeDiscordApplicationCommand({
        commandName: "codex-command",
        options: options({ command: "diff" }),
      }),
    ).toBe("__cdc_exec git diff --stat");
  });

  it("routes common Codex slash command shortcuts", () => {
    expect(
      routeDiscordApplicationCommand({
        commandName: "model",
        options: options({ model: "gpt-5.4" }),
      }),
    ).toBe("model gpt-5.4");
    expect(
      routeDiscordApplicationCommand({
        commandName: "effort",
        options: options({ level: "max" }),
      }),
    ).toBe("effort max");
    expect(
      routeDiscordApplicationCommand({
        commandName: "settings",
        options: options({}),
      }),
    ).toBe("settings");
    expect(
      routeDiscordApplicationCommand({
        commandName: "fast",
        options: options({}),
      }),
    ).toBe("fast");
    expect(
      routeDiscordApplicationCommand({
        commandName: "task",
        options: options({}),
      }),
    ).toBe("task");
    expect(
      routeDiscordApplicationCommand({
        commandName: "codex-mode",
        options: options({ mode: "default" }),
      }),
    ).toBe("mode default");
    expect(
      routeDiscordApplicationCommand({
        commandName: "status",
        options: options({}),
      }),
    ).toBe("where");
    expect(
      routeDiscordApplicationCommand({
        commandName: "diff",
        options: options({}),
      }),
    ).toBe("__cdc_exec git diff --stat");
    expect(
      routeDiscordApplicationCommand({
        commandName: "review",
        options: options({ prompt: "보안 위험 위주" }),
      }),
    ).toBe("__cdc_codex_review 보안 위험 위주");
    expect(
      routeDiscordApplicationCommand({
        commandName: "fix-tests",
        options: options({}),
      }),
    ).toBe("codex 테스트를 실행하고 실패 원인을 분석한 뒤 수정해줘. 수정 후 테스트를 다시 실행해줘");
    expect(
      routeDiscordApplicationCommand({
        commandName: "summarize",
        options: options({ target: "이번 채널" }),
      }),
    ).toBe("codex 이번 채널을 요약하고 다음 액션을 제안해줘");
    expect(
      routeDiscordApplicationCommand({
        commandName: "steer",
        options: options({ prompt: "테스트 대신 구현부터 진행해줘" }),
      }),
    ).toBe("steer 테스트 대신 구현부터 진행해줘");
    expect(routeDiscordApplicationCommand({ commandName: "interrupt", options: options({}) })).toBe("interrupt");
    expect(routeDiscordApplicationCommand({ commandName: "queue", options: options({}) })).toBe("queue");
    expect(
      routeDiscordApplicationCommand({
        commandName: "queue",
        options: options({ prompt: "현재 작업 뒤에 테스트도 실행해줘" }),
      }),
    ).toBe("queue prompt:현재 작업 뒤에 테스트도 실행해줘");
    expect(routeDiscordApplicationCommand({ commandName: "queue-clear", options: options({}) })).toBe("queue-clear");
  });

  it("routes bridge utility slash commands to existing message commands", () => {
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync",
        options: options({ limit: 10 }),
      }),
    ).toBe("sync select 10");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-all",
        options: options({ limit: 10 }),
      }),
    ).toBe("sync all 10");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-select",
        options: options({ limit: 10 }),
      }),
    ).toBe("sync select 10");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-status",
        options: options({}),
      }),
    ).toBe("sync status");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-mode",
        options: options({ mode: "realtime" }),
      }),
    ).toBe("sync mode realtime");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-delete",
        options: options({ mode: "preview" }),
      }),
    ).toBe("sync delete preview");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-delete",
        options: options({ mode: "channels", confirm: true }),
      }),
    ).toBe("sync delete channels confirm");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-delete",
        options: options({
          mode: "session",
          session_id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
          confirm: true,
        }),
      }),
    ).toBe("sync delete session 019db2be-b2b3-7e82-9e61-8c84b28ad287 confirm");
    expect(
      routeDiscordApplicationCommand({
        commandName: "sync-archive",
        options: options({
          session_id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
          confirm: true,
        }),
      }),
    ).toBe("sync archive 019db2be-b2b3-7e82-9e61-8c84b28ad287 confirm");
    expect(
      routeDiscordApplicationCommand({
        commandName: "schedule",
        options: options({
          action: "create",
          mode: "weekly",
          command: "shell pnpm test",
          at: "09:30",
          weekdays: "mon,wed,fri",
        }),
      }),
    ).toBe(
      '__cdc_schedule %7B%22action%22%3A%22create%22%2C%22mode%22%3A%22weekly%22%2C%22command%22%3A%22shell%20pnpm%20test%22%2C%22at%22%3A%2209%3A30%22%2C%22every%22%3Anull%2C%22weekdays%22%3A%22mon%2Cwed%2Cfri%22%2C%22id%22%3Anull%7D',
    );
    expect(
      routeDiscordApplicationCommand({
        commandName: "schedule",
        options: options({ action: "delete", id: "sched-1" }),
      }),
    ).toBe(
      '__cdc_schedule %7B%22action%22%3A%22delete%22%2C%22mode%22%3Anull%2C%22command%22%3Anull%2C%22at%22%3Anull%2C%22every%22%3Anull%2C%22weekdays%22%3Anull%2C%22id%22%3A%22sched-1%22%7D',
    );
    expect(
      routeDiscordApplicationCommand({
        commandName: "chat-new",
        options: options({
          name: "Feature Planning",
          location: "path",
          cwd: "/repo/apps",
          category: true,
          prompt: "새 기능 설계부터 시작해줘",
        }),
      }),
    ).toBe(
      '__cdc_new_chat %7B%22name%22%3A%22Feature%20Planning%22%2C%22cwd%22%3A%22%2Frepo%2Fapps%22%2C%22useCategory%22%3Atrue%2C%22initialPrompt%22%3A%22%EC%83%88%20%EA%B8%B0%EB%8A%A5%20%EC%84%A4%EA%B3%84%EB%B6%80%ED%84%B0%20%EC%8B%9C%EC%9E%91%ED%95%B4%EC%A4%98%22%7D',
    );
    expect(
      routeDiscordApplicationCommand({
        commandName: "chat-new",
        options: options({ name: "현재 작업", location: "current" }),
      }),
    ).toBe(
      '__cdc_new_chat %7B%22name%22%3A%22%ED%98%84%EC%9E%AC%20%EC%9E%91%EC%97%85%22%2C%22cwd%22%3A%22.%22%2C%22useCategory%22%3Atrue%2C%22initialPrompt%22%3Anull%7D',
    );
    expect(
      routeDiscordApplicationCommand({
        commandName: "chat-new",
        options: options({ name: "자유 메모", location: "general", cwd: "/repo/apps" }),
      }),
    ).toBe(
      '__cdc_new_chat %7B%22name%22%3A%22%EC%9E%90%EC%9C%A0%20%EB%A9%94%EB%AA%A8%22%2C%22cwd%22%3Anull%2C%22useCategory%22%3Afalse%2C%22initialPrompt%22%3Anull%7D',
    );
    expect(
      routeDiscordApplicationCommand({
        commandName: "where",
        options: options({}),
      }),
    ).toBe("where");
    expect(
      routeDiscordApplicationCommand({
        commandName: "reload",
        options: options({ mode: "commands" }),
      }),
    ).toBe("reload commands");
    expect(
      routeDiscordApplicationCommand({
        commandName: "reload",
        options: options({ mode: "restart", confirm: true }),
      }),
    ).toBe("reload restart confirm");
    expect(
      routeDiscordApplicationCommand({
        commandName: "reload",
        options: options({ mode: "restart", force: true, confirm: true }),
      }),
    ).toBe("reload restart force confirm");
    expect(
      routeDiscordApplicationCommand({
        commandName: "clear",
        options: options({ count: 25 }),
      }),
    ).toBe("clear 25");
    expect(
      routeDiscordApplicationCommand({
        commandName: "clear",
        options: options({ all: true }),
      }),
    ).toBe("clear all");
    expect(
      routeDiscordApplicationCommand({
        commandName: "archive",
        options: options({}),
      }),
    ).toBe("archive");
    expect(
      routeDiscordApplicationCommand({
        commandName: "browse",
        options: options({}),
      }),
    ).toBe("__cdc_exec __cdc_ls 0");
    expect(
      routeDiscordApplicationCommand({
        commandName: "shell",
        options: options({ command: "pwd" }),
      }),
    ).toBe("__cdc_exec pwd");
  });

  it("registers commands to a configured guild when available", async () => {
    const setGuildCommands = vi.fn().mockResolvedValue(undefined);
    const setGlobalCommands = vi.fn().mockResolvedValue(undefined);

    await registerDiscordApplicationCommands(
      {
        application: { commands: { set: setGlobalCommands } },
        guilds: {
          cache: new Map([["guild-1", { commands: { set: setGuildCommands } }]]),
        },
      },
      "guild-1",
    );

    expect(setGuildCommands).toHaveBeenCalledWith(DISCORD_APPLICATION_COMMANDS);
    expect(setGlobalCommands).not.toHaveBeenCalled();
  });
});
