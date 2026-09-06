import { describe, expect, it } from "vitest";
import {
  applyHarnessProgressEvent,
  createHarnessProgressState,
  formatHarnessProgress,
  formatHarnessProgressEvent,
} from "./harnessProgress.js";

describe("harness progress", () => {
  it("shows the real coordinator, worker, and gateway roles", () => {
    const state = createHarnessProgressState({
      provider: "codex",
      harnessVersionId: "safe-review@1.0.0#abc",
      runId: "run-1",
      now: "2026-09-05T20:00:00.000Z",
    });

    expect(formatHarnessProgress(state)).toContain("조정자 · Codex");
    expect(formatHarnessProgress(state)).toContain("실행기 · 격리 Worker");
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
    expect(update.state.activeDetail).toBe("pnpm test -- --runInBand");
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

  it("renders every event with its full visible detail", () => {
    const longOutput = `명령: pnpm test · 위치: /repo · 출력: ${"검증 결과 ".repeat(100)}`;
    const rendered = formatHarnessProgressEvent({
      provider: "codex",
      event: {
        type: "operation-progress",
        label: "명령 실행 완료",
        detail: longOutput,
        eventType: "item/completed",
      },
    });

    expect(rendered).toContain(longOutput.trim());
    expect(rendered).toContain("격리 Worker · 명령 실행 완료");
    expect(rendered).toContain("item/completed");
  });

  it("shows coordinator analysis text instead of a generic placeholder", () => {
    expect(formatHarnessProgressEvent({
      provider: "claude",
      event: { type: "agent-thought", text: "배포 전 dirty tree를 다시 확인합니다." },
    })).toContain("배포 전 dirty tree를 다시 확인합니다.");
  });
});
