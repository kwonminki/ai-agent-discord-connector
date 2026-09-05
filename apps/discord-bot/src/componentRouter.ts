export const COMPONENT_IDS = {
  answerCopyPrefix: "cdc:answer:copy:",
  syncDefault: "cdc:sync:25",
  syncAllDefault: "cdc:sync:all:25",
  syncSelectDefault: "cdc:sync:select:25",
  syncSelected: "cdc:sync:selected",
  syncModeOnChat: "cdc:sync:mode:on-chat",
  syncModeRealtime: "cdc:sync:mode:realtime",
  newGeneralChat: "cdc:chat:new:general",
  newCurrentFolderChat: "cdc:chat:new:current",
  newHereChat: "cdc:chat:new:here",
  chatResumeSelected: "cdc:chat:resume:selected",
  selfDevChat: "cdc:self:dev-chat",
  deletePreview: "cdc:delete:preview",
  deleteSessionSelected: "cdc:delete:session:selected",
  deleteChannelsConfirm: "cdc:delete:channels:confirm",
  deleteAllConfirm: "cdc:delete:all:confirm",
  archiveCurrentConfirm: "cdc:archive:current:confirm",
  fileSystemUp: "cdc:fs:up",
  fileSystemRefresh: "cdc:fs:refresh",
  fileSystemOpen: "cdc:fs:open",
  fileSystemView: "cdc:fs:view",
  fileSystemSummarize: "cdc:fs:summarize",
  fileSystemEdit: "cdc:fs:edit",
  palette: "cdc:palette",
  maintenancePanel: "cdc:maintenance:panel",
  codexAsk: "cdc:codex:ask",
  codexSubmit: "cdc:codex:submit",
  codexApprovalPrefix: "cdc:codex:approval:",
  codexUserInputSurveyPrefix: "cdc:codex:user-input:",
  agentSurveyPrefix: "cdc:agent:survey:",
  agentSurveyOtherPrefix: "cdc:survey:other:",
  gitDiff: "cdc:git:diff",
  gitStatus: "cdc:git:status",
  gitConflicts: "cdc:git:conflicts",
  gitReview: "cdc:git:review",
  testRun: "cdc:test:run",
  testFix: "cdc:test:fix",
  verifyTypecheck: "cdc:verify:typecheck",
  reloadCommands: "cdc:reload:commands",
  reloadRestartConfirm: "cdc:reload:restart:confirm",
  reloadRestartForceConfirm: "cdc:reload:restart:force:confirm",
  harnessRecommend: "cdc:harness:recommend",
  harnessApprove: "cdc:harness:approve",
  harnessPublish: "cdc:harness:publish",
  harnessPublishRun: "cdc:harness:publish-run",
  harnessStatus: "cdc:harness:status",
} as const;

export type AgentSurveyOtherTarget =
  | { kind: "user-input"; token: string }
  | { kind: "agent"; agent: "codex" | "claude" };

export function agentSurveyOtherCustomId(
  target: AgentSurveyOtherTarget,
): string {
  return target.kind === "user-input"
    ? `${COMPONENT_IDS.agentSurveyOtherPrefix}user-input:${target.token}`
    : `${COMPONENT_IDS.agentSurveyOtherPrefix}agent:${target.agent}`;
}

export function parseAgentSurveyOtherCustomId(
  customId: string,
): AgentSurveyOtherTarget | null {
  const userInputMatch = customId.match(
    /^cdc:survey:other:user-input:([A-Za-z0-9_-]{1,48})$/i,
  );
  if (userInputMatch) {
    return { kind: "user-input", token: userInputMatch[1] ?? "" };
  }

  const agentMatch = customId.match(/^cdc:survey:other:agent:(codex|claude)$/i);
  if (agentMatch) {
    return {
      kind: "agent",
      agent: agentMatch[1]?.toLowerCase() === "claude" ? "claude" : "codex",
    };
  }

  return null;
}

export function routeAgentSurveyOtherAnswer(
  target: AgentSurveyOtherTarget,
  answer: string,
): string | null {
  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) {
    return null;
  }

  if (target.kind === "user-input") {
    return `__cdc_codex_user_input ${target.token} ${encodeURIComponent(JSON.stringify([normalizedAnswer]))}`;
  }

  return `/queue prompt:${target.agent} Discord 미디어 설문에서 사용자가 자유 입력으로 답했습니다:\n- ${normalizedAnswer}\n이 답변을 반영해 작업을 이어가세요.`;
}

function componentShellCommand(command: string): string {
  return `__cdc_exec ${command}`;
}

function encodedNewChatCommand(input: {
  name: string | null;
  cwd: string | null;
  useCategory: boolean;
  initialPrompt: string | null;
}): string {
  return `__cdc_new_chat ${encodeURIComponent(JSON.stringify(input))}`;
}

function encodedHarnessCommand(action: "publish" | "publish-run" | "status"): string {
  return `__cdc_harness ${encodeURIComponent(JSON.stringify({ action }))}`;
}

function quoteShellToken(value: string): string | null {
  const normalized = value.replace(/\/$/, "").trim();

  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    /[\0\r\n`$;&|<>/]/.test(normalized)
  ) {
    return null;
  }

  if (/^[A-Za-z0-9._-]+$/.test(normalized)) {
    return normalized;
  }

  return `'${normalized.replace(/'/g, "'\\''")}'`;
}

function selectedSessionIds(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => /^[0-9a-f-]{32,36}$/i.test(value)),
    ),
  ];
}

function selectedSurveyAnswers(values: string[]): string[] {
  return values
    .map((value) => value.trim().replace(/^\d{1,2}:/, ""))
    .filter(Boolean)
    .slice(0, 25);
}

export function routeDiscordComponent(customId: string, values: string[] = []): string | null {
  const codexApprovalMatch = customId.match(
    /^cdc:codex:approval:([A-Za-z0-9_-]{1,48}):(accept|accept-session|decline|cancel)$/i,
  );

  if (codexApprovalMatch) {
    const decision = codexApprovalMatch[2] === "accept-session" ? "acceptForSession" : codexApprovalMatch[2];
    return `__cdc_codex_approval ${codexApprovalMatch[1]} ${decision}`;
  }

  const codexUserInputSurveyMatch = customId.match(/^cdc:codex:user-input:([A-Za-z0-9_-]{1,48})$/i);

  if (codexUserInputSurveyMatch) {
    const answers = selectedSurveyAnswers(values);
    return answers.length > 0
      ? `__cdc_codex_user_input ${codexUserInputSurveyMatch[1]} ${encodeURIComponent(JSON.stringify(answers))}`
      : null;
  }

  const agentSurveyMatch = customId.match(/^cdc:agent:survey:(codex|claude)$/i);

  if (agentSurveyMatch) {
    const answers = selectedSurveyAnswers(values);
    if (answers.length === 0) {
      return null;
    }

    const agentPrefix = agentSurveyMatch[1]?.toLowerCase() === "claude" ? "claude" : "codex";
    const answerText = answers.map((answer) => `- ${answer}`).join("\n");
    return `/queue prompt:${agentPrefix} Discord 미디어 설문에서 사용자가 다음 항목을 선택했습니다:\n${answerText}\n이 선택을 반영해 작업을 이어가세요.`;
  }

  const pageMatch = customId.match(/^cdc:fs:page:(\d+)$/);

  if (pageMatch) {
    return componentShellCommand(`__cdc_ls ${pageMatch[1]}`);
  }

  const deleteSessionConfirmMatch = customId.match(/^cdc:delete:session:([A-Za-z0-9._:-]{1,128}):confirm$/);

  if (deleteSessionConfirmMatch) {
    return `sync delete session ${deleteSessionConfirmMatch[1]} confirm`;
  }

  switch (customId) {
    case COMPONENT_IDS.syncDefault:
      return "sync select 25";
    case COMPONENT_IDS.syncAllDefault:
      return "sync all 25";
    case COMPONENT_IDS.syncSelectDefault:
      return "sync select 25";
    case COMPONENT_IDS.syncModeOnChat:
      return "sync mode on-chat";
    case COMPONENT_IDS.syncModeRealtime:
      return "sync mode realtime";
    case COMPONENT_IDS.newGeneralChat:
      return "chat new";
    case COMPONENT_IDS.newCurrentFolderChat:
      return "chat new current";
    case COMPONENT_IDS.newHereChat:
      return "chat new current";
    case COMPONENT_IDS.selfDevChat:
      return encodedNewChatCommand({
        name: "봇 유지보수",
        cwd: ".",
        useCategory: true,
        initialPrompt:
          "이 세션은 AI Agent Discord Connector 봇 자체를 Discord에서 유지보수하기 위한 세션입니다. 변경 전 Git 상태를 확인하고, 수정 후 pnpm typecheck와 pnpm test를 실행한 뒤, Discord에서 reload 또는 봇 재시작으로 반영할 수 있게 안내해줘.",
      });
    case COMPONENT_IDS.syncSelected: {
      const sessionIds = selectedSessionIds(values);
      return sessionIds.length > 0 ? `sync selected ${sessionIds.join(" ")}` : null;
    }
    case COMPONENT_IDS.deletePreview:
      return "sync delete preview";
    case COMPONENT_IDS.deleteSessionSelected: {
      const sessionId = values[0]?.trim();
      return sessionId && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)
        ? `sync delete session ${sessionId}`
        : null;
    }
    case COMPONENT_IDS.chatResumeSelected: {
      const sessionId = values[0]?.trim();
      return sessionId && /^[A-Za-z0-9-]{8,64}$/.test(sessionId)
        ? `chat resume ${sessionId}`
        : null;
    }
    case COMPONENT_IDS.deleteChannelsConfirm:
      return "sync delete channels confirm";
    case COMPONENT_IDS.deleteAllConfirm:
      return "sync delete all confirm";
    case COMPONENT_IDS.archiveCurrentConfirm:
      return "archive confirm";
    case COMPONENT_IDS.maintenancePanel:
      return "maintenance";
    case COMPONENT_IDS.harnessRecommend:
      return "모르는 부분은 안전한 기본값을 추천해서 계속 설계해줘.";
    case COMPONENT_IDS.harnessApprove:
      return "방금 보여준 설계 그대로 하네스를 만들어줘.";
    case COMPONENT_IDS.harnessPublish:
      return encodedHarnessCommand("publish");
    case COMPONENT_IDS.harnessPublishRun:
      return encodedHarnessCommand("publish-run");
    case COMPONENT_IDS.harnessStatus:
      return encodedHarnessCommand("status");
    case COMPONENT_IDS.fileSystemUp:
      return componentShellCommand("cd ..");
    case COMPONENT_IDS.fileSystemRefresh:
      return componentShellCommand("__cdc_ls 0");
    case COMPONENT_IDS.fileSystemOpen: {
      const target = quoteShellToken(values[0] ?? "");
      return target ? componentShellCommand(`__cdc_open ${target}`) : null;
    }
    case COMPONENT_IDS.fileSystemView: {
      const target = quoteShellToken(values[0] ?? "");
      return target ? componentShellCommand(`__cdc_view ${target}`) : null;
    }
    case COMPONENT_IDS.fileSystemSummarize: {
      const target = quoteShellToken(values[0] ?? "");
      return target ? `codex 선택한 파일을 요약해줘: ${target}` : null;
    }
    case COMPONENT_IDS.fileSystemEdit: {
      const target = quoteShellToken(values[0] ?? "");
      return target ? `codex 선택한 파일을 개선하거나 수정해줘. 파일: ${target}` : null;
    }
    case COMPONENT_IDS.palette: {
      switch (values[0]) {
        case "browse":
          return componentShellCommand("__cdc_ls 0");
        case "where":
          return "where";
        case "sync-status":
          return "sync status";
        case "reload-commands":
          return "reload commands";
        case "git-status":
          return componentShellCommand("git status --short");
        case "git-diff":
          return componentShellCommand("git diff --stat");
        case "git-conflicts":
          return componentShellCommand("git diff --check");
        case "test":
          return componentShellCommand("pnpm test");
        case "codex-summary":
          return "codex 현재 프로젝트 상태를 요약하고 다음 액션을 제안해줘";
        case "codex-review":
          return "__cdc_codex_review 현재 변경사항을 리뷰하고 위험한 부분을 알려줘";
        case "fix-tests":
          return "codex 테스트를 실행하고 실패 원인을 분석한 뒤 수정해줘. 수정 후 테스트를 다시 실행해줘";
        default:
          return null;
      }
    }
    case COMPONENT_IDS.gitDiff:
      return componentShellCommand("git diff --stat");
    case COMPONENT_IDS.gitStatus:
      return componentShellCommand("git status --short");
    case COMPONENT_IDS.gitConflicts:
      return componentShellCommand("git diff --check");
    case COMPONENT_IDS.gitReview:
      return "__cdc_codex_review 현재 변경사항을 리뷰하고 위험한 부분을 알려줘";
    case COMPONENT_IDS.testRun:
      return componentShellCommand("pnpm test");
    case COMPONENT_IDS.testFix:
      return "codex 테스트 실패를 분석하고 수정해줘. 수정 후 테스트도 다시 실행해줘";
    case COMPONENT_IDS.verifyTypecheck:
      return componentShellCommand("pnpm typecheck");
    case COMPONENT_IDS.reloadCommands:
      return "reload commands";
    case COMPONENT_IDS.reloadRestartConfirm:
      return "reload restart confirm";
    case COMPONENT_IDS.reloadRestartForceConfirm:
      return "reload restart force confirm";
    default:
      return null;
  }
}
