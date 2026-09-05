import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateHarnessCandidate,
  validateHarnessInterviewBrief,
  type HarnessInterviewPhase,
} from "../../../packages/core/src/index.js";
import { createHarnessStore, type HarnessStore } from "./harnessStore.js";

const roots: string[] = [];

function validCandidate(version = "1.0.0") {
  return validateHarnessCandidate({
    manifest: {
      id: "safe-review",
      name: "safe-review",
      description: "Review changes using a deterministic safety workflow.",
      version,
      providers: ["codex", "claude"],
      maxSubagents: 0,
      outputs: ["Review report"],
    },
    files: [{
      path: "SKILL.md",
      content: "---\nname: safe-review\ndescription: Review changes using a deterministic safety workflow.\n---\n\nInspect and report findings.",
    }],
  });
}

const completeSections = {
  purposeAndTriggers: "Review repository changes before merge when correctness and safety matter.",
  usageExamples: "Review the current pull request and report only actionable findings.",
  inputsAndContext: "Use the repository, current diff, user scope, and local project instructions.",
  workflowAndDecisions: "Inspect instructions and diff, trace risky behavior, then rank supported findings.",
  outputsAndSuccess: "Return a concise severity-ranked report with file references and no false positives.",
  constraintsAndPermissions: "Remain read-only, avoid network access, and do not change unrelated files.",
  resourcesAndRoles: "Use repository source and tests; keep a single reviewer role unless parallel review helps.",
  failuresAndEscalation: "Ask when scope is ambiguous and report unverifiable assumptions instead of guessing.",
  validationCases: "Cover a normal bug, a clean diff, and an ambiguous change requiring clarification.",
};

function interviewBrief(phase: HarnessInterviewPhase) {
  return validateHarnessInterviewBrief({
    schemaVersion: 1,
    phase,
    sections: phase === "discovery"
      ? { ...Object.fromEntries(Object.keys(completeSections).map((key) => [key, null])), purposeAndTriggers: completeSections.purposeAndTriggers }
      : completeSections,
    openQuestions: phase === "discovery" ? ["What requests should trigger this workflow?"] : [],
    userConfirmed: phase === "ready",
  });
}

async function completeInterview(store: HarnessStore, buildId: string): Promise<string> {
  await store.recordInterview(buildId, interviewBrief("discovery"));
  await store.recordInterview(buildId, interviewBrief("design"));
  const review = await store.recordInterview(buildId, interviewBrief("review"));
  const ready = await store.recordInterview(buildId, interviewBrief("ready"));
  expect(ready.reviewedInterviewDigest).toBe(review.interviewBrief?.digest);
  return ready.interviewBrief!.digest;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("harness store", () => {
  it("persists a draft and publishes an immutable snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-"));
    roots.push(root);
    const store = createHarnessStore(root);
    const build = await store.createBuild({
      provider: "codex",
      sourceMode: "current",
      sourceDiscordChannelId: "source-channel",
      sourceAgentSessionId: "source-session",
      builderDiscordChannelId: "builder-channel",
    });

    const designDigest = await completeInterview(store, build.buildId);
    const saved = await store.saveCandidate(build.buildId, validCandidate(), designDigest);
    expect(saved.status).toBe("validated");
    const published = await store.publishBuild(build.buildId);

    expect(published.harnessVersionId).toMatch(/^safe-review@1\.0\.0#/);
    expect(await readFile(path.join(published.snapshotPath, "skill", "SKILL.md"), "utf8"))
      .toContain("name: safe-review");
    expect(await readFile(path.join(published.snapshotPath, ".claude-plugin", "plugin.json"), "utf8"))
      .toContain('"name": "cdc-safe-review"');
    expect((await store.buildForChannel("builder-channel"))?.status).toBe("published");

    const forkedBuild = await store.createBuild({
      provider: "codex",
      sourceMode: "current",
      sourceDiscordChannelId: "builder-channel",
      sourceAgentSessionId: "builder-session",
      builderDiscordChannelId: "forked-builder-channel",
    });
    const cloned = await store.cloneBuildCandidate(build.buildId, forkedBuild.buildId);
    expect(cloned).toMatchObject({ status: "validated", candidateDigest: published.snapshotDigest });
    expect((await store.publishBuild(forkedBuild.buildId)).harnessVersionId).toBe(published.harnessVersionId);
    expect((await store.buildForChannel("forked-builder-channel"))?.status).toBe("published");
  });

  it("does not overwrite the same semantic version with different content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-version-"));
    roots.push(root);
    const store = createHarnessStore(root);
    const first = await store.createBuild({
      provider: "codex",
      sourceMode: "fresh",
      builderDiscordChannelId: "builder-one",
    });
    const firstDesignDigest = await completeInterview(store, first.buildId);
    await store.saveCandidate(first.buildId, validCandidate(), firstDesignDigest);
    await store.publishBuild(first.buildId);

    const second = await store.createBuild({
      provider: "codex",
      sourceMode: "fresh",
      builderDiscordChannelId: "builder-two",
    });
    const changed = validCandidate();
    changed.files[0]!.content += "\nChanged.";
    changed.digest = "";
    const secondDesignDigest = await completeInterview(store, second.buildId);
    await store.saveCandidate(second.buildId, validateHarnessCandidate({
      manifest: changed.manifest,
      files: changed.files,
    }), secondDesignDigest);

    await expect(store.publishBuild(second.buildId)).rejects.toThrow(/이미 다른 내용/);
  });

  it("persists worker and Discord delivery metadata for restart-safe runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-run-delivery-"));
    roots.push(root);
    const store = createHarnessStore(root);
    const build = await store.createBuild({
      provider: "codex",
      sourceMode: "fresh",
      builderDiscordChannelId: "builder-run-delivery",
    });
    const designDigest = await completeInterview(store, build.buildId);
    await store.saveCandidate(build.buildId, validCandidate(), designDigest);
    const published = await store.publishBuild(build.buildId);
    const run = await store.createRun({
      provider: "codex",
      published,
      sourceMode: "fresh",
      executionDiscordChannelId: "run-thread",
      requestId: "discord-request-1",
    });

    expect(run).toMatchObject({
      requestId: "discord-request-1",
      workerJobId: "discord-request-1",
      progressMessageId: null,
      resultMessageId: null,
      progress: null,
    });
    await store.markRunStatus(run.runId, "running");
    const bound = await store.bindRunSession(run.runId, "codex-session-1");
    expect(bound.status).toBe("running");
    await store.updateRunExecution(run.runId, {
      progressMessageId: "progress-message-1",
      resultMessageId: "result-message-1",
    });

    expect(await store.runForRequest("discord-request-1")).toMatchObject({
      executionAgentSessionId: "codex-session-1",
      progressMessageId: "progress-message-1",
      resultMessageId: "result-message-1",
    });
  });

  it("refuses to publish a stale candidate after the latest candidate fails validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-invalid-latest-"));
    roots.push(root);
    const store = createHarnessStore(root);
    const build = await store.createBuild({
      provider: "claude",
      sourceMode: "fresh",
      builderDiscordChannelId: "builder-invalid-latest",
    });
    const designDigest = await completeInterview(store, build.buildId);
    await store.saveCandidate(build.buildId, validCandidate(), designDigest);
    const invalidated = await store.recordCandidateError(build.buildId, "SKILL.md frontmatter is invalid");

    expect(invalidated).toMatchObject({
      status: "candidate",
      candidateDigest: null,
      candidateManifest: null,
      error: "SKILL.md frontmatter is invalid",
    });
    await expect(store.publishBuild(build.buildId)).rejects.toThrow(/검증된 하네스 후보가 없습니다/);
  });

  it("clears a transient validation error without counting an automatic repair as a user turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-repair-"));
    roots.push(root);
    const store = createHarnessStore(root);
    const build = await store.createBuild({
      provider: "codex",
      sourceMode: "fresh",
      builderDiscordChannelId: "builder-repair",
    });
    await completeInterview(store, build.buildId);
    const brief = interviewBrief("ready");
    await store.recordCandidateError(build.buildId, "malformed candidate JSON");

    const repaired = await store.recordInterview(build.buildId, brief, { countTurn: false });

    expect(repaired).toMatchObject({
      status: "drafting",
      interviewPhase: "ready",
      interviewTurnCount: 4,
      error: null,
    });
  });

  it("requires a multi-turn reviewed interview before accepting a candidate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-interview-gate-"));
    roots.push(root);
    const store = createHarnessStore(root);
    const build = await store.createBuild({
      provider: "codex",
      sourceMode: "fresh",
      builderDiscordChannelId: "builder-gated",
    });
    const discovery = await store.recordInterview(build.buildId, interviewBrief("discovery"));

    await expect(store.saveCandidate(build.buildId, validCandidate(), discovery.interviewBrief!.digest))
      .rejects.toThrow(/상세 설계 문답/);
    await expect(store.recordInterview(build.buildId, interviewBrief("ready")))
      .rejects.toThrow(/너무 빨리 이동/);

    await store.recordInterview(build.buildId, interviewBrief("design"));
    const reviewed = await store.recordInterview(build.buildId, interviewBrief("review"));
    const changedReady = validateHarnessInterviewBrief({
      ...interviewBrief("ready"),
      sections: { ...completeSections, outputsAndSuccess: "Return only a JSON report." },
    });
    await expect(store.recordInterview(build.buildId, changedReady))
      .rejects.toThrow(/설계 요약이 변경/);

    const ready = await store.recordInterview(build.buildId, interviewBrief("ready"));
    expect(ready).toMatchObject({
      interviewTurnCount: 4,
      interviewPhase: "ready",
      reviewedInterviewDigest: reviewed.interviewBrief?.digest,
    });
  });
});
