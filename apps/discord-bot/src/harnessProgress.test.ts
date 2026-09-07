import { describe, expect, it } from "vitest";
import {
  applyHarnessProgressEvent,
  createHarnessProgressState,
  formatHarnessProgress,
  formatHarnessProgressEvent,
} from "./harnessProgress.js";

describe("harness progress", () => {
  it("distinguishes the main agent, tool executor, subagent, and gateway roles", () => {
    const state = createHarnessProgressState({
      provider: "codex",
      harnessVersionId: "safe-review@1.0.0#abc",
      runId: "run-1",
      now: "2026-09-05T20:00:00.000Z",
    });

    expect(formatHarnessProgress(state)).toContain("메인 에이전트 · Codex");
    expect(formatHarnessProgress(state)).toContain("도구 실행기 · Connector Worker");
    expect(formatHarnessProgress(state)).toContain("개별 내용은 Discord에 출력하지 않으며");
    expect(formatHarnessProgress(state)).toContain("별도의 판단 Agent는 아님");
    expect(formatHarnessProgress(state)).toContain("하위 에이전트 · Codex subagent");
    expect(formatHarnessProgress(state)).toContain("전달자 · Discord Gateway");
    expect(formatHarnessProgress(state)).toContain("현재 단계** · 세션 연결");
  });

  it("classifies validation commands without exposing full noisy output", () => {
    const initial = createHarnessProgressState({
      provider: "claude",
      harnessVersionId: "release@2.0.0#def",
      runId: "run-2",
    });
    const update = applyHarnessProgressEvent(initial, {
      type: "operation-progress",
      label: "명령 실행 완료",
      detail: "명령: pnpm test -- --runInBand · 위치: /repo · 출력: many lines",
      eventType: "item/completed",
    }, "2026-09-05T20:01:00.000Z");

    expect(update.state).toMatchObject({
      stage: "검증",
      activeRole: "worker",
      commands: 1,
      checks: 1,
    });
    expect(update.state.activeDetail).toBe(
      "변경 사항이 요구 조건과 회귀 검증을 통과하는지 확인 · 세부 명령과 출력은 표시하지 않습니다.",
    );
    expect(update.significant).toBe(true);
  });

  it("turns agent messages into visible progress reports and strips harness internals", () => {
    const initial = createHarnessProgressState({
      provider: "codex",
      harnessVersionId: "release@2.0.0#def",
      runId: "run-3",
    });
    const update = applyHarnessProgressEvent(initial, {
      type: "agent-message",
      text: "테스트를 시작합니다.\n```codex-discord-harness\n{\"secret\":true}\n```",
    });

    expect(update.report).toBe("테스트를 시작합니다.");
    expect(update.state).toMatchObject({ stage: "검증", activeRole: "agent", agentReports: 1 });
    expect(formatHarnessProgress(update.state)).not.toContain("secret");
  });

  it("keeps tool executor commands, file changes, and tool results out of the timeline", () => {
    const longOutput = `명령: pnpm test · 위치: /repo · 출력: ${"검증 결과 ".repeat(100)}`;
    expect(formatHarnessProgressEvent({
      provider: "codex",
      event: {
        type: "operation-progress",
        label: "명령 실행 완료",
        detail: longOutput,
        eventType: "item/completed",
      },
    })).toBeNull();
    expect(formatHarnessProgressEvent({
      provider: "codex",
      event: {
        type: "operation-progress",
        label: "파일 수정 완료",
        detail: "update src/private.ts (+10 -2)",
        eventType: "item/completed",
      },
    })).toBeNull();
    expect(formatHarnessProgressEvent({
      provider: "claude",
      event: {
        type: "operation-progress",
        label: "Claude 도구 실행 완료",
        detail: "도구: internal/result · 결과: private output",
        eventType: "tool/completed",
      },
    })).toBeNull();
  });

  it("shows main-agent analysis text instead of a generic placeholder", () => {
    expect(formatHarnessProgressEvent({
      provider: "claude",
      event: { type: "agent-thought", text: "배포 전 dirty tree를 다시 확인합니다." },
    })).toContain("Claude Code 메인 에이전트 · 분석");
  });

  it("shows plans as main-agent work and omits empty or prompt-echo lifecycle events", () => {
    const plan = formatHarnessProgressEvent({
      provider: "codex",
      event: {
        type: "operation-progress",
        label: "계획 업데이트",
        detail: "1. 상태 확인 (completed) · 2. 회귀 테스트 (in_progress)",
        eventType: "turn/plan/updated",
      },
    });

    expect(plan).toContain("Codex 메인 에이전트 · 계획 업데이트");
    expect(plan).toContain("Harness workflow의 작업 순서와 완료 상태를 관리");
    expect(formatHarnessProgressEvent({
      provider: "codex",
      event: { type: "operation-progress", label: "생각 중", eventType: "item/started" },
    })).toBeNull();
    expect(formatHarnessProgressEvent({
      provider: "codex",
      event: {
        type: "operation-progress",
        label: "작업 단계 실행 중",
        detail: "$safe-release immutable harness Run ID: run-1 사용자 요청: 배포해줘",
        eventType: "item/started",
      },
    })).toBeNull();
    expect(formatHarnessProgressEvent({
      provider: "codex",
      event: { type: "codex-event", eventType: "turn/started" },
    })).toBeNull();
    expect(formatHarnessProgressEvent({
      provider: "codex",
      event: { type: "agent-message", text: "" },
    })).toBeNull();
  });

  it("identifies actual subagent control separately from Connector Worker tool execution", () => {
    const rendered = formatHarnessProgressEvent({
      provider: "codex",
      event: {
        type: "operation-progress",
        label: "도구 실행 중",
        detail: "도구: collaboration/spawn_agent · 입력: task_name=security_review, message=권한 경계를 검토해줘",
        eventType: "item/dynamicToolCall/progress",
      },
    });

    expect(rendered).toContain("Codex 하위 에이전트 제어");
    expect(rendered).toContain("독립 작업을 위임하거나 결과를 회수");
    expect(rendered).toContain("security_review");
    expect(rendered).not.toContain("Connector Worker");
  });
});
