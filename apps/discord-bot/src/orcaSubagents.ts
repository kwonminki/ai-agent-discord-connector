import { z } from "zod";
import type { CodexSubagent } from "../../../packages/codex-adapter/src/parser.js";
import type { OrcaSessionOwner } from "./orcaSessionOwner.js";
import type { OrcaTarget } from "./orcaClient.js";

export interface OrcaSubagentLink { sessionId: string; subagent: CodexSubagent }
const taskSchema = z.object({
  id: z.string(), run_id: z.string(), created_at: z.string(),
  created_by_terminal_handle: z.string().nullable(), created_by_process_incarnation: z.string().nullable(),
  task_title: z.string().nullable(), display_name: z.string().nullable(),
});
const workerSchema = z.object({
  taskId: z.string(), runId: z.string(), agentTerminalHandle: z.string().nullable(),
  resource: z.object({ endpointId: z.string().nullable(), endpointIncarnation: z.string().nullable() }).nullable(),
});
function matchesIncarnation(value: string | null | undefined, terminal: OrcaTarget) {
  return !!value && value.startsWith(`${terminal.executionHostId}@@`) && value.endsWith(`:${terminal.incarnationId}`);
}

// Only authoritative dispatch records and proven local CLI ownership establish a
// relationship. Titles, cwd, copied fork history, and prompt text never do.
export function resolveOrcaSubagents(input: {
  runId: string; owners: OrcaSessionOwner[]; terminals: OrcaTarget[]; workers: unknown[]; tasks: unknown[];
}): OrcaSubagentLink[] {
  const local = new Map<string, { owner: OrcaSessionOwner; terminal: OrcaTarget }>();
  for (const terminal of input.terminals) {
    const owners = input.owners.filter(owner => owner.terminalHandle === terminal.handle);
    if (owners.length === 1 && terminal.agentIdentity === "codex" && !terminal.orphaned) local.set(terminal.handle, { owner: owners[0], terminal });
  }
  const tasks = input.tasks.flatMap(value => { const task = taskSchema.safeParse(value); return task.success ? [task.data] : []; });
  const candidates = new Map<string, { date: string; link: OrcaSubagentLink }[]>();
  for (const raw of input.workers) {
    const parsed = workerSchema.safeParse(raw);
    if (!parsed.success) continue;
    const worker = parsed.data;
    const task = tasks.find(task => task.id === worker.taskId && task.run_id === input.runId);
    const child = local.get(worker.agentTerminalHandle ?? "");
    const parent = local.get(task?.created_by_terminal_handle ?? "");
    if (worker.runId !== input.runId || !task || !child || !parent || child.owner.sessionId === parent.owner.sessionId ||
        worker.resource?.endpointId !== child.terminal.runtimeId ||
        !matchesIncarnation(worker.resource?.endpointIncarnation, child.terminal) ||
        !matchesIncarnation(task.created_by_process_incarnation, parent.terminal)) continue;
    const link: OrcaSubagentLink = { sessionId: child.owner.sessionId, subagent: {
      source: "orca", parentSessionId: parent.owner.sessionId,
      name: task.task_title?.trim() || task.display_name?.trim() || "Orca worker",
    } };
    const rows = candidates.get(link.sessionId) ?? [];
    rows.push({ date: task.created_at, link }); candidates.set(link.sessionId, rows);
  }
  return [...candidates.values()].flatMap(rows => {
    rows.sort((a, b) => b.date.localeCompare(a.date));
    // Conflicting parents are ambiguous even if one task happens to be newer.
    return new Set(rows.map(row => row.link.subagent.parentSessionId)).size === 1 ? [rows[0].link] : [];
  });
}
