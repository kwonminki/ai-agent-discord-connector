import { execFile } from "node:child_process";
import { open, readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";

export interface OrcaSessionOwner {
  sessionId: string;
  terminalHandle: string;
  processKey: string;
}
const handlePattern = /^term_[A-Za-z0-9_-]{1,100}$/;
const sessionPattern = /^[0-9a-f-]{36}$/i;

export function primaryCodexSession(line: string): string | null {
  try {
    const entry = JSON.parse(line);
    // A CLI can also hold its subagents' logs. They are NOT that terminal's input destination.
    return entry.type === "session_meta" && entry.payload?.source === "cli" &&
      typeof entry.payload.id === "string" && sessionPattern.test(entry.payload.id) ? entry.payload.id : null;
  } catch { return null; }
}

export function terminalHandleFromEnvironment(environment: string, separator = "\0"): string | null {
  const value = environment.split(separator).find((part) => part.startsWith("ORCA_TERMINAL_HANDLE="))?.slice("ORCA_TERMINAL_HANDLE=".length);
  return value && handlePattern.test(value) ? value : null;
}

async function sessionFromFile(file: string): Promise<string | null> {
  // Read metadata only; never load or expose the user's conversation.
  if (!/[/\\]rollout-[^/\\]+\.jsonl$/.test(file)) return null;
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return primaryCodexSession(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]);
  } catch { return null; }
  finally { await handle?.close(); }
}

function processStart(stat: string): string {
  return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19] ?? "";
}

async function linuxOwners(procRoot: string): Promise<OrcaSessionOwner[]> {
  const owners: OrcaSessionOwner[] = [];
  for (const pid of await readdir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    const root = `${procRoot}/${pid}`;
    try {
      if ((await readFile(`${root}/comm`, "utf8")).trim() !== "codex") continue;
      const args = (await readFile(`${root}/cmdline`, "utf8")).split("\0");
      if (args.includes("app-server") || args.includes("exec")) continue;
      const start = processStart(await readFile(`${root}/stat`, "utf8"));
      if (!start) continue;
      const terminalHandle = terminalHandleFromEnvironment(await readFile(`${root}/environ`, "utf8"));
      if (!terminalHandle) continue;
      const sessions = new Set<string>();
      for (const fd of await readdir(`${root}/fd`)) {
        try {
          const session = await sessionFromFile(await readlink(`${root}/fd/${fd}`));
          if (session) sessions.add(session);
        } catch { /* The CLI may close a descriptor while being inspected. */ }
      }
      if (sessions.size !== 1 || processStart(await readFile(`${root}/stat`, "utf8")) !== start) continue;
      owners.push({ terminalHandle, sessionId: [...sessions][0], processKey: `${pid}:${start}` });
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return owners;
}

const run = promisify(execFile);
export function parseLsofProcesses(output: string): Array<{ pid: string; files: string[] }> {
  const processes: Array<{ pid: string; files: string[] }> = [];
  let current: { pid: string; files: string[] } | undefined;
  for (const line of output.split("\n")) {
    if (/^p\d+$/.test(line)) { current = { pid: line.slice(1), files: [] }; processes.push(current); }
    else if (line.startsWith("n") && current) current.files.push(line.slice(1));
  }
  return processes;
}

async function macOwners(): Promise<OrcaSessionOwner[]> {
  const options = { timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
  let output: string;
  try {
    output = (await run("/usr/sbin/lsof", ["-nP", "-a", "-u", String(process.getuid!()), "-c", "codex", "-Fpn"], options)).stdout;
  } catch (error) {
    // lsof exits 1 when there are no matching CLI processes.
    if ((error as { code?: unknown }).code === 1 && !(error as { stdout?: string }).stdout) return [];
    throw new Error("Cannot inspect Orca's Codex process ownership.");
  }
  const owners: OrcaSessionOwner[] = [];
  for (const { pid, files } of parseLsofProcesses(output)) {
    try {
      const args = (await run("/bin/ps", ["-ww", "-p", pid, "-o", "command="], options)).stdout.trimEnd();
      if (/\b(?:app-server|exec)\b/.test(args)) continue;
      const start = (await run("/bin/ps", ["-p", pid, "-o", "lstart="], options)).stdout.trim();
      const withEnvironment = (await run("/bin/ps", ["eww", "-p", pid, "-o", "command="], options)).stdout.trimEnd();
      if (!withEnvironment.startsWith(args)) continue;
      const terminalHandle = terminalHandleFromEnvironment(withEnvironment.slice(args.length).trim(), " ");
      if (!terminalHandle) continue;
      const sessions = new Set((await Promise.all(files.map(sessionFromFile))).filter((value): value is string => !!value));
      if (sessions.size !== 1 || (await run("/bin/ps", ["-p", pid, "-o", "lstart="], options)).stdout.trim() !== start) continue;
      owners.push({ terminalHandle, sessionId: [...sessions][0], processKey: `${pid}:${start}` });
    } catch { /* A process may exit during discovery; do not reuse its PID. */ }
  }
  return owners;
}

export async function findOrcaCodexOwner(sessionId: string, options: { platform?: NodeJS.Platform; procRoot?: string } = {}): Promise<OrcaSessionOwner | null> {
  if (!sessionPattern.test(sessionId)) return null;
  const owners = await listOrcaCodexOwners(options);
  const matches = owners.filter((owner) => owner.sessionId === sessionId);
  if (matches.length > 1) throw new Error("More than one Orca CLI owns this session. Close the duplicate session before replying.");
  return matches[0] ?? null;
}

export async function listOrcaCodexOwners(options: { platform?: NodeJS.Platform; procRoot?: string } = {}): Promise<OrcaSessionOwner[]> {
  const platform = options.platform ?? process.platform;
  const owners = platform === "linux" ? await linuxOwners(options.procRoot ?? "/proc") :
    platform === "darwin" ? await macOwners() : [];
  return owners;
}
