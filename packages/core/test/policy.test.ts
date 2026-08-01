import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorizeCommand,
  classifyCommand,
  parseDiscordMessageCommand,
  updateCwd,
} from "../src/policy.js";

describe("command policy", () => {
  it("classifies safe read, normal mutate, and dangerous mutate commands", () => {
    expect(classifyCommand("ls -la").tier).toBe("safe-read");
    expect(classifyCommand("mkdir reports").tier).toBe("normal-mutate");
    expect(classifyCommand("rm -rf reports").tier).toBe("dangerous-mutate");
  });

  it("classifies PowerShell commands case-insensitively", () => {
    expect(classifyCommand("Get-ChildItem -Force")).toEqual({
      tier: "safe-read",
      requiresConfirmation: false,
    });
    expect(classifyCommand("git.exe status --short")).toEqual({
      tier: "normal-mutate",
      requiresConfirmation: false,
    });
    expect(classifyCommand("Remove-Item -Recurse reports")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("PowerShell.exe -Command Remove-Item reports")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
  });

  it("treats shell wrappers and control operators as dangerous mutate commands", () => {
    expect(classifyCommand("sudo rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("command rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("exec rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("/bin/rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("/usr/bin/git reset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("/usr/bin/sudo rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("/usr/bin/git push --force")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("/usr/bin/git push --force-with-lease")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("bash -lc \"rm -rf /\"")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("ls && rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("ls & rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("echo hi\nrm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("FOO=bar rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("PATH=/usr/bin git reset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand('echo "$(rm -rf /)"')).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand('echo "`rm -rf /`"')).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("eval rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("source ./danger.sh")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand(". ./danger.sh")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("grep foo <(rm -rf /)")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("cat >(rm -rf /)")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git reset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git\treset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git\nreset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git -C /tmp reset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git -c core.pager=cat reset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git --work-tree=/tmp reset --hard HEAD")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push -f origin main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push --force-with-lease=main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push origin +main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git -C /tmp push -f origin main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git -c core.pager=cat push --force")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git --work-tree=/tmp push --force-with-lease=main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push -uf origin main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push -fu origin main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push -vuf origin main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git -c alias.nuke='!rm victim' nuke")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(
      classifyCommand("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.nuke GIT_CONFIG_VALUE_0='!rm victim' git nuke"),
    ).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand(`GIT_CONFIG_PARAMETERS="'alias.nuke=!rm victim'" git nuke`)).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("ALIAS_CMD='!rm victim' git --config-env=alias.nuke=ALIAS_CMD nuke")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("ALIAS_CMD='!rm victim' git --config-env alias.nuke=ALIAS_CMD nuke")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push --mirror")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push --delete origin old-branch")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("git push --prune origin main")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("find . -delete")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("find . -exec rm -rf {} \\;")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("find . -ok rm -rf {} \\;")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("(rm -rf /)")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("! rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("time rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("nohup rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("nice rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("timeout 1 rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("xargs rm -rf /")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand(`python -c 'import os; os.system("rm -rf /")'`)).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand(`python3 -c 'import os; os.system("rm -rf /")'`)).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand(`node -e 'require("child_process").execSync("rm -rf /")'`)).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand(`node --eval 'require("child_process").execSync("rm -rf /")'`)).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
  });

  it("keeps simple pipelines readable when every segment is safe read", () => {
    expect(classifyCommand("ls | grep foo").tier).toBe("safe-read");
    expect(classifyCommand('grep "foo|bar" file').tier).toBe("safe-read");
    expect(classifyCommand("grep foo\\|bar file").tier).toBe("safe-read");
    expect(classifyCommand('echo "--force"').tier).toBe("safe-read");
    expect(classifyCommand('echo "$((1+2))"').tier).toBe("safe-read");
    expect(classifyCommand("cat /etc/passwd")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("ls /tmp")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("grep foo ../secret")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("cd /tmp")).toEqual({
      tier: "dangerous-mutate",
      requiresConfirmation: true,
    });
    expect(classifyCommand("echo hi > /tmp/x").tier).toBe("dangerous-mutate");
    expect(classifyCommand("ls >> /tmp/x").tier).toBe("dangerous-mutate");
    expect(classifyCommand("cat < /tmp/x").tier).toBe("dangerous-mutate");
    expect(classifyCommand('echo "<(foo)"').tier).toBe("safe-read");
  });

  it("allows bare commands only in shell-admin channels", () => {
    expect(parseDiscordMessageCommand({ mode: "shell-admin", content: "ls" })).toEqual({
      kind: "command",
      command: "ls",
    });
    expect(parseDiscordMessageCommand({ mode: "session-linked", content: "ls" })).toEqual({
      kind: "chat",
      content: "ls",
    });
    expect(parseDiscordMessageCommand({ mode: "session-linked", content: "!ls" })).toEqual({
      kind: "command",
      command: "ls",
    });
  });

  it("requires an allowed role", () => {
    expect(
      authorizeCommand({
        userRoleIds: ["role-operator"],
        allowedRoleIds: ["role-operator"],
      }).allowed,
    ).toBe(true);

    expect(
      authorizeCommand({
        userRoleIds: ["role-viewer"],
        allowedRoleIds: ["role-operator"],
      }).allowed,
    ).toBe(false);
  });

  it("updates cwd only when the next path remains inside workspace root", () => {
    const workspaceRoot = path.resolve("/repo");
    expect(updateCwd(workspaceRoot, path.join(workspaceRoot, "src"), "..")).toBe(workspaceRoot);
    expect(() => updateCwd(workspaceRoot, workspaceRoot, "..")).toThrow("Path escapes workspace root");
  });

  it("blocks symlink escapes from the workspace root", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-outside-"));
    const symlinkPath = path.join(workspaceRoot, "outside-link");

    try {
      fs.symlinkSync(outsideRoot, symlinkPath, process.platform === "win32" ? "junction" : "dir");

      expect(() => updateCwd(workspaceRoot, workspaceRoot, "outside-link")).toThrow(
        "Path escapes workspace root",
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("blocks symlinked parent paths even when the final child does not exist", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-outside-"));
    const symlinkPath = path.join(workspaceRoot, "outside-link");

    try {
      fs.symlinkSync(outsideRoot, symlinkPath, process.platform === "win32" ? "junction" : "dir");

      expect(() =>
        updateCwd(workspaceRoot, workspaceRoot, "outside-link/nonexistent-child"),
      ).toThrow("Path escapes workspace root");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
