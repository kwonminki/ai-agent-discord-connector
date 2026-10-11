import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const terminalSchema = z.object({
  handle: z.string().min(1),
  incarnationId: z.string().min(1),
  executionHostId: z.string().min(1),
  title: z.string().default("Orca"),
  worktreePath: z.string().default(""),
  agentIdentity: z.string().optional(),
  connected: z.boolean(),
  writable: z.boolean(),
  orphaned: z.boolean().default(false),
});
export type OrcaTerminal = z.infer<typeof terminalSchema>;
export type OrcaTarget = OrcaTerminal & { runtimeId: string };
export interface OrcaClient {
  list(): Promise<{ terminals: OrcaTarget[]; truncated: boolean }>;
  show(handle: string): Promise<OrcaTarget>;
  screen(target: OrcaTarget, beforeInput?: boolean): Promise<string>;
  send(target: OrcaTarget, text: string): Promise<{ accepted: boolean; turnStarted: boolean }>;
}

export function resolveOrcaCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return env.CONNECT_ORCA_COMMAND?.trim() || env.ORCA_CLI_COMMAND?.trim() ||
    (env.ORCA_DEV_REPO_ROOT ? "orca-dev" : platform === "linux" ? "orca-ide" : "orca");
}

export function isOrcaAgent(terminal: OrcaTerminal): boolean {
  return terminal.connected && terminal.writable && !terminal.orphaned &&
    ["codex", "claude", "claude-code"].includes(terminal.agentIdentity ?? "");
}

export function sameOrcaTarget(a: OrcaTarget, b: OrcaTarget): boolean {
  return a.runtimeId === b.runtimeId && a.handle === b.handle &&
    a.incarnationId === b.incarnationId && a.executionHostId === b.executionHostId &&
    a.agentIdentity === b.agentIdentity;
}

const envelopeSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
  _meta: z.object({ runtimeId: z.string().min(1) }),
});

export function createOrcaClient(
  command = resolveOrcaCommand(),
  run: (command: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string }> = promisify(execFile),
): OrcaClient {
  let guide: Promise<void> | undefined;
  async function invoke(args: string[]) {
    try {
      // Never use a shell: prompts, handles, and executable paths are literal argv.
      const { stdout } = await run(command, [...args, "--json"], {
        timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
      return JSON.parse(stdout) as unknown;
    } catch {
      // execFile errors include the full command/prompt. Do not expose those in Discord/logs.
      throw new Error("Orca CLI failed. Check CONNECT_ORCA_COMMAND and the running Orca runtime.");
    }
  }
  async function call(args: string[]) {
    guide ??= invoke(["skills", "get", "orca-cli"]).then((value) => {
      const object = value as { markdown?: unknown; result?: { markdown?: unknown } };
      if (typeof (object?.markdown ?? object?.result?.markdown) !== "string") {
        throw new Error("Update Orca: the version-matched CLI guide is unavailable.");
      }
    }).catch((error) => { guide = undefined; throw error; });
    await guide;
    return envelopeSchema.parse(await invoke(args));
  }
  return {
    async list() {
      const response = await call(["terminal", "list", "--limit", "100"]);
      const result = z.object({ terminals: z.array(z.unknown()), truncated: z.boolean().default(false) }).parse(response.result);
      // Old hosts without incarnation metadata must not become writable bindings.
      const terminals = result.terminals.flatMap((value) => {
        const parsed = terminalSchema.safeParse(value);
        return parsed.success ? [{ ...parsed.data, runtimeId: response._meta.runtimeId }] : [];
      });
      return { terminals, truncated: result.truncated };
    },
    async show(handle) {
      const response = await call(["terminal", "show", "--terminal", handle]);
      const { terminal } = z.object({ terminal: terminalSchema }).parse(response.result);
      if (terminal.handle !== handle) throw new Error("Orca returned a different terminal.");
      return { ...terminal, runtimeId: response._meta.runtimeId };
    },
    async screen(target, beforeInput = false) {
      const response = await call(["terminal", "read", "--terminal", target.handle, "--screen", "--limit", "40"]);
      const { terminal } = z.object({ terminal: z.object({
        handle: z.string(), status: z.string(), tail: z.union([z.string(), z.array(z.string())]), source: z.string(), draft: z.unknown().optional(),
      }) }).parse(response.result);
      if (response._meta.runtimeId !== target.runtimeId || terminal.handle !== target.handle ||
          terminal.status !== "running" || terminal.source !== "screen") {
        throw new Error("Orca cannot read the current terminal screen. Refresh /orca before sending.");
      }
      if (beforeInput && terminal.draft) {
        throw new Error("Orca has an unsent local draft. Clear or submit it locally before sending from Discord.");
      }
      return Array.isArray(terminal.tail) ? terminal.tail.join("\n") : terminal.tail;
    },
    async send(target, text) {
      const response = await call(["terminal", "send", "--terminal", target.handle, "--text", text, "--enter"]);
      if (response._meta.runtimeId !== target.runtimeId) throw new Error("Orca runtime changed during submission.");
      const { send } = z.object({ send: z.object({
        handle: z.string(), accepted: z.boolean(),
        prompt: z.object({ stages: z.array(z.string()), processIncarnation: z.string().optional() }).optional(),
      }) }).parse(response.result);
      if (send.handle !== target.handle ||
          (send.prompt?.processIncarnation && send.prompt.processIncarnation !== target.incarnationId)) {
        throw new Error("Orca process changed during submission.");
      }
      return { accepted: send.accepted, turnStarted: send.prompt?.stages.includes("turn_started") ?? false };
    },
  };
}
