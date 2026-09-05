import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentCompletionAnswer } from "./agentCompletionAnswer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareAgentCompletionAnswer", () => {
  it("sanitizes mentions and splits long answers into ordered message descriptions", () => {
    const result = prepareAgentCompletionAnswer({
      agent: "codex",
      answer: `@operator ${"long answer ".repeat(30)}`,
      attachmentName: "answer.txt",
      maxPreviewChars: 80,
    });

    expect(result.description).toContain("[at]operator");
    expect(result.clipped).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.continuationDescriptions.length).toBeGreaterThan(1);
    expect([result.description, ...result.continuationDescriptions].every((chunk) => chunk.length <= 80)).toBe(true);
    expect([result.description, ...result.continuationDescriptions].join("\n")).toContain("long answer");
  });

  it("extracts connector file blocks for either agent notification", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-completion-answer-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "result.txt");
    await writeFile(filePath, "result", "utf8");

    const result = prepareAgentCompletionAnswer({
      agent: "codex",
      answer: [
        "완료했습니다.",
        "```codex-discord-send",
        JSON.stringify({ message: "파일입니다.", files: [filePath] }),
        "```",
      ].join("\n"),
      attachmentName: "answer.txt",
    });

    expect(result.answer).toContain("완료했습니다.");
    expect(result.answer).toContain("파일입니다.");
    expect(result.answer).not.toContain("codex-discord-send");
    expect(result.files).toEqual([expect.objectContaining({ attachment: filePath })]);
  });

  it("never exposes reserved Harness Builder blocks in background completions", () => {
    const result = prepareAgentCompletionAnswer({
      agent: "claude",
      answer: [
        "설계를 반영했습니다.",
        "```codex-discord-harness-brief",
        JSON.stringify({ phase: "ready", internal: "secret" }),
        "```",
        "```codex-discord-harness",
        JSON.stringify({ manifest: { id: "private" }, files: [] }),
        "```",
      ].join("\n"),
      attachmentName: "answer.txt",
    });

    expect(result.description).toBe("설계를 반영했습니다.");
    expect(result.answer).not.toContain("codex-discord-harness");
    expect(result.answer).not.toContain("internal");
  });

  it("prepares final survey messages for background completion notifications", () => {
    const result = prepareAgentCompletionAnswer({
      agent: "claude",
      answer: [
        "선택해주세요.",
        "```codex-discord-survey",
        JSON.stringify({ question: "어느 쪽?", options: ["A", "B"] }),
        "```",
      ].join("\n"),
      attachmentName: "answer.txt",
    });

    expect(result.answer).toBe("선택해주세요.");
    expect(result.surveyMessages).toEqual([
      expect.objectContaining({
        components: [
          {
            type: 1,
            components: [expect.objectContaining({ custom_id: "cdc:agent:survey:claude" })],
          },
          {
            type: 1,
            components: [expect.objectContaining({
              custom_id: "cdc:survey:other:agent:claude",
              label: "기타...",
            })],
          },
        ],
      }),
    ]);
  });
});
