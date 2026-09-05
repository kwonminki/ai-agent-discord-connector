import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateHarnessCandidate, validateHarnessInterviewBrief } from "../../../packages/core/src/index.js";
import { createHarnessStore } from "../../discord-bot/src/harnessStore.js";
import { verifyHarnessWorkerBinding } from "./harnessRuntime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function publishedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-runtime-"));
  roots.push(root);
  const store = createHarnessStore(root);
  const build = await store.createBuild({
    provider: "codex",
    sourceMode: "fresh",
    builderDiscordChannelId: "builder",
  });
  const sections = {
    purposeAndTriggers: "Run a verified workflow when immutable runtime integrity matters.",
    usageExamples: "Execute the published runtime-check harness against a repository task.",
    inputsAndContext: "Use the bound snapshot, repository context, and current user request.",
    workflowAndDecisions: "Verify all files and metadata before starting the requested provider.",
    outputsAndSuccess: "Start only a correctly pinned workflow and return its requested result.",
    constraintsAndPermissions: "Reject path escape, links, tampering, and unsupported providers.",
    resourcesAndRoles: "Use the published SKILL.md and optional verified agent role files.",
    failuresAndEscalation: "Fail closed with a specific verification error before agent launch.",
    validationCases: "Test exact snapshots, content tampering, path escape, and unexpected files.",
  };
  const brief = (phase: "discovery" | "design" | "review" | "ready") => validateHarnessInterviewBrief({
    phase,
    sections: phase === "discovery"
      ? { ...sections, validationCases: null }
      : sections,
    openQuestions: phase === "discovery" ? ["Which tampering cases matter?"] : [],
    userConfirmed: phase === "ready",
  });
  await store.recordInterview(build.buildId, brief("discovery"));
  await store.recordInterview(build.buildId, brief("design"));
  await store.recordInterview(build.buildId, brief("review"));
  const ready = await store.recordInterview(build.buildId, brief("ready"));
  await store.saveCandidate(build.buildId, validateHarnessCandidate({
    manifest: {
      id: "runtime-check",
      name: "runtime-check",
      description: "Verify runtime snapshots before an agent process starts.",
      version: "1.0.0",
      providers: ["codex", "claude"],
      maxSubagents: 0,
      outputs: [],
    },
    files: [{
      path: "SKILL.md",
      content: "---\nname: runtime-check\ndescription: Verify runtime snapshots before an agent process starts.\n---\n\nFollow the verified workflow.",
    }],
  }), ready.interviewBrief!.digest);
  const published = await store.publishBuild(build.buildId);
  const run = await store.createRun({
    provider: "codex",
    published,
    sourceMode: "fresh",
    executionDiscordChannelId: "run-channel",
  });
  return { root, store, published, binding: store.workerBinding(run) };
}

describe("worker harness verification", () => {
  it("accepts an exact immutable snapshot", async () => {
    const fixture = await publishedFixture();
    const runtime = await verifyHarnessWorkerBinding(fixture.binding, "codex", fixture.root);

    expect(runtime.skillPath).toBe(path.join(await realpath(fixture.published.snapshotPath), "skill", "SKILL.md"));
    expect(runtime.claudePluginName).toBe("cdc-runtime-check");
  });

  it("rejects content tampering and unexpected hook files", async () => {
    const contentTamper = await publishedFixture();
    await appendFile(path.join(contentTamper.published.snapshotPath, "skill", "SKILL.md"), "\ntampered");
    await expect(verifyHarnessWorkerBinding(contentTamper.binding, "codex", contentTamper.root))
      .rejects.toThrow(/file verification failed/);

    const hookTamper = await publishedFixture();
    await writeFile(path.join(hookTamper.published.snapshotPath, "hook.js"), "bad", "utf8");
    await expect(verifyHarnessWorkerBinding(hookTamper.binding, "claude", hookTamper.root))
      .rejects.toThrow(/missing or unexpected/);
  });
});
