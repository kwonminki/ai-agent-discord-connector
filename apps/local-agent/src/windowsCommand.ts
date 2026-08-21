import { existsSync } from "node:fs";
import path from "node:path";

export interface CommandInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const WINDOWS_RUNNER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$command = $env:CONNECT_CHILD_COMMAND",
  "$arguments = @(ConvertFrom-Json $env:CONNECT_CHILD_ARGS)",
  "$arguments = @($arguments | ForEach-Object { $_.Replace('\"', '\\\"') })",
  "Remove-Item Env:CONNECT_CHILD_COMMAND, Env:CONNECT_CHILD_ARGS",
  "try {",
  "  & $command @arguments",
  "  if ($null -eq $LASTEXITCODE) { exit 0 }",
  "  exit $LASTEXITCODE",
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "}",
].join("\n");

const WINDOWS_RUNNER_ENCODED = Buffer.from(WINDOWS_RUNNER_SCRIPT, "utf16le").toString("base64");

function resolveWindowsCommand(command: string): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  const candidates = path.isAbsolute(command) || /[\\/]/.test(command)
    ? [command, `${command}.exe`, `${command}.com`, `${command}.cmd`, `${command}.bat`]
    : (process.env.Path ?? process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((directory) => [
          path.join(directory, command),
          path.join(directory, `${command}.exe`),
          path.join(directory, `${command}.com`),
          path.join(directory, `${command}.cmd`),
          path.join(directory, `${command}.bat`),
        ]);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function buildCommandInvocation(command: string, args: string[]): CommandInvocation {
  const resolvedCommand = resolveWindowsCommand(command);
  if (!resolvedCommand || !/[.](?:cmd|bat)$/i.test(resolvedCommand)) {
    return { command: resolvedCommand ?? command, args };
  }

  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_RUNNER_ENCODED],
    env: {
      CONNECT_CHILD_COMMAND: resolvedCommand,
      CONNECT_CHILD_ARGS: JSON.stringify(args),
    },
  };
}
