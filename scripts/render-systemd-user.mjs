#!/usr/bin/env node
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

function value(text) {
  if (typeof text !== "string" || !text || /[\x00-\x1f\x7f]/.test(text)) {
    throw new Error("Service values must be nonempty and contain no control characters.");
  }
  return text;
}

function absolute(text) {
  value(text);
  if (!path.isAbsolute(text)) throw new Error("Service paths must be absolute.");
  return text;
}

function quote(text, exec = false) {
  const escaped = value(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${exec ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

export function renderUnits(options) {
  const directory = absolute(options.installDir);
  if (directory.includes("\\") || directory.trimEnd() !== directory || directory.split("/").includes("..")) {
    throw new Error("The install directory cannot contain backslashes, parent traversal, or trailing whitespace.");
  }
  const home = absolute(options.home ?? os.homedir());
  const node = absolute(options.node ?? process.execPath);
  const prefix = options.prefix ?? "ai-agent-discord";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(prefix)) throw new Error("Invalid service prefix.");
  const searchPath = value(options.path ?? process.env.PATH);
  const common = {
    HOME: home,
    PATH: searchPath,
    NODE_ENV: "production",
    CONNECT_MODE: "direct",
    CONNECT_CONFIG_PATH: path.join(directory, ".connect/config.json"),
    CONNECT_STATE_PATH: path.join(directory, ".connect/state.json"),
    CONNECT_WORKER_ROOT: path.join(directory, ".connect/worker"),
    CONNECT_DISCORD_QUEUE_ROOT: path.join(directory, ".connect/discord-queue"),
    CODEX_DISCORD_CODEX_RUNNER: "app-server",
    ...(options.codexHome ? { CODEX_HOME: absolute(options.codexHome) } : {}),
    ...(options.claudeConfigDir ? { CLAUDE_CONFIG_DIR: absolute(options.claudeConfigDir) } : {}),
  };
  const environment = Object.entries(common).map(([key, val]) => `Environment=${quote(`${key}=${val}`)}`).join("\n");
  return Object.fromEntries(["worker", "bot"].map((component) => {
    const entry = component === "worker" ? "apps/local-agent/src/directWorker.ts" : "apps/discord-bot/src/index.ts";
    return [`${prefix}-${component}.service`, [
      "[Unit]",
      `Description=AI Agent Discord ${component}`,
      `After=network-online.target${component === "bot" ? ` ${prefix}-worker.service` : ""}`,
      ...(component === "bot" ? [`Wants=${prefix}-worker.service`] : []),
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${directory.replaceAll("%", "%%")}`,
      environment,
      `ExecStart=${quote(node, true)} --import tsx ${quote(path.join(directory, entry), true)}`,
      "Restart=on-failure",
      "RestartSec=5",
      ...(component === "worker" ? ["KillMode=mixed", "TimeoutStopSec=infinity"] : []),
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n")];
  }));
}

export async function writeUnits(directory, units) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Preflight every destination before creating any files. Never replace an
  // existing installation's independently maintained service definition.
  const pending = [];
  for (const [name, body] of Object.entries(units)) {
    const destination = path.join(directory, name);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || await readFile(destination, "utf8") !== body) {
        throw new Error(`Service file already exists with different content: ${destination}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      pending.push([destination, body]);
    }
  }
  for (const [destination, body] of pending) {
    await writeFile(destination, body, { flag: "wx", mode: 0o600 });
  }
  return { files: Object.keys(units).map((name) => path.join(directory, name)), created: pending.length };
}

async function main() {
  const { values } = parseArgs({ options: {
    "install-dir": { type: "string" }, "output-dir": { type: "string" },
    prefix: { type: "string" }, node: { type: "string" }, home: { type: "string" },
    path: { type: "string" }, "codex-home": { type: "string" },
    "claude-config-dir": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.info("node scripts/render-systemd-user.mjs --install-dir ABSOLUTE_CHECKOUT --output-dir ABSOLUTE_DIRECTORY [--prefix NAME] [--node PATH] [--home PATH] [--path PATH] [--codex-home PATH] [--claude-config-dir PATH]");
    return;
  }
  const units = renderUnits({
    installDir: values["install-dir"], prefix: values.prefix, node: values.node,
    home: values.home, path: values.path, codexHome: values["codex-home"],
    claudeConfigDir: values["claude-config-dir"],
  });
  const result = await writeUnits(absolute(values["output-dir"]), units);
  console.info(JSON.stringify({ ...result, activated: false }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
