import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrcaCodexOwner, parseLsofProcesses, primaryCodexSession, terminalHandleFromEnvironment } from "./orcaSessionOwner.js";

const sessionId = "01a122d1-1d96-7b73-ac09-4e7b3551896b";
const otherSession = "01a123ce-d826-7383-8417-c2f1acdc01ba";
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "orca-owner-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function processFixture(pid: string, options: { args?: string; handle?: string; sessions?: Array<{ id: string; source: unknown }> } = {}) {
  const proc = path.join(root, pid);
  await rm(path.join(proc, "fd"), { recursive: true, force: true });
  await mkdir(path.join(proc, "fd"), { recursive: true });
  const fields = Array(20).fill("0"); fields[19] = "54321";
  await writeFile(path.join(proc, "comm"), "codex\n");
  await writeFile(path.join(proc, "cmdline"), options.args ?? "/bin/codex\0--model\0example\0");
  await writeFile(path.join(proc, "stat"), `${pid} (codex) ${fields.join(" ")}`);
  await writeFile(path.join(proc, "environ"), `PRIVATE_TOKEN=not-returned\0ORCA_TERMINAL_HANDLE=${options.handle ?? "term_exact"}\0`);
  for (const [i, session] of (options.sessions ?? [{ id: sessionId, source: "cli" }]).entries()) {
    const file = path.join(root, `rollout-${pid}-${session.id}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "session_meta", payload: session }) + '\n{"privateConversation":"not parsed"}\n');
    await symlink(file, path.join(proc, "fd", String(i + 3)));
  }
}
const find = (id = sessionId) => findOrcaCodexOwner(id, { platform: "linux", procRoot: root });

describe("exact Orca session ownership", () => {
  it("links the primary CLI session to its runtime-issued terminal handle", async () => {
    await processFixture("100");
    expect(await find()).toEqual({ sessionId, terminalHandle: "term_exact", processKey: "100:54321" });
  });
  it("does not send a subagent thread's answer to the parent's terminal", async () => {
    await processFixture("100", { sessions: [{ id: sessionId, source: "cli" }, { id: otherSession, source: { subagent: { thread_spawn: { parent_thread_id: sessionId } } } }] });
    expect(await find()).not.toBeNull(); expect(await find(otherSession)).toBeNull();
  });
  it.each(["app-server", "exec"])("ignores %s processes even if they inherit Orca variables", async (command) => {
    await processFixture("100", { args: `/bin/codex\0${command}\0` }); expect(await find()).toBeNull();
  });
  it("never guesses from a shared directory, a missing handle, or another session", async () => {
    await processFixture("100", { handle: "", sessions: [{ id: sessionId, source: "cli" }] });
    await processFixture("200", { sessions: [{ id: otherSession, source: "cli" }] });
    expect(await find()).toBeNull();
  });
  it("refuses ambiguous ownership across processes or within one process", async () => {
    await processFixture("100"); await processFixture("200", { handle: "term_other" });
    await expect(find()).rejects.toThrow("More than one");
    await rm(path.join(root, "200"), { recursive: true });
    await processFixture("100", { sessions: [{ id: sessionId, source: "cli" }, { id: otherSession, source: "cli" }] });
    expect(await find()).toBeNull();
  });
  it("extracts only the exact Orca variable and primary metadata", () => {
    expect(terminalHandleFromEnvironment("OTHER_ORCA_TERMINAL_HANDLE=term_wrong\0ORCA_TERMINAL_HANDLE=term_right\0")).toBe("term_right");
    expect(terminalHandleFromEnvironment("A=b ORCA_TERMINAL_HANDLE=term_mac C=d", " ")).toBe("term_mac");
    expect(primaryCodexSession('{"type":"event_msg","payload":{"id":"'+sessionId+'","source":"cli"}}')).toBeNull();
    expect(primaryCodexSession("broken")).toBeNull();
  });
  it("parses macOS lsof records without confusing process boundaries", () => {
    expect(parseLsofProcesses("p12\nn/a.jsonl\nf3\nn/b.jsonl\np34\nn/c.jsonl\n")).toEqual([
      { pid: "12", files: ["/a.jsonl", "/b.jsonl"] }, { pid: "34", files: ["/c.jsonl"] },
    ]);
  });
});
