import { describe, expect, it, vi } from "vitest";
import { createOrcaClient, resolveOrcaCommand } from "./orcaClient.js";

const target = { handle: "term_test", incarnationId: "process", executionHostId: "ssh:host", title: "Codex", worktreePath: "/work", agentIdentity: "codex", connected: true, writable: true, orphaned: false, runtimeId: "runtime" };
const envelope = (result: unknown, runtimeId = "runtime") => ({ stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId } }) });
function runner(response: unknown) {
  return vi.fn(async (_command: string, args: string[]) => args[0] === "skills"
    ? { stdout: JSON.stringify({ markdown: "# Orca CLI" }) }
    : envelope(response));
}

describe("Orca CLI adapter", () => {
  it("resolves one executable and avoids the Linux screen reader", () => {
    expect(resolveOrcaCommand({}, "linux")).toBe("orca-ide");
    expect(resolveOrcaCommand({}, "darwin")).toBe("orca");
    expect(resolveOrcaCommand({ ORCA_DEV_REPO_ROOT: "/work" }, "linux")).toBe("orca-dev");
    expect(resolveOrcaCommand({ ORCA_CLI_COMMAND: "/relay/orca" }, "linux")).toBe("/relay/orca");
    expect(resolveOrcaCommand({ CONNECT_ORCA_COMMAND: "/my Orca/bin/orca", ORCA_CLI_COMMAND: "other" })).toBe("/my Orca/bin/orca");
  });
  it("loads the version-matched guide and handles real terminal list metadata", async () => {
    const run = runner({ terminals: [target, { handle: "old-host" }], truncated: true });
    const client = createOrcaClient("orca-test", run);
    expect(await client.list()).toEqual({ terminals: [target], truncated: true });
    await client.list();
    expect(run.mock.calls.filter(([, args]) => args[0] === "skills")).toHaveLength(1);
  });
  it("joins screen rows from the observed CLI envelope", async () => {
    const client = createOrcaClient("orca-test", runner({ terminal: { handle: "term_test", status: "running", tail: ["question", "answer"], source: "screen" } }));
    expect(await client.screen(target)).toBe("question\nanswer");
  });
  it.each(["screen-unavailable", "stream"])("refuses %s instead of pretending it is the current screen", async (source) => {
    const client = createOrcaClient("orca-test", runner({ terminal: { handle: "term_test", status: "running", tail: ["question"], source } }));
    await expect(client.screen(target)).rejects.toThrow("current terminal screen");
  });
  it("refuses to append to a reported local draft but allows reading the screen", async () => {
    const client = createOrcaClient("orca", runner({ terminal: { handle: "term_test", status: "running", tail: ["question"], source: "screen", draft: "unsent" } }));
    expect(await client.screen(target)).toBe("question");
    await expect(client.screen(target, true)).rejects.toThrow("unsent local draft");
  });
  it("passes literal argv and parses the observed send receipt without claiming completion", async () => {
    const run = runner({ send: { handle: "term_test", accepted: true, prompt: { stages: ["input_accepted"], processIncarnation: "process", provider: "codex" } } });
    const client = createOrcaClient("/Orca CLI/orca", run);
    const text = 'hello "x" $(touch /tmp/should-not-exist)\n`printf nope`';
    expect(await client.send(target, text)).toEqual({ accepted: true, turnStarted: false });
    expect(run).toHaveBeenLastCalledWith("/Orca CLI/orca", ["terminal", "send", "--terminal", "term_test", "--text", text, "--enter", "--json"], { timeout: 15000, maxBuffer: 2097152, windowsHide: true });
  });
  it("recognizes an observed turn start and rejects wrong receipt targets", async () => {
    const run = runner({ send: { handle: "term_test", accepted: true, prompt: { stages: ["input_accepted", "turn_started"], processIncarnation: "process" } } });
    expect(await createOrcaClient("orca", run).send(target, "hi")).toEqual({ accepted: true, turnStarted: true });
    await expect(createOrcaClient("orca", run).send({ ...target, incarnationId: "different" }, "hi")).rejects.toThrow("process changed");
  });
  it("does not fall back, leak prompt-bearing execution errors, or resend on failure", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "skills") return { stdout: JSON.stringify({ markdown: "guide" }) };
      throw new Error("secret prompt in command/error");
    });
    await expect(createOrcaClient("missing", run).send(target, "secret prompt")).rejects.toThrow(/^Orca CLI failed/);
    expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls.every(([command]) => command === "missing")).toBe(true);
  });
});
