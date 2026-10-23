import path from "node:path";
import { createHostDiscordApi } from "./hostDiscord.js";
import { exportAccess, hostDoctor, loadAccessFile, loadHostSpec, prepareHost, provisionHost } from "./host.js";

export const HOST_USAGE = [
  "cdc host export-access --config <existing/.connect/config.json> --output <private-access.json>",
  "cdc host prepare --dir <fresh-target-directory> --spec <host-spec.json>",
  "cdc host provision --dir <target-directory> --access-file <private-access.json>",
  "cdc host doctor --dir <target-directory>",
];
export function parseHostArgs(args: string[]): { command: string; flags: Map<string, string> } {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) return { command: "help", flags: new Map() };
  const [command = "help", ...rest] = args;
  const options: Record<string, string[]> = {
    "export-access": ["config", "output"], prepare: ["dir", "spec"],
    provision: ["dir", "access-file"], doctor: ["dir"], help: [],
  };
  if (!Object.hasOwn(options, command)) throw new Error("Unknown host command. Use: host prepare, provision, doctor, or export-access.");
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const equals = arg.indexOf("=");
    const key = arg.startsWith("--") ? arg.slice(2, equals < 0 ? undefined : equals) : "";
    if (!options[command].includes(key) || flags.has(key)) throw new Error("Unknown or repeated host option. Tokens and channel IDs are not accepted on the command line.");
    const value = equals < 0 ? rest[++index] : arg.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    flags.set(key, value);
  }
  return { command, flags };
}
export async function runHostCommand(args: string[]): Promise<void> {
  const { command, flags } = parseHostArgs(args);
  const required = (name: string) => {
    const value = flags.get(name);
    if (!value) throw new Error(`host ${command} requires --${name}; this command never prompts.`);
    return path.resolve(value);
  };
  const directory = path.resolve(flags.get("dir") ?? process.cwd());
  if (command === "help") {
    console.info(HOST_USAGE.join("\n"));
    console.info("--dir defaults to the current directory. Access files must be private (0600). These commands never copy channel IDs, runtime state, or agent logins. Doctor performs local checks only.");
    return;
  }
  if (command === "export-access") {
    const output = required("output");
    await exportAccess(required("config"), output);
    console.info(JSON.stringify({ schema: "cdc.access-export.v1", output, mode: "0600", contains: ["bot token", "guild ID", "allowed role IDs", "locale"], channelIdsIncluded: false, runtimeStateIncluded: false }));
  } else if (command === "prepare") {
    const host = await prepareHost({ directory, spec: await loadHostSpec(required("spec")) });
    console.info(JSON.stringify({ schema: "cdc.host-prepared.v1", directory, installationId: host.installationId, computerId: host.computerId, channels: host.spec.channels, discordChanged: false }));
  } else if (command === "provision") {
    const access = await loadAccessFile(required("access-file"));
    const receipt = await provisionHost({ directory, access, api: createHostDiscordApi(access.token) });
    console.info(JSON.stringify(receipt));
  } else {
    const report = await hostDoctor(directory);
    console.info(JSON.stringify(report));
    if (report.localReadyToStart !== true) process.exitCode = 1;
  }
}
