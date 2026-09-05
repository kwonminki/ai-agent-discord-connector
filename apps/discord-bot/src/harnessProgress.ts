import { stripHarnessBuilderBlocks } from "../../../packages/core/src/index.js";
import type { AgentPromptProgressEvent } from "./controlApiClient.js";
import type { HarnessProvider } from "../../../packages/core/src/index.js";

export type HarnessProgressRole = "agent" | "worker" | "gateway";

export interface HarnessProgressState {
  provider: HarnessProvider;
  harnessVersionId: string;
  runId: string;
  sessionId: string | null;
  stage: string;
  activeRole: HarnessProgressRole;
  activeDetail: string;
  latestReport: string | null;
  agentReports: number;
  commands: number;
  fileEdits: number;
  checks: number;
  updatedAt: string;
}

export interface HarnessProgressUpdate {
  state: HarnessProgressState;
  significant: boolean;
  report: string | null;
}

const MAX_DETAIL_LENGTH = 420;
const MAX_REPORT_LENGTH = 700;

function compact(value: string, maxLength: number): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/`{3,}/g, "`")
    .replace(/@/g, "[at]")
    .trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function visibleReport(value: string): string {
  return compact(stripHarnessBuilderBlocks(value), MAX_REPORT_LENGTH);
}

function commandDetail(value: string | undefined): string {
  if (!value) {
    return "명령을 실행하고 있습니다.";
  }
  const command = value.match(/(?:^|\s)명령:\s*([\s\S]*?)(?:\s+·\s+위치:|$)/)?.[1] ?? value;
  return compact(command, MAX_DETAIL_LENGTH);
}

function commandStage(detail: string): { stage: string; checks: number } {
  if (/\b(?:vitest|jest|pytest|pnpm\s+(?:test|typecheck)|npm\s+test|cargo\s+test|go\s+test|tsc\b|typecheck|lint\b|package\s+dry|pack\s+--dry)/i.test(detail)) {
    return { stage: "검증", checks: 1 };
  }
  if (/\bgit\s+(?:commit|push|tag)\b/i.test(detail)) {
    return { stage: "커밋·발행", checks: 0 };
  }
  if (/\b(?:launchctl|systemctl|service)\b|Gateway|worker\s+PID/i.test(detail)) {
    return { stage: "서비스 적용", checks: 0 };
  }
  if (/\b(?:rg|sed|jq|git\s+(?:status|diff|log|show)|find|ps|df)\b/i.test(detail)) {
    return { stage: "조사", checks: 0 };
  }
  return { stage: "실행", checks: 0 };
}

function reportStage(report: string): string {
  if (/Gateway|서비스|PID|재시작|launchd|systemd/i.test(report)) {
    return "서비스 적용";
  }
  if (/커밋|commit|push|브랜치/i.test(report)) {
    return "커밋·발행";
  }
  if (/테스트|검증|typecheck|lint|회귀/i.test(report)) {
    return "검증";
  }
  if (/수정|구현|반영|편집/i.test(report)) {
    return "구현";
  }
  return "분석·조정";
}

function roleLabel(state: HarnessProgressState): string {
  if (state.activeRole === "worker") {
    return "격리 Worker";
  }
  if (state.activeRole === "gateway") {
    return "Discord Gateway";
  }
  return state.provider === "claude" ? "Claude Code 조정자" : "Codex 조정자";
}

export function createHarnessProgressState(input: {
  provider: HarnessProvider;
  harnessVersionId: string;
  runId: string;
  sessionId?: string | null;
  now?: string;
}): HarnessProgressState {
  return {
    provider: input.provider,
    harnessVersionId: input.harnessVersionId,
    runId: input.runId,
    sessionId: input.sessionId ?? null,
    stage: input.sessionId ? "작업 준비" : "세션 연결",
    activeRole: "gateway",
    activeDetail: input.sessionId
      ? "기존 실행을 다시 연결하고 있습니다."
      : "실행 스레드와 Agent session을 연결하고 있습니다.",
    latestReport: null,
    agentReports: 0,
    commands: 0,
    fileEdits: 0,
    checks: 0,
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

export function applyHarnessProgressEvent(
  current: HarnessProgressState,
  event: AgentPromptProgressEvent,
  now = new Date().toISOString(),
): HarnessProgressUpdate {
  const state = { ...current, updatedAt: now };

  if (event.type === "thread-started") {
    state.sessionId = event.sessionId;
    state.stage = "세션 연결";
    state.activeRole = "gateway";
    state.activeDetail = "Agent session 연결을 확인했고 작업 이벤트를 전달하고 있습니다.";
    return { state, significant: true, report: null };
  }

  if (event.type === "agent-message") {
    const report = visibleReport(event.text);
    if (!report) {
      return { state, significant: false, report: null };
    }
    state.stage = reportStage(report);
    state.activeRole = "agent";
    state.activeDetail = "진행 상황과 다음 판단을 정리했습니다.";
    state.latestReport = report;
    state.agentReports += 1;
    return { state, significant: true, report };
  }

  if (event.type === "agent-thought") {
    state.stage = "분석·조정";
    state.activeRole = "agent";
    state.activeDetail = "다음 안전한 작업을 검토하고 있습니다.";
    return { state, significant: false, report: null };
  }

  if (event.type !== "operation-progress") {
    return { state, significant: false, report: null };
  }

  if (event.label === "계획 업데이트") {
    state.stage = "계획";
    state.activeRole = "agent";
    state.activeDetail = compact(event.detail ?? "작업 계획을 갱신했습니다.", MAX_DETAIL_LENGTH);
    return { state, significant: true, report: null };
  }

  if (event.label === "파일 수정 중" || event.label === "파일 수정 완료") {
    state.stage = "구현";
    state.activeRole = "worker";
    state.activeDetail = compact(event.detail ?? event.label, MAX_DETAIL_LENGTH);
    if (event.label === "파일 수정 완료") {
      state.fileEdits += 1;
    }
    return { state, significant: event.label === "파일 수정 완료", report: null };
  }

  if (event.label === "명령 실행 중" || event.label === "명령 실행 완료") {
    const detail = commandDetail(event.detail);
    const classification = commandStage(detail);
    state.stage = classification.stage;
    state.activeRole = "worker";
    state.activeDetail = detail;
    if (event.label === "명령 실행 완료") {
      state.commands += 1;
      state.checks += classification.checks;
    }
    return {
      state,
      significant: event.label === "명령 실행 완료" && classification.checks > 0,
      report: null,
    };
  }

  if (event.label === "생각 중" || event.label === "생각 정리") {
    state.stage = "분석·조정";
    state.activeRole = "agent";
    state.activeDetail = event.label === "생각 중"
      ? "다음 안전한 작업을 검토하고 있습니다."
      : "검토를 마치고 다음 작업으로 이동합니다.";
    return { state, significant: false, report: null };
  }

  state.activeRole = "worker";
  state.activeDetail = compact(event.detail ?? event.label ?? "작업 중", MAX_DETAIL_LENGTH);
  return { state, significant: false, report: null };
}

export function formatHarnessProgress(
  state: HarnessProgressState,
  status: "running" | "completed" | "failed" = "running",
): string {
  const agentLabel = state.provider === "claude" ? "Claude Code" : "Codex";
  const statusLabel = status === "completed" ? "완료" : status === "failed" ? "실패" : "실행 중";
  return [
    `🧰 **Harness ${statusLabel}** · ${state.harnessVersionId}`,
    `- run: \`${state.runId}\``,
    `- session: ${state.sessionId ? `\`${state.sessionId}\`` : "연결 중"}`,
    "",
    "**역할**",
    `- 조정자 · ${agentLabel}: Harness 규칙 적용, 계획 수립, 판단과 진행 보고`,
    "- 실행기 · 격리 Worker: 명령 실행, 파일 편집, 테스트와 검증",
    "- 전달자 · Discord Gateway: 진행 카드 갱신, 질문과 최종 결과 전달",
    "",
    `**현재 단계** · ${state.stage}`,
    `- 현재 담당: ${roleLabel(state)}`,
    `- 하는 일: ${state.activeDetail}`,
    state.latestReport ? `- 최근 보고: ${state.latestReport}` : null,
    `- 누적 활동: 진행 보고 ${state.agentReports} · 명령 ${state.commands} · 파일 수정 ${state.fileEdits} · 검증 ${state.checks}`,
    `- 갱신: ${state.updatedAt}`,
  ].filter((line): line is string => line !== null).join("\n");
}

export function formatHarnessProgressReport(input: {
  provider: HarnessProvider;
  report: string;
}): string {
  const agentLabel = input.provider === "claude" ? "Claude Code" : "Codex";
  return `💬 **${agentLabel} 조정자 진행 보고**\n${input.report}`;
}
