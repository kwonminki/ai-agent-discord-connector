import { describe, expect, it } from "vitest";
import {
  agentSurveyOtherCustomId,
  parseAgentSurveyOtherCustomId,
  routeAgentSurveyOtherAnswer,
  routeDiscordComponent,
} from "./componentRouter.js";

describe("routeDiscordComponent", () => {
  it("maps safe Discord buttons to the same text commands used by message routing", () => {
    expect(routeDiscordComponent("cdc:sync:25")).toBe("sync select 25");
    expect(routeDiscordComponent("cdc:sync:select:25")).toBe("sync select 25");
    expect(routeDiscordComponent("cdc:sync:all:25")).toBe("sync all 25");
    expect(
      routeDiscordComponent("cdc:chat:resume:selected", ["9d41bbde-5b0c-4ba5-b0b7-7dc7c0984e46"]),
    ).toBe("chat resume 9d41bbde-5b0c-4ba5-b0b7-7dc7c0984e46");
    expect(routeDiscordComponent("cdc:chat:resume:selected", ["../etc"])).toBeNull();
    expect(routeDiscordComponent("cdc:sync:mode:on-chat")).toBe("sync mode on-chat");
    expect(routeDiscordComponent("cdc:sync:mode:realtime")).toBe("sync mode realtime");
    expect(routeDiscordComponent("cdc:chat:new:general")).toBe("chat new");
    expect(routeDiscordComponent("cdc:chat:new:current")).toBe("chat new current");
    expect(routeDiscordComponent("cdc:chat:new:here")).toBe("chat new current");
    expect(routeDiscordComponent("cdc:self:dev-chat")).toContain("__cdc_new_chat ");
    expect(decodeURIComponent(routeDiscordComponent("cdc:self:dev-chat") ?? "")).toContain('"name":"봇 유지보수"');
    expect(routeDiscordComponent("cdc:delete:preview")).toBe("sync delete preview");
    expect(routeDiscordComponent("cdc:delete:session:selected", ["session-1"])).toBe("sync delete session session-1");
    expect(routeDiscordComponent("cdc:delete:session:session-1:confirm")).toBe("sync delete session session-1 confirm");
    expect(routeDiscordComponent("cdc:archive:current:confirm")).toBe("archive confirm");
    expect(routeDiscordComponent("cdc:fs:up")).toBe("__cdc_exec cd ..");
    expect(routeDiscordComponent("cdc:fs:refresh")).toBe("__cdc_exec __cdc_ls 0");
    expect(routeDiscordComponent("cdc:fs:page:2")).toBe("__cdc_exec __cdc_ls 2");
    expect(routeDiscordComponent("cdc:codex:approval:42:accept-session")).toBe(
      "__cdc_codex_approval 42 acceptForSession",
    );
  });

  it("maps destructive confirmation buttons explicitly", () => {
    expect(routeDiscordComponent("cdc:delete:channels:confirm")).toBe("sync delete channels confirm");
    expect(routeDiscordComponent("cdc:delete:all:confirm")).toBe("sync delete all confirm");
  });

  it("routes media survey selections to the active question or next agent turn", () => {
    const pending = routeDiscordComponent("cdc:codex:user-input:question-7", ["0:A가 좋음", "1:화질 개선"]);
    expect(pending).toBe(
      `__cdc_codex_user_input question-7 ${encodeURIComponent(JSON.stringify(["A가 좋음", "화질 개선"]))}`,
    );

    expect(routeDiscordComponent("cdc:agent:survey:codex", ["1:B가 좋음"])).toContain(
      "/queue prompt:codex Discord 미디어 설문에서 사용자가 다음 항목을 선택했습니다:",
    );
    expect(routeDiscordComponent("cdc:agent:survey:claude", ["2:둘 다 수정"])).toContain(
      "/queue prompt:claude Discord 미디어 설문에서 사용자가 다음 항목을 선택했습니다:",
    );
  });

  it("routes free-text survey answers to the same active question or next agent turn", () => {
    const userInputId = agentSurveyOtherCustomId({ kind: "user-input", token: "question-7" });
    const claudeId = agentSurveyOtherCustomId({ kind: "agent", agent: "claude" });

    expect(userInputId).toBe("cdc:survey:other:user-input:question-7");
    expect(parseAgentSurveyOtherCustomId(userInputId)).toEqual({
      kind: "user-input",
      token: "question-7",
    });
    expect(routeAgentSurveyOtherAnswer(
      { kind: "user-input", token: "question-7" },
      "선택지 밖의 답변",
    )).toBe(
      `__cdc_codex_user_input question-7 ${encodeURIComponent(JSON.stringify(["선택지 밖의 답변"]))}`,
    );
    expect(parseAgentSurveyOtherCustomId(claudeId)).toEqual({
      kind: "agent",
      agent: "claude",
    });
    expect(routeAgentSurveyOtherAnswer(
      { kind: "agent", agent: "claude" },
      "두 결과를 섞어주세요",
    )).toContain("/queue prompt:claude Discord 미디어 설문에서 사용자가 자유 입력으로 답했습니다:");
    expect(routeAgentSurveyOtherAnswer(
      { kind: "agent", agent: "codex" },
      "   ",
    )).toBeNull();
  });

  it("ignores unknown component ids", () => {
    expect(routeDiscordComponent("other-app:sync")).toBeNull();
    expect(routeDiscordComponent("cdc:codex:open:019db2be-b2b3-7e82-9e61-8c84b28ad287")).toBeNull();
    expect(routeDiscordComponent("cdc:codex:restart-open:019db2be-b2b3-7e82-9e61-8c84b28ad287")).toBeNull();
  });

  it("maps file browser select values into safe cd commands", () => {
    expect(routeDiscordComponent("cdc:fs:open", ["docs"])).toBe("__cdc_exec __cdc_open docs");
    expect(routeDiscordComponent("cdc:fs:view", ["Project Notes"])).toBe("__cdc_exec __cdc_view 'Project Notes'");
    expect(routeDiscordComponent("cdc:fs:summarize", ["README.md"])).toBe("codex 선택한 파일을 요약해줘: README.md");
    expect(routeDiscordComponent("cdc:fs:edit", ["README.md"])).toBe(
      "codex 선택한 파일을 개선하거나 수정해줘. 파일: README.md",
    );
    expect(routeDiscordComponent("cdc:fs:open", ["bad`name"])).toBeNull();
  });

  it("maps command palette and workflow buttons", () => {
    expect(routeDiscordComponent("cdc:palette", ["browse"])).toBe("__cdc_exec __cdc_ls 0");
    expect(routeDiscordComponent("cdc:palette", ["where"])).toBe("where");
    expect(routeDiscordComponent("cdc:maintenance:panel")).toBe("maintenance");
    expect(routeDiscordComponent("cdc:palette", ["sync-status"])).toBe("sync status");
    expect(routeDiscordComponent("cdc:palette", ["reload-commands"])).toBe("reload commands");
    expect(routeDiscordComponent("cdc:palette", ["git-status"])).toBe("__cdc_exec git status --short");
    expect(routeDiscordComponent("cdc:palette", ["git-diff"])).toBe("__cdc_exec git diff --stat");
    expect(routeDiscordComponent("cdc:palette", ["git-conflicts"])).toBe("__cdc_exec git diff --check");
    expect(routeDiscordComponent("cdc:palette", ["test"])).toBe("__cdc_exec pnpm test");
    expect(routeDiscordComponent("cdc:verify:typecheck")).toBe("__cdc_exec pnpm typecheck");
    expect(routeDiscordComponent("cdc:git:review")).toBe("__cdc_codex_review 현재 변경사항을 리뷰하고 위험한 부분을 알려줘");
    expect(routeDiscordComponent("cdc:git:status")).toBe("__cdc_exec git status --short");
    expect(routeDiscordComponent("cdc:git:conflicts")).toBe("__cdc_exec git diff --check");
    expect(routeDiscordComponent("cdc:palette", ["codex-review"])).toBe("__cdc_codex_review 현재 변경사항을 리뷰하고 위험한 부분을 알려줘");
    expect(routeDiscordComponent("cdc:palette", ["fix-tests"])).toBe(
      "codex 테스트를 실행하고 실패 원인을 분석한 뒤 수정해줘. 수정 후 테스트를 다시 실행해줘",
    );
    expect(routeDiscordComponent("cdc:test:run")).toBe("__cdc_exec pnpm test");
    expect(routeDiscordComponent("cdc:test:fix")).toBe("codex 테스트 실패를 분석하고 수정해줘. 수정 후 테스트도 다시 실행해줘");
    expect(routeDiscordComponent("cdc:reload:commands")).toBe("reload commands");
    expect(routeDiscordComponent("cdc:reload:restart:confirm")).toBe("reload restart confirm");
    expect(routeDiscordComponent("cdc:reload:restart:force:confirm")).toBe("reload restart force confirm");
    expect(routeDiscordComponent("cdc:harness:recommend")).toContain("안전한 기본값을 추천");
    expect(routeDiscordComponent("cdc:harness:approve")).toContain("설계 그대로 하네스를 만들어줘");
    expect(decodeURIComponent(routeDiscordComponent("cdc:harness:publish") ?? "")).toContain('"action":"publish"');
    expect(decodeURIComponent(routeDiscordComponent("cdc:harness:publish-run") ?? "")).toContain('"action":"publish-run"');
    expect(decodeURIComponent(routeDiscordComponent("cdc:harness:status") ?? "")).toContain('"action":"status"');
  });

  it("maps selected Codex session ids into a selected sync request", () => {
    expect(
      routeDiscordComponent("cdc:sync:selected", [
        "019db2be-b2b3-7e82-9e61-8c84b28ad287",
        "019db2be-b2b3-7e82-9e61-8c84b28ad288",
      ]),
    ).toBe("sync selected 019db2be-b2b3-7e82-9e61-8c84b28ad287 019db2be-b2b3-7e82-9e61-8c84b28ad288");
    expect(routeDiscordComponent("cdc:sync:selected", ["bad;id"])).toBeNull();
  });
});
