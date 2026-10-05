import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILLS,
  AGENT_STYLES,
  DEFAULT_AGENT_GUIDANCE,
  PURE_AGENT_GUIDANCE,
} from "../../../packages/core/src/agentGuidance.js";
import {
  prepareAgentGuidance,
  guidancePrompt,
} from "./agentGuidanceRuntime.js";
import { directWorkerJobRequestSchema } from "./directWorkerSchemas.js";

const assetsRoot = fileURLToPath(
  new URL("../../../agent-assets/", import.meta.url),
);
describe("vendored agent guidance", () => {
  it("preserves every pinned raw file byte for byte", async () => {
    const sources = JSON.parse(
      await readFile(path.join(assetsRoot, "sources.json"), "utf8"),
    );
    const recordedPaths = new Set<string>();
    for (const source of sources)
      for (const file of source.files) {
        recordedPaths.add(`${source.directory}/${file.path}`);
        expect(
          createHash("sha256")
            .update(
              await readFile(
                path.join(assetsRoot, source.directory, file.path),
              ),
            )
            .digest("hex"),
        ).toBe(file.sha256);
      }
    for (const entry of [...AGENT_STYLES, ...AGENT_SKILLS]) {
      expect(recordedPaths.has(entry.file)).toBe(true);
    }
  });
  it("creates independent atomic snapshots and links only enabled raw instructions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guidance-runtime-"));
    try {
      const [a, b, pure] = await Promise.all([
        prepareAgentGuidance(DEFAULT_AGENT_GUIDANCE, { runtimeRoot: root }),
        prepareAgentGuidance(DEFAULT_AGENT_GUIDANCE, { runtimeRoot: root }),
        prepareAgentGuidance(PURE_AGENT_GUIDANCE, { runtimeRoot: root }),
      ]);
      expect(a.agentsPath).toBe(b.agentsPath);
      expect(a.agentsPath).not.toBe(pure.agentsPath);
      const instructions = await readFile(a.agentsPath, "utf8");
      for (const match of instructions.matchAll(/\]\(\.\/raw\/([^)]*)\)/g))
        await expect(
          readFile(
            path.join(path.dirname(a.agentsPath), "raw", match[1]),
            "utf8",
          ),
        ).resolves.toBeTruthy();
      expect(instructions).toContain(
        "Before writing, reviewing, debugging, or refactoring code",
      );
      const pureText = await readFile(pure.agentsPath, "utf8");
      expect(pureText).not.toContain("./raw/");
      expect(pure.claudePluginPath).toBeNull();
      expect(await readdir(root)).toHaveLength(2);
      const style = await readFile(
        path.join(a.claudePluginPath!, "output-styles/attention-kind.md"),
        "utf8",
      );
      expect(style).toContain("keep-coding-instructions: true");
      expect(guidancePrompt(a, "/compact retain goals")).toBe(
        "/compact retain goals",
      );
      expect(guidancePrompt(a, "fix bug")).toContain(a.agentsPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("validates persisted jobs before executing any selected instruction paths", () => {
    const job = {
      version: 1,
      jobId: "test",
      queueKey: "thread",
      createdAt: new Date().toISOString(),
      type: "run-codex-prompt",
      payload: {
        runner: "app-server",
        input: {
          workspaceRoot: "/repo",
          cwd: "/repo",
          prompt: "go",
          timeoutMs: 1000,
          guidance: DEFAULT_AGENT_GUIDANCE,
        },
      },
    };
    expect(directWorkerJobRequestSchema.parse(job)).toMatchObject(job);
    expect(() =>
      directWorkerJobRequestSchema.parse({
        ...job,
        payload: {
          ...job.payload,
          input: {
            ...job.payload.input,
            guidance: { style: "../../bad", skills: [] },
          },
        },
      }),
    ).toThrow();
  });
});
