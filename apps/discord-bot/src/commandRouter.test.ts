import { describe, expect, it } from "vitest";

import { routeDiscordMessage } from "./commandRouter.js";

describe("routeDiscordMessage", () => {
  it("routes a bare shell-admin command to execute-command", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "ls",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "ls",
      confirmedDangerous: false,
    });
  });

  it("routes explicit confirmation to a confirmed dangerous command", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "confirm rm README.md",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "rm README.md",
      confirmedDangerous: true,
    });
  });

  it("blocks Codex chat from shell-admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "codex explain this project",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "main 채널은 운영 전용입니다.",
      guidance: "Codex와 대화하려면 /chat-new로 세션 채널을 만들거나 기존 session 채널에서 메시지를 보내세요.",
    });
  });

  it("routes session-linked codex-prefixed button text without keeping the prefix", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "codex README 요약해줘",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-chat",
      content: "README 요약해줘",
    });
  });

  it("routes the slash-prefixed howtouse shortcut to the current agent", () => {
    const codexRoute = routeDiscordMessage({
        channelMode: "session-linked",
        content: "/howtouse",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      });

    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("10MiB"),
    });
    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("파일 전용 Discord 메시지 여러 개로 자동 분할"),
    });
    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("request_user_input"),
    });
    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("현재 실행 중 turn으로 즉시 전달"),
    });
    expect(JSON.stringify(codexRoute)).not.toContain("최대 10개");

    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "/howtouse",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "claude-chat",
      content: expect.stringContaining("codex-discord-send"),
    });
    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "/howtouse",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "claude-chat",
      content: expect.stringContaining("실시간 질문 왕복이 아직 연결되어 있지 않습니다"),
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "howtouse",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-chat",
      content: "howtouse",
    });
  });

  it("appends a trailing prompt to the howtouse guidance", () => {
    const codexRoute = routeDiscordMessage({
      channelMode: "session-linked",
      content: "/howtouse 방금 만든 차트 이미지를 여기로 보내줘",
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
    });

    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("10MiB"),
    });
    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("이어지는 요청을 처리해줘"),
    });
    expect(codexRoute).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("방금 만든 차트 이미지를 여기로 보내줘"),
    });

    const multilineRoute = routeDiscordMessage({
      channelMode: "claude-code",
      content: "/howtouse 결과 파일을 보내줘.\n두 번째 줄 요청도 유지돼야 해.",
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
    });

    expect(multilineRoute).toEqual({
      type: "claude-chat",
      content: expect.stringContaining("결과 파일을 보내줘.\n두 번째 줄 요청도 유지돼야 해."),
    });
  });

  it("sends English attachment guidance to agents in an English installation", () => {
    const route = routeDiscordMessage({
      channelMode: "session-linked",
      content: "/howtouse",
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
      locale: "en",
    });

    expect(route).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("The final answer from this agent session"),
    });
    expect(route).toEqual({
      type: "codex-chat",
      content: expect.stringContaining("10MiB per file"),
    });
    expect(JSON.stringify(route)).not.toContain("입력 첨부파일");
  });

  it("sends Chinese and Japanese attachment guidance without Korean fallback", () => {
    for (const [locale, expected] of [
      ["zh", "此 agent 会话的最终回答会发送到已连接的 Discord 频道。"],
      ["ja", "この agent セッションの最終回答は接続された Discord チャンネルへ送信されます。"],
    ] as const) {
      const route = routeDiscordMessage({
        channelMode: "session-linked",
        content: "/howtouse",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
        locale,
      });

      expect(route).toEqual({
        type: "codex-chat",
        content: expect.stringContaining(expected),
      });
      expect(JSON.stringify(route)).not.toMatch(/[가-힣]/);
    }
  });

  it("uses English for connector-generated text shortcuts", () => {
    const base = {
      channelMode: "session-linked" as const,
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
      locale: "en" as const,
    };

    expect(routeDiscordMessage({ ...base, content: "fix-tests" })).toEqual({
      type: "codex-chat",
      content: "Run the tests, analyze any failures, fix them, and run the tests again.",
    });
    expect(routeDiscordMessage({ ...base, content: "compact Keep API compatibility." })).toEqual({
      type: "codex-chat",
      content: "Compact and summarize the work context so far. Keep API compatibility.",
    });
  });

  it("routes native /compact interactions to the current channel agent", () => {
    const base = {
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
    };

    expect(routeDiscordMessage({
      ...base,
      channelMode: "session-linked",
      content: "__cdc_agent_compact",
    })).toEqual({
      type: "codex-chat",
      content: "지금까지의 작업 맥락을 압축 요약해줘.",
    });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "claude-code",
      content: "__cdc_agent_compact",
    })).toEqual({
      type: "claude-chat",
      content: "/compact",
    });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "claude-code",
      content: "__cdc_agent_compact API 호환성은 유지해줘",
    })).toEqual({
      type: "claude-chat",
      content: "/compact API 호환성은 유지해줘",
    });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "shell-admin",
      content: "__cdc_agent_compact",
    })).toEqual({
      type: "blocked-command",
      reason: "이 명령은 session thread 전용입니다.",
      guidance: "압축할 Codex 또는 Claude Code session thread에서 /compact를 실행하세요.",
    });
  });

  it("routes component-generated shell commands in session-linked channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "__cdc_exec __cdc_open docs",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "__cdc_open docs",
      confirmedDangerous: false,
    });
  });

  it("routes bare shell-admin sync requests to the selection picker", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-select",
      limit: 25,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync 10",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-select",
      limit: 10,
    });
  });

  it("routes chat resume commands to the Claude session resume flow", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "chat resume",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "claude-resume-list" });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "chat resume 9d41bbde-5b0c-4ba5-b0b7-7dc7c0984e46",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "claude-resume",
      sessionId: "9d41bbde-5b0c-4ba5-b0b7-7dc7c0984e46",
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "chat resume",
        userRoleIds: [],
        allowedRoleIds: ["role-operator"],
      }),
    ).toMatchObject({ type: "denied" });
  });

  it("routes shell-admin sync selection preview requests", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync select 10",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-select",
      limit: 10,
    });
  });

  it("routes new Codex chat requests from the admin channel", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "chat new",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-new-chat",
      name: null,
      cwd: null,
      useCategory: false,
      initialPrompt: null,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "chat new cwd:/repo/apps name:Bot UI",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-new-chat",
      name: "Bot UI",
      cwd: "/repo/apps",
      useCategory: true,
      initialPrompt: null,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "chat new current name:현재 작업",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-new-chat",
      name: "현재 작업",
      cwd: ".",
      useCategory: true,
      initialPrompt: null,
    });
  });

  it("routes encoded and typed schedule requests", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content:
          "__cdc_schedule %7B%22action%22%3A%22create%22%2C%22mode%22%3A%22every%22%2C%22command%22%3A%22shell%20pwd%22%2C%22every%22%3A%2210m%22%7D",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "schedule-command",
      request: {
        action: "create",
        mode: "every",
        command: "shell pwd",
        every: "10m",
      },
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "schedule list",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "schedule-command",
      request: { action: "list" },
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "schedule delete sched-1",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "schedule-command",
      request: { action: "delete", id: "sched-1" },
    });
  });

  it("routes selected Codex session ids to selected sync", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content:
          "sync selected 019db2be-b2b3-7e82-9e61-8c84b28ad287 019db2be-b2b3-7e82-9e61-8c84b28ad288",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-selected",
      sessionIds: [
        "019db2be-b2b3-7e82-9e61-8c84b28ad287",
        "019db2be-b2b3-7e82-9e61-8c84b28ad288",
      ],
    });
  });

  it("routes channel status helpers before shell execution", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "where",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "channel-status" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "status",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "channel-status" });
  });

  it("routes maintenance panel requests before shell execution", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "maintenance",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "maintenance-panel" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "maintenance",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "maintenance-panel" });
  });

  it("routes clear requests only in admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "clear",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "admin-clear-messages", mode: "all", confirmed: false });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "clear all confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "admin-clear-messages", mode: "all", confirmed: true });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "clear 25",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "admin-clear-messages", mode: "count", count: 25, confirmed: true });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "clear 25",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "이 명령은 main 채널 전용입니다.",
      guidance: "메시지 삭제는 관리자 채널에서 /clear 또는 clear <개수>로 실행하세요.",
    });
  });

  it("blocks Codex operator shortcuts in shell-admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "model gpt-5.4",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "이 채널에는 agent 기본 설정 대상이 없습니다.",
      guidance: "Codex 또는 Claude Code main 채널에서 모델과 effort 기본값을 설정하세요.",
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "fast",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "main 채널은 운영 전용입니다.",
      guidance: "모델 설정과 Codex 요청은 session 채널에서 실행하세요.",
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "review 보안 위험 위주",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "main 채널은 운영 전용입니다.",
      guidance: "리뷰는 session 채널에서 실행하거나 /chat-new로 새 session을 만든 뒤 요청하세요.",
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "fix-tests",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "main 채널은 운영 전용입니다.",
      guidance: "테스트 수정 요청은 session 채널에서 실행하세요. main에서는 !pnpm test처럼 shell만 실행할 수 있습니다.",
    });
  });

  it("routes Codex operator shortcuts in session channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "model gpt-5.4",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "agent-model", model: "gpt-5.4" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "fast",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "codex-run-mode", mode: "fast" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "task",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "codex-run-mode", mode: "task" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "mode default",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "codex-run-mode", mode: "default" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "review 보안 위험 위주",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "codex-review", prompt: "보안 위험 위주" });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "fix-tests",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-chat",
      content: "테스트를 실행하고 실패 원인을 분석한 뒤 수정해줘. 수정 후 테스트를 다시 실행해줘",
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "summarize 이번 채널",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-chat",
      content: "이번 채널을 요약하고 다음 액션을 제안해줘",
    });
  });

  it("routes persistent agent defaults in Codex and Claude main channels", () => {
    const base = {
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
    };

    expect(routeDiscordMessage({
      ...base,
      channelMode: "shell-admin",
      agentMain: "codex",
      content: "model gpt-5.6-sol",
    })).toEqual({ type: "agent-model", model: "gpt-5.6-sol" });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "shell-admin",
      agentMain: "codex",
      content: "effort max",
    })).toEqual({ type: "agent-effort", effort: "max" });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "claude-code",
      agentMain: "claude",
      content: "model claude-fable-5[1m]",
    })).toEqual({ type: "agent-model", model: "claude-fable-5[1m]" });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "claude-code",
      agentMain: "claude",
      content: "effort max",
    })).toEqual({ type: "agent-effort", effort: "max" });
  });

  it("routes per-thread settings and inheritance resets for both agents", () => {
    const base = {
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
    };

    expect(routeDiscordMessage({
      ...base,
      channelMode: "session-linked",
      content: "effort high",
    })).toEqual({ type: "agent-effort", effort: "high" });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "claude-code",
      content: "model default",
    })).toEqual({ type: "agent-model", model: null });
    expect(routeDiscordMessage({
      ...base,
      channelMode: "claude-code",
      content: "/settings",
    })).toEqual({ type: "agent-settings" });
  });

  it("routes bridge slash-equivalent shortcuts from chat messages", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "codex-command model default",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "agent-model", model: null });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "diff",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "git diff --stat",
      confirmedDangerous: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "browse",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "__cdc_ls 0",
      confirmedDangerous: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "shell pwd",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "pwd",
      confirmedDangerous: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "codex-command mcp list",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "codex mcp list",
      confirmedDangerous: false,
    });
  });

  it("routes sync status requests in admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync status",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "admin-sync-status" });
  });

  it("routes transcript sync mode changes in admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync mode realtime",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "admin-sync-mode", mode: "realtime" });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync mode on-chat",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({ type: "admin-sync-mode", mode: "on-chat" });
  });

  it("routes bot reload requests in admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "reload",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "bot-reload",
      mode: "commands",
      confirmed: true,
      force: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "reload restart",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "bot-reload",
      mode: "restart",
      confirmed: false,
      force: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "bot reload restart confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "bot-reload",
      mode: "restart",
      confirmed: true,
      force: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "reload restart force confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "bot-reload",
      mode: "restart",
      confirmed: true,
      force: true,
    });
  });

  it("blocks global reload actions from session channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "reload commands",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "이 명령은 main 채널 전용입니다.",
      guidance: "봇 명령어 재등록과 재시작은 main/admin 채널에서 실행하세요.",
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "reload",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "이 명령은 main 채널 전용입니다.",
      guidance: "봇 명령어 재등록과 재시작은 main/admin 채널에서 실행하세요.",
    });
  });

  it("blocks global sync actions from session channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "sync",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "이 명령은 main 채널 전용입니다.",
      guidance: "세션 동기화는 main/admin 채널에서 실행하세요.",
    });
  });

  it("routes new-chat actions from session and Claude Code channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "chat new",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-new-chat",
      name: null,
      cwd: null,
      useCategory: false,
      initialPrompt: null,
    });

    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content:
          "__cdc_new_chat %7B%22name%22%3A%22Claude%20scratch%22%2C%22cwd%22%3A%22.%22%2C%22useCategory%22%3Atrue%2C%22initialPrompt%22%3A%22%EC%8B%9C%EC%9E%91%22%7D",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-new-chat",
      name: "Claude scratch",
      cwd: ".",
      useCategory: true,
      initialPrompt: "시작",
    });
  });

  it("routes session fork requests from linked agent threads", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "__cdc_fork_session %7B%22name%22%3A%22Refactor%20branch%22%7D",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "fork-session",
      name: "Refactor branch",
    });

    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "__cdc_fork_session %7B%22name%22%3A%22GPU%20%EC%8B%A4%ED%97%98%22%7D",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "fork-session",
      name: "GPU 실험",
    });

    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "/fork 다른 접근 테스트",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "fork-session",
      name: "다른 접근 테스트",
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "fork 는 잘 되는건가?",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-chat",
      content: "fork 는 잘 되는건가?",
    });
  });

  it("routes queue and active turn control commands", () => {
    const base = {
      channelMode: "session-linked" as const,
      userRoleIds: ["role-operator"],
      allowedRoleIds: ["role-operator"],
    };

    expect(routeDiscordMessage({ ...base, content: "queue" })).toEqual({ type: "queue-status" });
    expect(routeDiscordMessage({ ...base, content: "/queue prompt:끝난 뒤 테스트도 실행해줘" })).toEqual({
      type: "queue-prompt",
      content: "끝난 뒤 테스트도 실행해줘",
    });
    expect(routeDiscordMessage({ ...base, content: "/queue-clear" })).toEqual({ type: "queue-clear" });
    expect(routeDiscordMessage({ ...base, content: "interrupt" })).toEqual({ type: "codex-interrupt" });
    expect(routeDiscordMessage({ ...base, content: "steer 구현 방향을 바꿔줘" })).toEqual({
      type: "codex-steer",
      content: "구현 방향을 바꿔줘",
    });
  });

  it("routes explicit sync all requests to immediate admin sync", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync all 10",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync",
      limit: 10,
    });
  });

  it("routes sync delete preview without requiring confirmation", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete preview",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "all",
      confirmed: false,
    });
  });

  it("routes confirmed sync delete all requests", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete all confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "all",
      confirmed: true,
    });
  });

  it("routes confirmed sync delete channels requests", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete channels confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "channels",
      confirmed: true,
    });
  });

  it("routes one synced session delete preview and confirmation", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete session 019db2be-b2b3-7e82-9e61-8c84b28ad287",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "session",
      sessionId: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
      confirmed: false,
    });
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete session 019db2be-b2b3-7e82-9e61-8c84b28ad287 confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "session",
      sessionId: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
      confirmed: true,
    });
  });

  it("routes selected synced session delete commands from dropdowns", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete session session-1",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "session",
      sessionId: "session-1",
      confirmed: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync delete session session-1 confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "admin-sync-delete",
      mode: "session",
      sessionId: "session-1",
      confirmed: true,
    });
  });

  it("routes confirmed admin archive requests for a specific Codex session", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "sync archive 019db2be-b2b3-7e82-9e61-8c84b28ad287 confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "archive-session",
      sessionId: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
      confirmed: true,
    });
  });

  it("routes session-linked archive confirmation without sending it to Codex", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "archive confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "archive-session",
      sessionId: null,
      confirmed: true,
    });
  });

  it("blocks current-session archive shortcuts in admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "archive confirm",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "이 명령은 session 채널 전용입니다.",
      guidance: "현재 세션을 보관하려면 해당 session 채널에서 /archive 또는 archive confirm을 실행하세요.",
    });
  });

  it("routes session-linked normal text to codex-chat", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "hello there",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-chat",
      content: "hello there",
    });
  });

  it("routes explicit Claude Code prompts in session channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "claude README 요약해줘",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "claude-chat",
      content: "README 요약해줘",
    });
  });

  it("routes Claude Code channel normal text to Claude Code", () => {
    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "현재 GPU 사용량 봐봐",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "claude-chat",
      content: "현재 GPU 사용량 봐봐",
    });
  });

  it("routes Claude Code channel explicit Claude prompts without keeping the prefix", () => {
    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "claude README 요약해줘",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "claude-chat",
      content: "README 요약해줘",
    });
  });

  it("blocks explicit Codex prompts in Claude Code channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "claude-code",
        content: "codex README 요약해줘",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "Claude Code 전용 채널입니다.",
      guidance: "Codex와 대화하려면 Codex 채널이나 session 채널에서 요청하세요.",
    });
  });

  it("blocks explicit Claude Code prompts in admin channels", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "claude README 요약해줘",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "blocked-command",
      reason: "main 채널은 운영 전용입니다.",
      guidance: "Claude Code와 대화하려면 /chat-new로 session 채널을 만들거나 기존 session 채널에서 `claude ...`를 보내세요.",
    });
  });

  it("routes encoded continue-session prompts to a specific Codex session", () => {
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";
    const content = `__cdc_codex_continue ${encodeURIComponent(JSON.stringify({
      sessionId,
      prompt: "테스트까지 이어서 실행해줘",
    }))}`;

    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content,
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "codex-continue-session",
      sessionId,
      content: "테스트까지 이어서 실행해줘",
    });
  });

  it("routes Codex open commands to the desktop deep link", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "codex open 019db2be-b2b3-7e82-9e61-8c84b28ad287",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "open 'codex://threads/019db2be-b2b3-7e82-9e61-8c84b28ad287'",
      confirmedDangerous: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "open codex 019db2be-b2b3-7e82-9e61-8c84b28ad287",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command: "open 'codex://threads/019db2be-b2b3-7e82-9e61-8c84b28ad287'",
      confirmedDangerous: false,
    });

    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "codex reopen 019db2be-b2b3-7e82-9e61-8c84b28ad287",
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "execute-command",
      command:
        "pkill -f '/Applications/Codex.app/Contents/MacOS/ChatGPT' || true; sleep 2; open 'codex://threads/019db2be-b2b3-7e82-9e61-8c84b28ad287'; sleep 5; open 'codex://threads/019db2be-b2b3-7e82-9e61-8c84b28ad287'",
      confirmedDangerous: true,
    });
  });

  it("routes help requests before shell execution", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "help",
        userRoleIds: ["role-viewer"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "bot-help",
    });
  });

  it("denies unauthorized session-linked chat", () => {
    expect(
      routeDiscordMessage({
        channelMode: "session-linked",
        content: "hello there",
        userRoleIds: ["role-viewer"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "denied",
      reason: "User does not have an allowed role",
    });
  });

  it("denies unauthorized shell-admin commands", () => {
    expect(
      routeDiscordMessage({
        channelMode: "shell-admin",
        content: "ls",
        userRoleIds: ["role-viewer"],
        allowedRoleIds: ["role-operator"],
      }),
    ).toEqual({
      type: "denied",
      reason: "User does not have an allowed role",
    });
  });
});
