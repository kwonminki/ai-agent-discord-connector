import { describe, expect, it } from "vitest";
import {
  extractHarnessCandidate,
  extractHarnessInterviewBrief,
  harnessCandidateDigest,
  stripHarnessBuilderBlocks,
  stripHarnessCandidateBlock,
  validateHarnessCandidate,
  validateHarnessInterviewBrief,
} from "../src/index.js";

function candidate() {
  return {
    manifest: {
      id: "review-code",
      name: "review-code",
      description: "Review code changes with a repeatable safety checklist.",
      version: "1.0.0",
      providers: ["codex", "claude"],
      maxSubagents: 1,
      outputs: ["Review report"],
    },
    files: [
      {
        path: "SKILL.md",
        content: [
          "---",
          "name: review-code",
          "description: Review code changes with a repeatable safety checklist.",
          "---",
          "",
          "Inspect the change and report findings by severity.",
        ].join("\n"),
      },
      {
        path: "agents/reviewer.md",
        content: [
          "---",
          "name: reviewer",
          "description: Inspect changes for correctness and safety problems.",
          "---",
          "",
          "Review the assigned change.",
        ].join("\n"),
      },
    ],
  };
}

describe("harness candidates", () => {
  it("validates, extracts, and hides a structured candidate", () => {
    const text = `설계가 끝났습니다.\n\n\`\`\`codex-discord-harness\n${JSON.stringify(candidate())}\n\`\`\``;
    const extracted = extractHarnessCandidate(text);

    expect(extracted.error).toBeNull();
    expect(extracted.candidate?.manifest.id).toBe("review-code");
    expect(extracted.candidate?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stripHarnessCandidateBlock(text)).toBe("설계가 끝났습니다.");
  });

  it("validates and hides a structured multi-stage interview brief", () => {
    const brief = {
      schemaVersion: 1,
      phase: "review",
      sections: {
        purposeAndTriggers: "Review code when a user wants correctness and safety feedback.",
        usageExamples: "Review this pull request and list actionable bugs by severity.",
        inputsAndContext: "Use the repository instructions, current diff, and requested scope.",
        workflowAndDecisions: "Inspect the diff, trace behavior, validate evidence, and rank findings.",
        outputsAndSuccess: "Return concise supported findings with precise file references.",
        constraintsAndPermissions: "Stay read-only and do not modify files or use the network.",
        resourcesAndRoles: "Use local source and tests with one reviewer unless parallel roles help.",
        failuresAndEscalation: "Ask about ambiguous scope and disclose anything that cannot be verified.",
        validationCases: "Cover a real defect, a clean diff, and an ambiguous boundary case.",
      },
      openQuestions: [],
      userConfirmed: false,
    };
    const text = `이 설계대로 만들까요?\n\n\`\`\`codex-discord-harness-brief\n${JSON.stringify(brief)}\n\`\`\``;
    const extracted = extractHarnessInterviewBrief(text);

    expect(extracted.error).toBeNull();
    expect(extracted.brief).toMatchObject({ phase: "review", userConfirmed: false });
    expect(extracted.brief?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stripHarnessBuilderBlocks(text)).toBe("이 설계대로 만들까요?");
  });

  it("rejects ready briefs with missing design sections or no confirmation", () => {
    expect(() => validateHarnessInterviewBrief({
      phase: "ready",
      sections: {},
      openQuestions: ["What should happen?"],
      userConfirmed: false,
    })).toThrow(/9개 설계 영역/);
  });

  it("produces a stable digest independent of file ordering", () => {
    const first = validateHarnessCandidate(candidate());
    const reversed = validateHarnessCandidate({
      ...candidate(),
      files: [...candidate().files].reverse(),
    });

    expect(harnessCandidateDigest(first)).toBe(harnessCandidateDigest(reversed));
  });

  it("rejects traversal and executable configuration surfaces", () => {
    expect(() => validateHarnessCandidate({
      ...candidate(),
      files: [{ path: "../SKILL.md", content: "bad" }],
    })).toThrow(/허용되지 않은/);

    expect(() => validateHarnessCandidate({
      ...candidate(),
      files: [
        candidate().files[0],
        {
          path: "agents/reviewer.md",
          content: "---\nname: reviewer\ndescription: Review important changes safely.\nhooks: ./run.sh\n---\nReview.",
        },
      ],
    })).toThrow(/hooks/);

    expect(() => validateHarnessCandidate({
      ...candidate(),
      manifest: { ...candidate().manifest, maxSubagents: 1 },
      files: [candidate().files[0]],
    })).toThrow(/agents\/ 역할 파일/);
  });
});
