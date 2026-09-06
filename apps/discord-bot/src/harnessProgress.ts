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
  return stripHarnessBuilderBlocks(value)
    .replace(/@/g, "[at]")
    .trim();
}

function visibleEventDetail(value: string): string {
  return value.replace(/@/g, "[at]").trim();
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

function agentLabel(provider: HarnessProvider): string {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function commandPurpose(stage: string): string {
  if (stage === "검증") {
    return "변경 사항이 요구 조건과 회귀 검증을 통과하는지 확인";
  }
  if (stage === "커밋·발행") {
    return "검증된 변경을 버전 관리하고 발행";
  }
  if (stage === "서비스 적용") {
    return "실제 Connector 서비스 상태를 확인하거나 안전하게 적용";
  }
  if (stage === "조사") {
    return "코드·Git·프로세스 상태에서 다음 판단의 근거를 수집";
  }
  return "메인 에이전트가 선택한 작업을 로컬 환경에서 실행";
}

function commandOutcome(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const exitCode = value.match(/(?:^|\s+·\s+)종료 코드:\s*(-?\d+)/)?.[1];
  const duration = value.match(/(?:^|\s+·\s+)소요:\s*([^·]+)/)?.[1]?.trim();
  const parts = [
    exitCode === undefined ? null : `종료 코드 ${exitCode}`,
    duration ? `소요 ${duration}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function shouldHideOperationEvent(event: Extract<AgentPromptProgressEvent, { type: "operation-progress" }>): boolean {
  const detail = visibleEventDetail(event.detail ?? "");

  if (event.label === "답변 작성 중") {
    return true;
  }
  if ((event.label === "생각 중" || event.label === "생각 정리") && !detail) {
    return true;
  }
  if (!detail) {
    return true;
  }

  // Codex app-server can surface the injected Harness prompt itself as a
  // generic item. It is neither Worker activity nor useful progress and can
  // expose a very long duplicate of the user's request.
  return /^\$[a-z0-9._-]+\b/i.test(detail) && (
    /immutable harness/i.test(detail) ||
    /Run ID:/i.test(detail) ||
    /사용자 요청:/i.test(detail)
  );
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
    return `${agentLabel(state.provider)} 도구 실행기 (Connector Worker)`;
  }
  if (state.activeRole === "gateway") {
    return "Discord Gateway";
  }
  return `${agentLabel(state.provider)} 메인 에이전트`;
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
    state.latestReport = compact(report, MAX_REPORT_LENGTH);
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

  if (shouldHideOperationEvent(event)) {
    return { state, significant: false, report: null };
  }

  if (event.label === "계획 업데이트") {
    state.stage = "계획";
    state.activeRole = "agent";
    state.activeDetail = `작업 순서와 완료 상태 갱신 · ${compact(event.detail ?? "작업 계획을 갱신했습니다.", MAX_DETAIL_LENGTH)}`;
    return { state, significant: true, report: null };
  }

  if (event.label === "파일 수정 중" || event.label === "파일 수정 완료") {
    state.stage = "구현";
    state.activeRole = "worker";
    state.activeDetail = `변경 구현 · ${compact(event.detail ?? event.label, MAX_DETAIL_LENGTH)}`;
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
    state.activeDetail = `${commandPurpose(classification.stage)} · ${detail}`;
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
    state.activeDetail = compact(event.detail ?? (event.label === "생각 중"
      ? "다음 안전한 작업을 검토하고 있습니다."
      : "검토를 마치고 다음 작업으로 이동합니다."), MAX_DETAIL_LENGTH);
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
  const currentAgentLabel = agentLabel(state.provider);
  const statusLabel = status === "completed" ? "완료" : status === "failed" ? "실패" : "실행 중";
  return [
    `🧰 **Harness ${statusLabel}** · ${state.harnessVersionId}`,
    `- run: \`${state.runId}\``,
    `- session: ${state.sessionId ? `\`${state.sessionId}\`` : "연결 중"}`,
    "",
    "**역할**",
    `- 메인 에이전트 · ${currentAgentLabel}: 이 스레드의 대화와 판단을 이어가는 주체`,
    `- 도구 실행기 · Connector Worker: ${currentAgentLabel}가 지시한 명령·편집·검증을 수행하며 별도의 판단 Agent는 아님`,
    `- 하위 에이전트 · ${currentAgentLabel} subagent: 실제로 위임된 경우에만 이름과 맡은 일을 표시`,
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
  const currentAgentLabel = agentLabel(input.provider);
  return `💬 **${currentAgentLabel} 메인 에이전트 · 진행 보고**\n${input.report}`;
}

export function formatHarnessProgressEvent(input: {
  provider: HarnessProvider;
  event: AgentPromptProgressEvent;
}): string | null {
  const currentAgentLabel = agentLabel(input.provider);
  const event = input.event;

  if (event.type === "thread-started") {
    return [
      "🔗 **Discord Gateway · Agent session 연결**",
      `- ${currentAgentLabel} session: \`${visibleEventDetail(event.sessionId)}\``,
      `- 역할: ${currentAgentLabel}와 Connector Worker의 실행 이벤트를 이 스레드에 전달`,
    ].join("\n");
  }

  if (event.type === "agent-message") {
    const report = visibleReport(event.text);
    if (!report) {
      return null;
    }
    return formatHarnessProgressReport({
      provider: input.provider,
      report,
    });
  }

  if (event.type === "agent-thought") {
    const thought = visibleEventDetail(event.text);
    if (!thought) {
      return null;
    }
    return [
      `🧠 **${currentAgentLabel} 메인 에이전트 · 분석**`,
      "- 역할: 현재 대화 문맥에서 다음 행동을 판단",
      `- 판단: ${thought}`,
    ].join("\n");
  }

  if (event.type === "operation-progress") {
    if (shouldHideOperationEvent(event)) {
      return null;
    }

    const detail = visibleEventDetail(event.detail ?? "");

    if (event.label === "계획 업데이트") {
      return [
        `🗺️ **${currentAgentLabel} 메인 에이전트 · 계획 업데이트**`,
        "- 역할: Harness workflow의 작업 순서와 완료 상태를 관리",
        `- 계획: ${detail}`,
      ].join("\n");
    }

    if (event.label === "생각 중" || event.label === "생각 정리") {
      return [
        `🧠 **${currentAgentLabel} 메인 에이전트 · 분석**`,
        "- 역할: 현재 대화 문맥에서 다음 행동을 판단",
        `- 판단: ${detail}`,
      ].join("\n");
    }

    if (event.label === "명령 실행 중" || event.label === "명령 실행 완료") {
      const command = commandDetail(event.detail);
      const classification = commandStage(command);
      const outcome = event.label === "명령 실행 완료" ? commandOutcome(event.detail) : null;
      return [
        `⚙️ **${currentAgentLabel} 도구 실행기 (Connector Worker) · ${visibleEventDetail(event.label)}**`,
        `- 역할: ${currentAgentLabel} 메인 에이전트가 선택한 로컬 명령을 실행`,
        `- 목적: ${commandPurpose(classification.stage)}`,
        `- 명령: ${command}`,
        outcome ? `- 결과: ${outcome}` : null,
      ].filter((line): line is string => line !== null).join("\n");
    }

    if (event.label === "파일 수정 중" || event.label === "파일 수정 완료") {
      return [
        `📝 **${currentAgentLabel} 도구 실행기 (Connector Worker) · ${visibleEventDetail(event.label)}**`,
        `- 역할: ${currentAgentLabel} 메인 에이전트가 결정한 변경을 파일에 반영`,
        "- 목적: 코드 또는 문서 변경 구현",
        `- 대상: ${compact(detail, MAX_REPORT_LENGTH)}`,
      ].join("\n");
    }

    const isSubagentControl = /(?:subagent|spawn_agent|send_message|followup_task|wait_agent|collaboration[./])/i.test(
      `${event.label} ${detail} ${event.eventType}`,
    );
    if (isSubagentControl) {
      return [
        `🧑‍🤝‍🧑 **${currentAgentLabel} 하위 에이전트 제어 · ${visibleEventDetail(event.label)}**`,
        "- 역할: 메인 에이전트가 독립 작업을 위임하거나 결과를 회수",
        `- 맡은 일: ${compact(detail, MAX_REPORT_LENGTH)}`,
      ].join("\n");
    }

    return [
      `🔧 **${currentAgentLabel} 도구 실행기 (Connector Worker) · ${visibleEventDetail(event.label) || "작업 이벤트"}**`,
      `- 역할: ${currentAgentLabel} 메인 에이전트가 요청한 도구 작업을 수행`,
      `- 목적/내용: ${compact(detail, MAX_REPORT_LENGTH)}`,
    ].join("\n");
  }

  return null;
}
