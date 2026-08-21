import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertInsideWorkspace } from "./workspace.js";
import {
  buildWorkspaceCommandInvocation,
  resolveCommandShell,
  runWorkspaceCommand,
} from "./runner.js";

async function makeWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
  return workspaceRoot;
}

afterEach(async () => {
  // No shared fixtures to clean up here; each test manages its own temp dir.
});

describe("workspace guard", () => {
  it("throws when a target escapes the workspace root", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      expect(() => assertInsideWorkspace(workspaceRoot, path.dirname(workspaceRoot))).toThrow(
        "Path escapes workspace root",
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("throws when a symlinked cwd points outside the workspace", async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-outside-"));

    try {
      await fs.mkdir(path.join(workspaceRoot, "linked"), { recursive: true });
      await fs.symlink(
        outsideRoot,
        path.join(workspaceRoot, "linked", "outside"),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(() => assertInsideWorkspace(workspaceRoot, path.join(workspaceRoot, "linked", "outside"))).toThrow(
        "Path escapes workspace root",
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe("runWorkspaceCommand", () => {
  it("uses PowerShell without interpolating the command into executable arguments on Windows", () => {
    expect(
      buildWorkspaceCommandInvocation("Get-ChildItem | Select-Object -First 5", "win32", {
        CONNECT_WORKSPACE_SHELL: "pwsh.exe",
      }),
    ).toEqual({
      executable: "pwsh.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-ChildItem | Select-Object -First 5",
      ],
    });
  });

  it("keeps Unix commands on the existing shell path", () => {
    expect(buildWorkspaceCommandInvocation("ls", "linux", {})).toBeNull();
  });

  it("selects native Unix shells and keeps both override names compatible", () => {
    expect(resolveCommandShell("darwin", {})).toBe("/bin/zsh");
    expect(resolveCommandShell("linux", {})).toBe("/bin/bash");
    expect(resolveCommandShell("linux", {
      CODEX_DISCORD_SHELL: "/usr/bin/fish",
    })).toBe("/usr/bin/fish");
    expect(resolveCommandShell("linux", {
      CONNECT_WORKSPACE_SHELL: "/usr/local/bin/bash",
      CODEX_DISCORD_SHELL: "/usr/bin/fish",
    })).toBe("/usr/local/bin/bash");
  });

  it("runs a safe read command inside the workspace", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await fs.writeFile(path.join(workspaceRoot, "README.md"), "workspace hello\n", "utf8");

      const result = await runWorkspaceCommand({
        workspaceRoot,
        cwd: workspaceRoot,
        command: "cat README.md",
        timeoutMs: 5_000,
        confirmedDangerous: false,
      });

      expect(result).toEqual({
        status: "completed",
        stdout: expect.stringContaining("workspace hello"),
        stderr: "",
        exitCode: 0,
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders ls as a paginated file browser payload", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await fs.mkdir(path.join(workspaceRoot, "apps"));
      await fs.writeFile(path.join(workspaceRoot, "README.md"), "hello\n", "utf8");

      const result = await runWorkspaceCommand({
        workspaceRoot,
        cwd: workspaceRoot,
        command: "ls",
        timeoutMs: 5_000,
        confirmedDangerous: false,
      });

      expect(result).toMatchObject({
        status: "completed",
        stderr: "",
        exitCode: 0,
        ui: {
          kind: "file-browser",
          page: 0,
          pageSize: 25,
          totalEntries: 2,
          entries: [
            { name: "apps", kind: "directory" },
            { name: "README.md", kind: "file" },
          ],
        },
      });
      expect(result.stdout).toContain("apps/");
      expect(result.stdout).toContain("README.md");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("opens directories from the file browser and previews files", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await fs.mkdir(path.join(workspaceRoot, "docs"));
      await fs.writeFile(path.join(workspaceRoot, "README.md"), "hello preview\n", "utf8");

      await expect(
        runWorkspaceCommand({
          workspaceRoot,
          cwd: workspaceRoot,
          command: "__cdc_open docs",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        cwd: await fs.realpath(path.join(workspaceRoot, "docs")),
        ui: {
          kind: "file-browser",
          page: 0,
        },
      });

      await expect(
        runWorkspaceCommand({
          workspaceRoot,
          cwd: workspaceRoot,
          command: "__cdc_open README.md",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        ui: {
          kind: "file-card",
          path: "README.md",
          preview: "hello preview\n",
        },
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns readable file browser errors instead of throwing", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await expect(
        runWorkspaceCommand({
          workspaceRoot,
          cwd: workspaceRoot,
          command: "__cdc_open missing",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        stderr: "Target does not exist.",
        exitCode: 1,
      });

      await expect(
        runWorkspaceCommand({
          workspaceRoot,
          cwd: workspaceRoot,
          command: "__cdc_open ..",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        }),
      ).resolves.toMatchObject({
        status: "blocked",
        stderr: "Path escapes workspace root",
        exitCode: null,
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns an updated cwd for cd commands without running a persistent shell", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await fs.mkdir(path.join(workspaceRoot, "src"));
      const expectedCwd = await fs.realpath(path.join(workspaceRoot, "src"));

      const result = await runWorkspaceCommand({
        workspaceRoot,
        cwd: workspaceRoot,
        command: "cd src",
        timeoutMs: 5_000,
        confirmedDangerous: false,
      });

      expect(result).toEqual({
        status: "completed",
        stdout: `${expectedCwd}\n`,
        stderr: "",
        exitCode: 0,
        cwd: expectedCwd,
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows cd parent traversal when the target stays inside the workspace", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      const nested = path.join(workspaceRoot, "apps");
      await fs.mkdir(nested);
      const expectedCwd = await fs.realpath(workspaceRoot);

      const result = await runWorkspaceCommand({
        workspaceRoot,
        cwd: nested,
        command: "cd ..",
        timeoutMs: 5_000,
        confirmedDangerous: false,
      });

      expect(result).toEqual({
        status: "completed",
        stdout: `${expectedCwd}\n`,
        stderr: "",
        exitCode: 0,
        cwd: expectedCwd,
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps cd commands inside the workspace and rejects file targets", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await fs.writeFile(path.join(workspaceRoot, "README.md"), "hello\n", "utf8");

      await expect(
        runWorkspaceCommand({
          workspaceRoot,
          cwd: workspaceRoot,
          command: "cd ..",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        }),
      ).resolves.toMatchObject({
        status: "blocked",
        stderr: "Path escapes workspace root",
      });

      await expect(
        runWorkspaceCommand({
          workspaceRoot,
          cwd: workspaceRoot,
          command: "cd README.md",
          timeoutMs: 5_000,
          confirmedDangerous: false,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        stderr: "Target is not a directory.",
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("blocks dangerous commands when confirmation is missing", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      await fs.writeFile(path.join(workspaceRoot, "README.md"), "workspace hello\n", "utf8");

      const result = await runWorkspaceCommand({
        workspaceRoot,
        cwd: workspaceRoot,
        command: "rm README.md",
        timeoutMs: 5_000,
        confirmedDangerous: false,
      });

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain("confirmation");
      expect(result.stdout).toBe("");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("exposes timeout details when a command exceeds the timeout", async () => {
    const workspaceRoot = await makeWorkspace();

    try {
      const result = await runWorkspaceCommand({
        workspaceRoot,
        cwd: workspaceRoot,
        command: "sleep 1",
        timeoutMs: 50,
        confirmedDangerous: false,
      });

      expect(result.status).toBe("failed");
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.signal).toBeTruthy();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
