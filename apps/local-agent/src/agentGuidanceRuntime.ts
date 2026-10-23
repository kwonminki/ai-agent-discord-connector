import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SKILLS,
  AGENT_STYLES,
  agentGuidanceSchema,
  type AgentGuidance,
} from "../../../packages/core/src/agentGuidance.js";

const bundledAssets = fileURLToPath(
  new URL("../../../agent-assets/", import.meta.url),
);
export interface PreparedAgentGuidance {
  digest: string;
  agentsPath: string;
  claudePluginPath: string | null;
  claudeStyleName: string | null;
}

export async function prepareAgentGuidance(
  guidance: AgentGuidance,
  options: { assetsRoot?: string; runtimeRoot?: string } = {},
): Promise<PreparedAgentGuidance | null> {
  const selected = agentGuidanceSchema.parse(guidance);
  // No optional selection means no generated files, plugin, or prompt wrapper.
  if (selected.style === null && selected.skills.length === 0) return null;
  const assets = options.assetsRoot ?? bundledAssets;
  const style = AGENT_STYLES.find((entry) => entry.id === selected.style);
  const skills = AGENT_SKILLS.filter((entry) =>
    selected.skills.includes(entry.id),
  );
  const entries = [...(style ? [style] : []), ...skills];
  const sources = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      raw: await readFile(path.join(assets, entry.file), "utf8"),
    })),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 2, selected, sources }))
    .digest("hex");
  const root = path.resolve(
    options.runtimeRoot ??
      path.join(process.cwd(), ".connect", "agent-guidance"),
  );
  const directory = path.join(root, digest);
  const agentsPath = path.join(directory, "AGENTS.md");
  const claudeStyleName = style ? `cdc-guidance:${style.id}` : null;
  const result = {
    digest,
    agentsPath,
    claudePluginPath: style ? path.join(directory, "claude-plugin") : null,
    claudeStyleName,
  };
  // Build a complete immutable snapshot before publishing it. Concurrent channels
  // never rewrite each other's AGENTS.md or the project's .claude/settings files.
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = path.join(root, `.tmp-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const source of sources) {
      const target = path.join(staging, "raw", `${source.id}.md`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source.raw);
    }
    const lines = [
      "# Connector guidance for this request",
      "",
      "This selection replaces earlier connector-added styles and skills for this request. Preserve the user's request, project AGENTS.md/CLAUDE.md, and higher-priority instructions. Do not infer personal or medical facts from a style's wording. Use the user's language.",
      "These settings control connector-added guidance only. Skills installed in the agent's native user or project directories remain available under the agent's normal discovery and invocation rules; this selection does not disable or replace them.",
      "",
      style
        ? `Style: [${style.id}](./raw/${style.id}.md). Codex: read this linked file before answering. Claude Code: this style is supplied as a native output style.`
        : "No connector output style is enabled. Do not continue an earlier connector style solely because it occurs in conversation history.",
      "",
      "## Enabled connector skills",
      ...skills.map(
        (skill) => `- [${skill.id}](./raw/${skill.id}.md): ${skill.when}`,
      ),
      ...(skills.length
        ? []
        : [
            "No connector skills are enabled. Earlier connector skill instructions are inactive.",
          ]),
      "",
    ];
    await writeFile(path.join(staging, "AGENTS.md"), lines.join("\n"));
    if (style) {
      const plugin = path.join(staging, "claude-plugin");
      await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
      await mkdir(path.join(plugin, "output-styles"));
      await writeFile(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "cdc-guidance",
          version: "1.0.0",
          description: "Connector-selected communication style",
        }),
      );
      const body = sources
        .find((entry) => entry.id === style.id)!
        .raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      await writeFile(
        path.join(plugin, "output-styles", `${style.id}.md`),
        `---\nname: ${style.id}\ndescription: Connector communication style\nkeep-coding-instructions: true\n---\n\n${body}`,
      );
    }
    try {
      await rename(staging, directory);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return result;
}

export function guidancePrompt(
  prepared: PreparedAgentGuidance | null,
  prompt: string,
): string {
  if (!prepared || /^\/compact(?:\s|$)/i.test(prompt.trim())) return prompt;
  return `Connector guidance selection for this request: read [AGENTS.md](<${prepared.agentsPath}>) and its applicable linked files before doing the task. This selection supersedes earlier connector selections; preserve project instructions and native installed skills.\n\n${prompt}`;
}
