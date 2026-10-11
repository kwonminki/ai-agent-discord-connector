import { describe, expect, it } from "vitest";
import { resolveOrcaSubagents } from "./orcaSubagents.js";
const terminal = (handle: string) => ({ handle, runtimeId: "runtime", incarnationId: handle + "-inc", executionHostId: "ssh:local", agentIdentity: "codex", title: "Codex", worktreePath: "/repo", connected: true, writable: true, orphaned: false });
const worker = { taskId: "task", runId: "run", agentTerminalHandle: "child", resource: { endpointId: "runtime", endpointIncarnation: "ssh:local@@pty2:1:child-inc" } };
const task = { id: "task", run_id: "run", created_at: "2026-10-11", created_by_terminal_handle: "parent", created_by_process_incarnation: "ssh:local@@pty2:0:parent-inc", task_title: "Check Python loader", display_name: null };
const input = { runId: "run", owners: [{ sessionId: "root-session", terminalHandle: "parent", processKey: "1" }, { sessionId: "child-session", terminalHandle: "child", processKey: "2" }], terminals: [terminal("parent"), terminal("child")], workers: [worker], tasks: [task] };
describe("Orca dispatch relationships", () => {
  it("uses task names and exact local process ownership", () => {
    expect(resolveOrcaSubagents(input)).toEqual([{ sessionId: "child-session", subagent: { source: "orca", parentSessionId: "root-session", name: "Check Python loader" } }]);
  });
  it("rejects reused terminals, foreign runtimes/hosts, unproven parents and ambiguous owners", () => {
    for (const resource of [{ ...worker.resource, endpointId: "foreign" }, { ...worker.resource, endpointIncarnation: "ssh:foreign@@pty2:1:child-inc" }, { ...worker.resource, endpointIncarnation: "ssh:local@@pty2:1:old-inc" }]) {
      expect(resolveOrcaSubagents({ ...input, workers: [{ ...worker, resource }] })).toEqual([]);
    }
    expect(resolveOrcaSubagents({ ...input, owners: input.owners.slice(1) })).toEqual([]);
    expect(resolveOrcaSubagents({ ...input, owners: [...input.owners, { ...input.owners[1], sessionId: "other" }] })).toEqual([]);
    expect(resolveOrcaSubagents({ ...input, tasks: [{ ...task, created_by_process_incarnation: "old" }] })).toEqual([]);
  });
  it("keeps the latest task name on a reused worker with the same proven parent", () => {
    expect(resolveOrcaSubagents({ ...input, workers: [...input.workers, { ...worker, taskId: "new" }], tasks: [...input.tasks, { ...task, id: "new", created_at: "2026-10-12", task_title: "Write tests" }] })[0].subagent.name).toBe("Write tests");
  });
});
