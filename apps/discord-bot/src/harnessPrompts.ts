import {
  HARNESS_INTERVIEW_SECTION_KEYS,
  HARNESS_MIN_INTERVIEW_TURNS,
  harnessInterviewCoverage,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";
import type { HarnessBuildState, HarnessRunState, PublishedHarnessVersionState } from "./harnessStore.js";
import { COMPONENT_IDS } from "./componentRouter.js";
import type { DiscordMessagePayload } from "./responses.js";

const BUILDER_CONTRACT = `당신은 AI Agent Discord Connector의 Harness Builder입니다. 당신의 일은 즉시 파일을 쓰는 것이 아니라, 사용자가 실제로 원하는 재사용 가능한 agent workflow를 인터뷰로 발견하고 설계한 뒤 확인받아 Harness 파일로 만드는 것입니다.

사용자는 harness, skill, agent, YAML/JSON 구조를 몰라도 됩니다. 내부 구현 필드를 묻지 말고 현실적인 작업 상황을 묻습니다. 답변에서 안전한 기본값을 추론하되, 추론한 내용도 최종 설계 요약에서 사용자가 확인하게 하세요.

반드시 다음 순서를 지키세요.

1. discovery: 어떤 상황에서 무엇을 해결해야 하는지와 실제 요청 예시를 묻습니다.
2. design: 입력/문맥, 단계와 의사결정, 도구·참고자료·역할, 권한과 금지사항, 실패 시 질문/중단 조건, 산출물과 성공 기준, 검증 사례를 구체화합니다.
3. review: 9개 설계 영역을 모두 채운 완성 설계안을 사람이 읽기 쉬운 체크리스트로 보여주고, "이 설계대로 만들까요, 수정할 부분이 있나요?"라고 명시적으로 확인합니다. 이 답변에서는 Harness 후보를 만들지 않습니다.
4. ready: 사용자가 직전 설계안을 명시적으로 승인한 다음 답변에서만 동일한 설계를 바탕으로 최종 파일을 만듭니다. 수정 요청이면 design으로 돌아가 수정된 설계를 다시 review해야 합니다.

인터뷰 원칙:
- 최소 3회의 Builder 응답으로 설계를 탐색·구체화·검토하고, 최소 4번째 응답에서만 최종 후보를 만들 수 있습니다.
- 한 번에 하나의 주제를 중심으로 질문하되 서로 밀접한 세부사항은 2~3개 bullet로 함께 물어도 됩니다.
- 이미 답한 내용을 다시 묻지 말고, 저장된 설계 브리프의 빈 부분과 모호한 부분을 우선합니다.
- 사용자가 준 실제 예시를 최소 하나 확보하고, 정상 사례와 실패/경계 사례를 validationCases에 반영합니다.
- 기술 포맷이나 YAML/JSON 필드를 사용자에게 채우라고 요구하지 않습니다.
- 현재 작업 폴더의 문맥이 필요하면 읽기 전용으로 살펴볼 수 있지만 파일을 만들거나 수정하지 않습니다.
- 사용자가 "알아서 해줘"라고 하면 합리적인 기본값을 제안하되, review 단계에서 그 가정을 분명히 보여줍니다.
- 사용자가 빨리 완성하라고 해도 미확인 필수 설계가 있으면 가장 중요한 질문을 계속합니다.
- discovery/design의 openQuestions에는 실제로 사용자의 답이 더 필요한 설계 질문만 넣습니다.
- review/ready에서는 모든 설계 결정을 확정하고 openQuestions를 반드시 빈 배열([])로 둡니다. 사용자에게 묻는 최종 승인 문장은 openQuestions가 아닙니다. 아직 결정할 질문이 하나라도 있으면 review로 가지 말고 design을 유지합니다.

파일 설계 원칙:
- SKILL.md에는 핵심 절차만 간결하게 두고 세부 지식은 references/로 분리합니다.
- 반복적이고 결정적으로 수행해야 하는 로직, 제공된 문서, 재사용 자산이 각각 필요한지 판단합니다. 이 Harness 버전은 실행 scripts를 허용하지 않으므로 필요한 결정적 로직은 명확한 절차 또는 tests/의 검증 사례로 표현합니다.
- subagent가 실제로 역할 분리나 병렬 검증에 도움이 될 때만 agents/*.md를 만들고, 불필요하면 단일 agent 흐름을 택합니다.
- background/detached agent, hook, MCP 설정, 외부 다운로드는 만들지 않습니다.
- Codex와 Claude Code에서 같은 핵심 workflow가 동작해야 합니다. agents/*.md는 Claude를 강화할 수 있지만 SKILL.md만으로도 Codex가 역할과 절차를 이해하게 작성합니다.

매 답변 맨 끝에는 현재 설계를 아래 숨김 블록으로 정확히 한 번 출력하세요. 사용자가 보는 본문에는 자연스러운 질문 또는 설계 요약만 씁니다. 아직 답이 없는 section은 null로 유지하고, 추측으로 채웠다면 본문 review에서 그 가정을 드러냅니다.

숨김 블록은 반드시 JSON.parse가 읽을 수 있는 strict JSON이어야 합니다. property name과 문자열에는 큰따옴표만 쓰고, trailing comma, 주석, JSON 바깥 설명을 블록 안에 넣지 마세요.

\`\`\`codex-discord-harness-brief
{
  "schemaVersion": 1,
  "phase": "discovery | design | review | ready",
  "sections": {
    "purposeAndTriggers": "해결 목표와 언제 발동할지 또는 null",
    "usageExamples": "실제 사용자 요청 예시 또는 null",
    "inputsAndContext": "필요 입력과 작업 문맥 또는 null",
    "workflowAndDecisions": "세부 단계와 분기 기준 또는 null",
    "outputsAndSuccess": "산출물 형식과 성공 기준 또는 null",
    "constraintsAndPermissions": "권한, 안전 제약, 금지사항 또는 null",
    "resourcesAndRoles": "참고자료, 자산, 도구, agent 역할 또는 null",
    "failuresAndEscalation": "실패·모호함·중단 시 행동 또는 null",
    "validationCases": "정상 및 실패/경계 검증 사례 또는 null"
  },
  "openQuestions": ["아직 답해야 하는 설계 질문"],
  "userConfirmed": false
}
\`\`\`

ready 단계에서만 위 브리프 다음에 아래 후보 블록을 정확히 한 번 출력하세요. 직전 review와 브리프 내용이 한 글자라도 달라졌다면 후보를 만들지 말고 다시 review하세요.

\`\`\`codex-discord-harness
{
  "manifest": {
    "id": "lowercase-harness-id",
    "name": "lowercase-skill-name",
    "description": "언제 이 workflow를 사용해야 하는지 명확한 설명",
    "version": "1.0.0",
    "providers": ["codex", "claude"],
    "maxSubagents": 0,
    "outputs": ["사용자가 받게 될 산출물"]
  },
  "files": [
    {
      "path": "SKILL.md",
      "content": "---\\nname: lowercase-skill-name\\ndescription: 언제 이 skill을 사용해야 하는지 명확한 설명\\n---\\n\\n명령형으로 작성한 workflow"
    }
  ]
}
\`\`\`

허용 파일은 SKILL.md, agents/*.md, references/**, tests/**, assets/**뿐입니다. SKILL.md frontmatter에는 name과 description만 넣으세요. manifest.name과 SKILL.md name은 같아야 합니다. agents/*.md에는 name과 description을 포함하고 background, hooks, mcpServers, permissionMode를 넣지 마세요.`;

const HARNESS_HELP: Record<ConnectorLocale, string> = {
  ko: [
    "🧰 **Harness 사용법**",
    "Harness는 반복 작업을 문답으로 설계해 두고, 검증된 불변 버전으로 다시 실행하는 기능입니다. 설계용 Builder와 실제 실행 세션은 분리됩니다.",
    "",
    "**1. 만들기 · `/harness create`**",
    "`goal`에 만들고 싶은 반복 작업만 입력하세요. 현재 대화를 이어갈지와 스레드 이름은 선택사항입니다.",
    "",
    "**2. Builder와 대화하기**",
    "질문에 평소 말하듯 답하세요. 모르는 부분은 `추천해줘`라고 해도 됩니다. 마지막 설계가 맞으면 `이대로 만들어줘`라고 답하세요.",
    "",
    "**3. 발행하고 실행하기 · `/harness publish-run`**",
    "확정된 후보를 발행하고 별도 실행 스레드를 엽니다. 첫 요청은 선택사항이라 나중에 입력해도 됩니다.",
    "",
    "**발행본 다시 쓰기 · `/harness run`**",
    "목록에서 Harness를 고르세요. 버전을 생략하면 최신 발행본을 사용합니다.",
    "",
    "상태 `/harness status` · 목록 `/harness list` · 발행만 `/harness publish` · 연결 해제 `/harness leave` · Builder 취소 `/harness cancel`",
  ].join("\n"),
  en: [
    "🧰 **Harness help**",
    "A Harness captures a repeatable workflow through conversation and runs it from a verified immutable version. Builder and execution sessions stay separate.",
    "",
    "**1. Create · `/harness create`**",
    "Enter only the required `goal`. Reusing the current context and naming the thread are optional choices.",
    "",
    "**2. Talk with the Builder**",
    "Answer naturally. Say `recommend one` when unsure. After reviewing the final design, say `build it as shown` to approve it.",
    "",
    "**3. Publish and run · `/harness publish-run`**",
    "Publish the approved candidate and open a separate execution thread. The first request is optional.",
    "",
    "**Reuse a published Harness · `/harness run`**",
    "Pick a Harness from autocomplete. Omit the version to use its latest release.",
    "",
    "Status `/harness status` · list `/harness list` · publish only `/harness publish` · detach `/harness leave` · cancel Builder `/harness cancel`",
  ].join("\n"),
  zh: [
    "🧰 **Harness 使用帮助**",
    "Harness 通过对话保存可重复工作流，并以已验证的不可变版本运行。设计 Builder 与实际执行会话相互分离。",
    "",
    "**1. 创建 · `/harness create`**",
    "只需填写必填的 `goal`。是否沿用当前上下文以及线程名称均为可选项。",
    "",
    "**2. 与 Builder 对话**",
    "用自然语言回答即可。不确定时可以让它推荐。确认最终设计后，明确回复按该设计创建。",
    "",
    "**3. 发布并运行 · `/harness publish-run`**",
    "发布已确认的候选版本，并打开独立执行线程。首次请求可留空。",
    "",
    "**复用发布版本 · `/harness run`**",
    "从自动完成列表选择 Harness；省略版本时使用最新发布版。",
    "",
    "状态 `/harness status` · 列表 `/harness list` · 仅发布 `/harness publish` · 解除关联 `/harness leave` · 取消 Builder `/harness cancel`",
  ].join("\n"),
  ja: [
    "🧰 **Harness ヘルプ**",
    "Harness は反復作業を対話で設計し、検証済みの不変バージョンとして実行する機能です。Builder と実行セッションは分離されます。",
    "",
    "**1. 作成 · `/harness create`**",
    "必須の `goal` だけ入力してください。現在の文脈を引き継ぐかどうかとスレッド名は任意です。",
    "",
    "**2. Builder と対話**",
    "普段の言葉で答えてください。不明な点はおすすめを依頼できます。最終設計を確認したら、その内容で作成するよう明示します。",
    "",
    "**3. 公開して実行 · `/harness publish-run`**",
    "承認済み候補を公開し、別の実行スレッドを開きます。最初の依頼は任意です。",
    "",
    "**公開済み Harness の再利用 · `/harness run`**",
    "オートコンプリートから Harness を選びます。バージョンを省略すると最新版を使います。",
    "",
    "状態 `/harness status` · 一覧 `/harness list` · 公開のみ `/harness publish` · 解除 `/harness leave` · Builder 中止 `/harness cancel`",
  ].join("\n"),
};

export function formatHarnessHelp(locale: ConnectorLocale = "ko"): string {
  return HARNESS_HELP[locale];
}

export function harnessBuilderPrompt(input: {
  build: HarnessBuildState;
  userMessage: string;
  initial?: boolean;
}): string {
  const source = input.build.sourceMode === "current"
    ? "기존 작업 세션의 문맥을 이어받은 builder"
    : "빈 문맥에서 시작한 builder";
  const goal = input.build.goal
    ? `사용자가 처음 밝힌 목표: ${input.build.goal}`
    : "아직 명시된 목표가 없으므로 만들고 싶은 workflow의 핵심 목표부터 물어보세요.";
  const currentBrief = input.build.interviewBrief
    ? JSON.stringify({
      phase: input.build.interviewBrief.phase,
      sections: input.build.interviewBrief.sections,
      openQuestions: input.build.interviewBrief.openQuestions,
      userConfirmed: input.build.interviewBrief.userConfirmed,
      digest: input.build.interviewBrief.digest,
    }, null, 2)
    : "없음";
  const reviewRule = input.build.reviewedInterviewDigest
    ? `사용자에게 마지막으로 보여준 review digest: ${input.build.reviewedInterviewDigest}. ready로 갈 때 sections를 변경하지 마세요.`
    : "아직 사용자에게 확인을 요청한 완성 설계 요약이 없습니다.";
  const completedTurns = input.build.interviewTurnCount;
  const remainingTurns = Math.max(0, HARNESS_MIN_INTERVIEW_TURNS - completedTurns - 1);

  return [
    BUILDER_CONTRACT,
    "",
    "[Connector가 보존한 Builder 상태]",
    `Build ID: ${input.build.buildId}`,
    `Builder 종류: ${source}`,
    `대상 provider: ${input.build.provider}`,
    goal,
    `완료된 Builder 응답 수: ${completedTurns}`,
    `현재 설계 단계: ${input.build.interviewPhase ?? "start"}`,
    `채워진 설계 영역: ${harnessInterviewCoverage(input.build.interviewBrief)}/${HARNESS_INTERVIEW_SECTION_KEYS.length}`,
    reviewRule,
    `이번 답변 뒤에도 후보 생성까지 필요한 최소 후속 응답 수: ${remainingTurns}`,
    "저장된 설계 브리프:",
    currentBrief,
    "",
    input.initial
      ? "이제 인터뷰를 시작하세요. 첫 답변에서는 목표/사용 상황 또는 실제 예시 중 가장 중요한 빈 부분을 물으세요. 후보를 만들지 마세요."
      : "최신 답변을 저장된 브리프와 합쳐 다음 질문, 완성 설계 review, 또는 승인 후 ready 후보를 제시하세요.",
    "",
    "사용자의 최신 답변:",
    input.userMessage.trim() || "하네스를 함께 설계하고 싶어요.",
  ].join("\n");
}

export function harnessBuilderRepairPrompt(input: {
  build: HarnessBuildState;
  errors: string[];
  attempt: number;
  maxAttempts: number;
}): string {
  return [
    "[Connector 자동 형식 복구 요청]",
    `직전 Harness Builder 응답이 검증을 통과하지 못했습니다. 자동 복구 ${input.attempt}/${input.maxAttempts}회차입니다.`,
    "사용자에게 다시 입력을 요구하거나 새 질문으로 넘어가지 말고, 직전 답변의 의미와 현재 설계 단계를 유지한 완전한 응답을 다시 출력하세요.",
    "",
    "반드시 지킬 형식:",
    "- codex-discord-harness-brief 블록을 정확히 하나 포함합니다.",
    "- fenced block 안에는 JSON.parse가 읽을 수 있는 strict JSON만 씁니다: 모든 property name과 문자열은 큰따옴표, trailing comma와 주석은 금지합니다.",
    "- 저장된 설계와 직전 사용자가 확인한 내용을 임의로 바꾸지 않습니다.",
    "- ready 단계라면 strict JSON인 codex-discord-harness 후보 블록도 정확히 하나 포함합니다.",
    "- 검증 오류가 단계 자체를 지적한 경우에만 저장된 상태가 허용하는 단계로 되돌립니다.",
    "- review/ready의 openQuestions는 반드시 []입니다. 최종 승인 요청 문장은 본문에만 쓰며 openQuestions에 넣지 않습니다.",
    "- 실제 미해결 설계 질문이 남았다면 review를 억지로 유지하지 말고 design 단계로 되돌려 그 질문 하나를 본문에서 물어봅니다.",
    "",
    `Build ID: ${input.build.buildId}`,
    `저장된 단계: ${input.build.interviewPhase ?? "start"}`,
    `저장된 review digest: ${input.build.reviewedInterviewDigest ?? "없음"}`,
    "검증 오류:",
    ...input.errors.map((error) => `- ${error}`),
  ].join("\n");
}

export function harnessExecutionPrompt(input: {
  run: HarnessRunState;
  userMessage: string;
  initial?: boolean;
}): string {
  const request = input.userMessage.trim();
  return [
    `이 Discord 스레드는 immutable harness ${input.run.harnessVersionId} 실행 전용입니다.`,
    `Run ID: ${input.run.runId}`,
    "주입된 skill의 workflow, 질문 조건, 산출물 기준을 적용하세요.",
    "하네스 파일 자체를 수정하거나 다른 버전을 추측해 사용하지 마세요.",
    input.initial && !request
      ? "하네스가 준비되었다고 짧게 알리고, 이 workflow로 처리할 첫 작업을 사용자에게 물어보세요."
      : "사용자 요청:",
    request,
  ].filter(Boolean).join("\n");
}

export function formatHarnessBuilderGuide(sourceMode: HarnessBuildState["sourceMode"]): string {
  return [
    "**진행 방식**",
    "1. 목표와 실제 사용 예시를 확인합니다.",
    "2. 입력, 세부 절차·분기, 산출물, 권한, 역할과 실패 처리를 설계합니다.",
    "3. 완성 설계안을 보여드리고 수정 또는 승인을 받습니다.",
    "4. 승인된 설계로 후보를 만들고, 발행 후 별도 실행 스레드를 엽니다.",
    "",
    "**사용법**",
    "- 질문에 평소 말하듯 답하세요. 모르는 선택은 `추천해줘`라고 해도 됩니다.",
    "- 언제든 `이 부분은 바꿔줘`라고 수정할 수 있습니다.",
    "- 최종 설계가 맞으면 `이대로 만들어줘`라고 승인하세요.",
    "- 후보 저장 후 `/harness publish-run`을 골라 실행합니다. 첫 요청은 선택사항입니다.",
    `- 이 Builder는 ${sourceMode === "current" ? "원본 세션 문맥을 이어받았습니다." : "빈 문맥에서 시작했습니다."}`,
  ].join("\n");
}

export function formatHarnessInterviewProgress(build: HarnessBuildState): string {
  const phase = build.interviewPhase ?? "discovery";
  const nextAction = phase === "discovery"
    ? "현재: 목표와 실제 사용 상황을 확인 중입니다. 질문에 자연어로 답해 주세요."
    : phase === "design"
      ? "현재: workflow의 세부사항을 설계 중입니다. 모르겠는 항목은 추천을 요청해도 됩니다."
      : phase === "review"
        ? "다음: 위 설계안을 읽고 `이대로 만들어줘` 또는 수정할 내용을 답해 주세요."
        : build.candidateDigest
          ? "다음: 후보가 준비됐습니다. 더 수정하거나 `/harness publish-run`으로 실행하세요."
          : "현재: 승인된 설계로 최종 후보를 검증 중입니다.";
  return [
    `🧭 **설계 진행** · ${phase} · 응답 ${build.interviewTurnCount}회 (후보 최소 ${HARNESS_MIN_INTERVIEW_TURNS}회) · ${harnessInterviewCoverage(build.interviewBrief)}/${HARNESS_INTERVIEW_SECTION_KEYS.length} 영역`,
    nextAction,
  ].join("\n");
}

export function formatHarnessCandidateSaved(build: HarnessBuildState): string {
  const manifest = build.candidateManifest;
  return [
    "✅ 확인된 상세 설계를 바탕으로 하네스 후보를 구조·경로·크기·안전 규칙까지 검증해 저장했습니다.",
    manifest ? `- ${manifest.id} ${manifest.version} · ${manifest.description}` : null,
    build.candidateDigest ? `- candidate digest: \`${build.candidateDigest.slice(0, 16)}…\`` : null,
    build.candidateInterviewDigest
      ? `- design digest: \`${build.candidateInterviewDigest.slice(0, 16)}…\``
      : null,
    "내용을 더 다듬으려면 그대로 대화하세요. 설계가 바뀌면 다시 확인을 거칩니다. 준비되면 `/harness publish-run`으로 불변 버전을 발행하고 별도 실행 스레드를 만드세요.",
  ].filter(Boolean).join("\n");
}

export function formatHarnessBuilderNotice(
  content: string,
  build: HarnessBuildState,
): DiscordMessagePayload {
  const primaryAction = build.status === "validated" || build.status === "published"
    ? {
        type: 2 as const,
        custom_id: COMPONENT_IDS.harnessPublishRun,
        label: "발행하고 실행",
        style: 3,
      }
    : build.interviewPhase === "review"
      ? {
          type: 2 as const,
          custom_id: COMPONENT_IDS.harnessApprove,
          label: "이 설계대로 만들기",
          style: 3,
        }
      : build.interviewPhase === "ready"
        ? {
            type: 2 as const,
            custom_id: COMPONENT_IDS.harnessApprove,
            label: "후보 다시 만들기",
            style: 1,
          }
        : {
            type: 2 as const,
            custom_id: COMPONENT_IDS.harnessRecommend,
            label: "추천해서 계속",
            style: 1,
          };
  const secondaryActions = build.status === "validated" || build.status === "published"
    ? [{
        type: 2 as const,
        custom_id: COMPONENT_IDS.harnessPublish,
        label: "발행만",
        style: 2,
      }]
    : [];

  return {
    allowedMentions: { parse: [] },
    content,
    embeds: [],
    components: [{
      type: 1,
      components: [
        primaryAction,
        ...secondaryActions,
        {
          type: 2,
          custom_id: COMPONENT_IDS.harnessStatus,
          label: "상태 보기",
          style: 2,
        },
      ],
    }],
  };
}

export function formatHarnessPublished(published: PublishedHarnessVersionState): string {
  return [
    `✅ 하네스 발행 완료: **${published.harnessVersionId}**`,
    `- digest: \`${published.snapshotDigest}\``,
    `- providers: ${published.manifest.providers.join(", ")}`,
    "발행본은 불변입니다. 수정하려면 새 build에서 version을 올려 발행하세요.",
  ].join("\n");
}

export function formatHarnessRunReady(run: HarnessRunState): string {
  return [
    `🧰 하네스 실행 준비 완료: **${run.harnessVersionId}**`,
    `- run: \`${run.runId}\``,
    `- provider: ${run.provider}`,
    `- source: ${run.sourceMode}`,
    "이 스레드의 이후 요청에는 같은 immutable harness snapshot이 매 turn 다시 주입됩니다.",
  ].join("\n");
}

export function formatHarnessList(published: PublishedHarnessVersionState[]): string {
  if (published.length === 0) {
    return "아직 발행된 하네스가 없습니다. `/harness create`로 시작하세요.";
  }
  return [
    "**발행된 하네스**",
    ...published.slice(0, 20).map((entry) =>
      `- \`${entry.harnessVersionId}\` · ${entry.manifest.description}`,
    ),
  ].join("\n");
}

export function formatHarnessBuildStatus(build: HarnessBuildState): string {
  const coverage = harnessInterviewCoverage(build.interviewBrief);
  return [
    `**Harness Builder** · ${build.status}`,
    `- build: \`${build.buildId}\``,
    `- source: ${build.sourceMode}`,
    `- provider: ${build.provider}`,
    `- builder session: ${build.builderAgentSessionId ? `\`${build.builderAgentSessionId}\`` : "pending"}`,
    `- interview: ${build.interviewPhase ?? "start"} · ${build.interviewTurnCount} turns · ${coverage}/${HARNESS_INTERVIEW_SECTION_KEYS.length} sections`,
    build.reviewedInterviewDigest
      ? `- reviewed design: \`${build.reviewedInterviewDigest.slice(0, 16)}…\``
      : "- reviewed design: 아직 확인 전",
    build.candidateManifest
      ? `- candidate: ${build.candidateManifest.id} ${build.candidateManifest.version}`
      : "- candidate: 아직 없음",
    build.error ? `- error: ${build.error}` : null,
  ].filter(Boolean).join("\n");
}

export function formatHarnessRunStatus(run: HarnessRunState): string {
  return [
    `**Harness Run** · ${run.status}`,
    `- run: \`${run.runId}\``,
    `- harness: \`${run.harnessVersionId}\``,
    `- digest: \`${run.snapshotDigest.slice(0, 16)}…\``,
    `- source: ${run.sourceMode}`,
    `- execution session: ${run.executionAgentSessionId ? `\`${run.executionAgentSessionId}\`` : "pending"}`,
    run.error ? `- error: ${run.error}` : null,
  ].filter(Boolean).join("\n");
}
