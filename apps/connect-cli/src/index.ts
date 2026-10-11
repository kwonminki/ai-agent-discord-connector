import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  localizeConnectorText,
  resolveConnectorLocale,
  type ConnectorLocale,
} from "../../../packages/core/src/index.js";
import {
  buildDirectConfig,
  buildHubConfig,
  type ConnectMode,
  writeSetupFiles,
} from "./config.js";

export const BOT_RELOAD_EXIT_CODE = 42;

export function shouldRestartManagedProcess(input: {
  script: string;
  code: number | null;
  mode?: ConnectMode;
}): boolean {
  if (input.script === "dev:bot" && input.code === BOT_RELOAD_EXIT_CODE) {
    return true;
  }

  return input.mode === "direct" &&
    (input.script === "dev:bot" || input.script === "direct-worker" || input.script === "dev:relay");
}

type ManagedProcessCommand = [command: string, args: string[], script: string];
export type ManagedDirectComponent = "all" | "bot" | "worker" | "relay";

export function buildManagedProcessCommands(
  mode: ConnectMode,
  component: ManagedDirectComponent = "all",
): ManagedProcessCommand[] {
  const runTs = (entrypoint: string, script: string): ManagedProcessCommand => [
    "node",
    ["--import", "tsx", entrypoint],
    script,
  ];

  if (mode === "hub") {
    return [
      runTs("apps/control-api/src/index.ts", "dev:control"),
      runTs("apps/local-agent/src/index.ts", "dev:agent"),
      runTs("apps/discord-bot/src/index.ts", "dev:bot"),
    ];
  }

  if (component === "relay") {
    return [runTs("apps/relay-bot/src/index.ts", "dev:relay")];
  }

  const directCommands = [
    runTs("apps/local-agent/src/directWorker.ts", "direct-worker"),
    runTs("apps/discord-bot/src/index.ts", "dev:bot"),
  ];

  return directCommands.filter(([, , script]) =>
    component === "all" ||
    (component === "bot" && script === "dev:bot") ||
    (component === "worker" && script === "direct-worker"),
  );
}

export function buildManagedProcessEnv(
  mode: ConnectMode,
  launchDirectory: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CONNECT_CONFIG_PATH: path.join(launchDirectory, ".connect", "config.json"),
    CONNECT_STATE_PATH: path.join(launchDirectory, ".connect", "state.json"),
    CONNECT_WORKER_ROOT: path.join(launchDirectory, ".connect", "worker"),
    CONNECT_DISCORD_QUEUE_ROOT: path.join(launchDirectory, ".connect", "discord-queue"),
    CONNECT_ORCA_STATE_PATH: baseEnv.CONNECT_ORCA_STATE_PATH || path.join(launchDirectory, ".connect", "orca-bindings.json"),
    CONNECT_MODE: mode,
  };
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function parseArgs(args: string[]): { command: string; flags: Map<string, string | boolean> } {
  const [command = "help", ...rest] = args;
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);

    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const nextValue = rest[index + 1];

    if (nextValue && !nextValue.startsWith("--")) {
      flags.set(key, nextValue);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { command, flags };
}

function flag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function askMissing(inputValue: string | undefined, question: string): Promise<string> {
  if (inputValue) {
    return inputValue;
  }

  const rl = createInterface({ input, output });

  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function askOptional(inputValue: string | undefined, question: string): Promise<string | undefined> {
  if (inputValue !== undefined) {
    return inputValue.trim() || undefined;
  }

  const rl = createInterface({ input, output });

  try {
    return (await rl.question(question)).trim() || undefined;
  } finally {
    rl.close();
  }
}

function cliText(value: string, locale: ConnectorLocale): string {
  return localizeConnectorText(value, locale);
}

export function discordSetupGuide(mode: ConnectMode, locale: ConnectorLocale = "ko"): string[] {
  const lines = [
    "Discord 설정값 준비:",
    "  1. Bot token: Discord Developer Portal (https://discord.com/developers/applications) > 앱 선택 > Bot > Reset Token/Copy",
    "     Public Key와 OAuth2 Client ID는 connector 설정에 넣지 않습니다. Bot token은 외부에 공유하지 마세요.",
    "  2. Server/Guild ID: Discord 사용자 설정 > 고급 > 개발자 모드 활성화 > 서버 아이콘 우클릭 > 서버 ID 복사",
    "  3. Operator role ID: 서버 설정 > 역할 > 허용할 역할 우클릭 > 역할 ID 복사",
    "     connector를 사용할 사람에게 이 역할을 부여하세요. 여러 역할은 쉼표로 구분합니다.",
  ];

  if (mode === "direct") {
    lines.push(
      "  4. AI agent/admin channel ID: 전용 AI agent 관리 채널 우클릭 > 채널 ID 복사",
      "  5. Claude Code channel ID: 전용 Claude Code 채널 우클릭 > 채널 ID 복사",
      "     두 채널은 서로 달라야 합니다. Claude Code를 쓰지 않으면 마지막 입력에서 Enter를 누르세요.",
    );
  }

  return lines.map((line) => cliText(line, locale));
}

async function setup(flags: Map<string, string | boolean>) {
  const mode = (flag(flags, "mode") ?? (flags.has("hub") ? "hub" : "direct")) as ConnectMode;
  const locale = resolveConnectorLocale(flag(flags, "locale") ?? process.env.CONNECT_LOCALE);

  console.info(discordSetupGuide(mode, locale).join("\n"));
  console.info("");

  const token = await askMissing(
    flag(flags, "token") ?? process.env.DISCORD_TOKEN,
    cliText("Discord bot token (Developer Portal > Bot): ", locale),
  );
  const guildId = await askMissing(
    flag(flags, "guild-id") ?? process.env.DISCORD_GUILD_ID,
    cliText("Discord server/guild ID (server icon > Copy Server ID): ", locale),
  );
  const roleIds = await askMissing(
    flag(flags, "role-ids") ?? process.env.DISCORD_ALLOWED_ROLE_IDS,
    cliText("Operator role IDs (comma-separated): ", locale),
  );

  const channelId = mode === "direct"
    ? await askMissing(
        flag(flags, "channel-id") ?? process.env.AGENT_ADMIN_CHANNEL_ID ?? process.env.CODEX_CHANNEL_ID,
        cliText("AI agent/admin channel ID (agent admin channel > Copy Channel ID): ", locale),
      )
    : undefined;
  const claudeChannelId = mode === "direct"
    ? await askOptional(
        flag(flags, "claude-channel-id") ?? process.env.CLAUDE_CHANNEL_ID,
        cliText("Claude Code channel ID (Claude channel > Copy Channel ID, Enter to disable): ", locale),
      )
    : undefined;

  const config =
    mode === "hub"
      ? buildHubConfig({
          token,
          guildId,
          roleIds,
          controlApiUrl: flag(flags, "control-api-url"),
          controlWsUrl: flag(flags, "control-ws-url"),
          locale,
        })
      : buildDirectConfig({
          token,
          guildId,
          roleIds,
          channelId: channelId!,
          claudeChannelId,
          workspaceRoot: await askMissing(flag(flags, "workspace-root") ?? process.cwd(), "Workspace root: "),
          initialCwd: flag(flags, "initial-cwd"),
          workspaceDisplayName: flag(flags, "workspace-name"),
          computerId: flag(flags, "computer-id"),
          computerDisplayName: flag(flags, "computer-name"),
          codexHome: flag(flags, "codex-home"),
          maintenanceAgent: flag(flags, "maintenance-agent"),
          orcaCommand: flag(flags, "orca-command") ?? process.env.CONNECT_ORCA_COMMAND,
          locale,
        });

  await writeSetupFiles({ cwd: process.cwd(), config });

  console.info("Wrote .connect/config.json and .env");
  console.info(mode === "direct" ? "Start with: cdc start --direct" : "Start with: cdc start --hub");
}

async function status() {
  const configPath = ".connect/config.json";

  if (!existsSync(configPath)) {
    console.info("No .connect/config.json found. Run: cdc setup --direct");
    return;
  }

  const rawConfig = await readFile(configPath, "utf8");
  const config = JSON.parse(rawConfig) as { mode?: unknown; discord?: { locale?: unknown } };
  console.info(`Connect config: ${configPath}`);
  console.info(`Mode: ${String(config.mode ?? "unknown")}`);
  console.info(`Locale: ${String(config.discord?.locale ?? "ko")}`);
}

async function start(flags: Map<string, string | boolean>) {
  const mode = (flag(flags, "mode") ?? (flags.has("hub") ? "hub" : "direct")) as ConnectMode;
  const requestedComponent = flag(flags, "component") ?? "all";
  if (mode === "hub" && requestedComponent !== "all") {
    throw new Error("--component is supported only in direct mode.");
  }
  if (
    requestedComponent !== "all" &&
    requestedComponent !== "bot" &&
    requestedComponent !== "worker" &&
    requestedComponent !== "relay"
  ) {
    throw new Error("--component must be all, bot, worker, or relay.");
  }
  const component = requestedComponent as ManagedDirectComponent;
  const env = buildManagedProcessEnv(mode, process.cwd());
  const commands = buildManagedProcessCommands(mode, component);
  const commandCwd = packageRoot();

  await new Promise<void>((resolve, reject) => {
    const children = new Map<string, ChildProcess>();
    let settled = false;

    function stopOtherChildren(exceptScript: string) {
      for (const [script, child] of children) {
        if (script !== exceptScript && !child.killed) {
          child.kill();
        }
      }
    }

    function settleFromExit(script: string, code: number | null) {
      if (settled) {
        return;
      }

      settled = true;
      stopOtherChildren(script);

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${script} exited with code ${code ?? "unknown"}`));
    }

    function launch([cmd, args, script]: ManagedProcessCommand) {
      const child = spawn(cmd === "node" ? process.execPath : cmd, args, {
        cwd: commandCwd,
        env,
        stdio: "inherit",
      });

      children.set(script, child);
      child.once("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        stopOtherChildren(script);
        reject(error);
      });
      child.once("exit", (code) => {
        children.delete(script);

        if (settled) {
          return;
        }

        if (shouldRestartManagedProcess({ script, code, mode })) {
          console.info(`${script} exited; restarting managed process...`);
          launch([cmd, args, script]);
          return;
        }

        settleFromExit(script, code);
      });
    }

    for (const command of commands) {
      launch(command);
    }
  });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parseArgs(args);

  if (command === "setup" || command === "install" || command === "init") {
    await setup(flags);
    return;
  }

  if (command === "status") {
    await status();
    return;
  }

  if (command === "start") {
    await start(flags);
    return;
  }

  console.info("Usage:");
  console.info("  cdc install --direct");
  console.info("  cdc install --direct --locale en");
  console.info("  cdc setup --direct");
  console.info("  cdc setup --hub");
  console.info("  cdc start --direct");
  console.info("  cdc start --direct --component bot");
  console.info("  cdc start --direct --component worker");
  console.info("  cdc start --direct --component relay");
  console.info("  cdc status");
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  await main();
}
