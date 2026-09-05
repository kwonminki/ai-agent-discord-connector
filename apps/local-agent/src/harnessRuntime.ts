import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  claudeHarnessPluginManifest,
  harnessManifestYaml,
  validateHarnessCandidate,
  type HarnessProvider,
  type HarnessWorkerBinding,
} from "../../../packages/core/src/index.js";

export interface VerifiedHarnessRuntime {
  binding: HarnessWorkerBinding;
  skillPath: string;
  claudePluginPath: string;
  claudePluginName: string;
}

export function defaultWorkerHarnessRootPath(): string {
  const statePath = path.resolve(process.env.CONNECT_STATE_PATH ?? ".connect/state.json");
  return path.resolve(process.env.CONNECT_HARNESS_ROOT ?? path.join(path.dirname(statePath), "harnesses"));
}

function materializedPath(candidatePath: string): string {
  if (candidatePath === "SKILL.md") {
    return "skill/SKILL.md";
  }
  if (candidatePath.startsWith("agents/")) {
    return candidatePath;
  }
  return `skill/${candidatePath}`;
}

function assertInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Harness snapshot path is outside the configured published root.");
  }
}

async function collectFilesWithoutLinks(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Harness snapshot contains a symbolic link: ${relative}`);
      }
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Harness snapshot contains an unsupported filesystem entry: ${relative}`);
      }
      files.push(relative);
    }
  }

  await visit(root, "");
  return files.sort();
}

export async function verifyHarnessWorkerBinding(
  binding: HarnessWorkerBinding,
  provider: HarnessProvider,
  rootPath = defaultWorkerHarnessRootPath(),
): Promise<VerifiedHarnessRuntime> {
  const publishedRoot = await realpath(path.join(path.resolve(rootPath), "published"));
  const snapshotPath = await realpath(path.resolve(binding.snapshotPath));
  assertInside(publishedRoot, snapshotPath);

  const rawSnapshot = JSON.parse(await readFile(path.join(snapshotPath, "snapshot.json"), "utf8")) as {
    schemaVersion?: unknown;
    harnessVersionId?: unknown;
    digest?: unknown;
    manifest?: unknown;
    files?: unknown;
  };
  const candidate = validateHarnessCandidate({ manifest: rawSnapshot.manifest, files: rawSnapshot.files });

  if (rawSnapshot.schemaVersion !== 1 || binding.schemaVersion !== 1) {
    throw new Error("Unsupported harness snapshot schema version.");
  }
  if (rawSnapshot.harnessVersionId !== binding.harnessVersionId) {
    throw new Error("Harness version binding does not match snapshot metadata.");
  }
  if (rawSnapshot.digest !== candidate.digest || binding.snapshotDigest !== candidate.digest) {
    throw new Error("Harness snapshot digest verification failed.");
  }
  if (binding.harnessId !== candidate.manifest.id || binding.skillName !== candidate.manifest.name) {
    throw new Error("Harness identity binding does not match the published snapshot.");
  }
  if (!candidate.manifest.providers.includes(provider)) {
    throw new Error(`Harness ${binding.harnessVersionId} does not support provider ${provider}.`);
  }

  const expectedFiles = [
    ".claude-plugin/plugin.json",
    "harness.yaml",
    "snapshot.json",
    ...candidate.files.map((file) => materializedPath(file.path)),
  ].sort();
  const actualFiles = await collectFilesWithoutLinks(snapshotPath);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Harness snapshot contains missing or unexpected files.");
  }

  for (const file of candidate.files) {
    const actual = await readFile(path.join(snapshotPath, materializedPath(file.path)), "utf8");
    if (actual !== file.content) {
      throw new Error(`Harness snapshot file verification failed: ${file.path}`);
    }
  }
  if (await readFile(path.join(snapshotPath, "harness.yaml"), "utf8") !== harnessManifestYaml(candidate.manifest)) {
    throw new Error("Harness manifest materialization verification failed.");
  }
  if (
    await readFile(path.join(snapshotPath, ".claude-plugin", "plugin.json"), "utf8") !==
    claudeHarnessPluginManifest(candidate.manifest)
  ) {
    throw new Error("Harness Claude plugin manifest verification failed.");
  }

  return {
    binding,
    skillPath: path.join(snapshotPath, "skill", "SKILL.md"),
    claudePluginPath: snapshotPath,
    claudePluginName: `cdc-${candidate.manifest.id}`,
  };
}
