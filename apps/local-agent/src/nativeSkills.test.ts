import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_GUIDANCE, PURE_AGENT_GUIDANCE } from "../../../packages/core/src/agentGuidance.js";
import { runCodexPrompt } from "./codexRunner.js";
import { disposeCodexPersistentAppServers, runCodexAppServerPrompt } from "./codexAppServerRunner.js";
import { disposeClaudePersistentSessions, runClaudePrompt } from "./claudeRunner.js";

// These CLI doubles verify the connector's process boundary, not a model's
// decision to invoke a skill. No real credentials or agent services are used.
const roots: string[] = [];
afterEach(async () => {
  await disposeCodexPersistentAppServers();
  await disposeClaudePersistentSessions("test-cleanup");
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-skills-"));
  roots.push(root);
  const home = path.join(root, "home");
  const alternateHome = path.join(root, "alternate-home");
  const codexHome = path.join(root, "custom-codex");
  const claudeConfig = path.join(root, "custom-claude");
  const repo = path.join(root, "repo");
  const cwd = path.join(repo, "nested");
  for (const [directory, marker] of [
    [path.join(home, ".agents/skills/native-user"), "native-user"],
    [path.join(alternateHome, ".agents/skills/native-user"), "alternate-user"],
    [path.join(home, ".codex/skills/native-config"), "default-codex"],
    [path.join(codexHome, "skills/native-config"), "custom-codex"],
    [path.join(home, ".claude/skills/native-config"), "default-claude"],
    [path.join(claudeConfig, "skills/native-config"), "custom-claude"],
    [path.join(repo, ".agents/skills/native-project"), "project-codex"],
    [path.join(repo, ".claude/skills/native-project"), "project-claude"],
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), marker);
  }
  await mkdir(cwd);
  const command = path.join(root, "fake-agent.cjs");
  const wsPath = createRequire(import.meta.url).resolve("ws");
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function report(cwd) {
  return JSON.stringify({
    pid: process.pid, home: process.env.HOME, codexHome: process.env.CODEX_HOME,
    claudeConfig: process.env.CLAUDE_CONFIG_DIR, cwd, args,
    userSkill: read(path.join(process.env.HOME, '.agents/skills/native-user/SKILL.md')),
    codexSkill: read(path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'skills/native-config/SKILL.md')),
    claudeSkill: read(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'skills/native-config/SKILL.md')),
    projectCodex: read(path.join(cwd, '../.agents/skills/native-project/SKILL.md')),
    projectClaude: read(path.join(cwd, '../.claude/skills/native-project/SKILL.md')),
  });
}
if (args[0] === 'app-server') {
  const server = require('node:http').createServer();
  const { WebSocketServer } = require(${JSON.stringify(wsPath)});
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'native-thread' } } }));
    }
    if (message.method === 'turn/start') {
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'native-turn' } } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'native-turn', item: { id: 'native-report', type: 'agentMessage', text: report(message.params.cwd) } } }));
      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } }));
    }
  }));
  const listen = args[args.indexOf('--listen') + 1];
  if (listen.startsWith('unix://')) server.listen(listen.slice(7));
  else { const url = new URL(listen); server.listen(Number(url.port), url.hostname); }
} else if (args[0] === 'exec') {
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], report(process.cwd()));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'native-thread' }));
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-session' }));
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'native-session', is_error: false, result: report(process.cwd()) })));
  input.on('close', () => process.exit(0));
}
`);
  await chmod(command, 0o755);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CODEX_DISCORD_CODEX_APP_SERVER_PERSISTENT", "true");
  vi.stubEnv("CODEX_DISCORD_CLAUDE_SETTINGS", undefined);
  return { root, home, alternateHome, codexHome, claudeConfig, repo, cwd, command };
}

function completed(result: { status: string; finalMessage: string; stderr: string }) {
  expect(result.status, result.stderr).toBe("completed");
  return JSON.parse(result.finalMessage);
}

describe("native installed skill access through connector runners", () => {
  it("preserves Codex exec HOME, inherited and explicit CODEX_HOME, cwd, and native skill files", async () => {
    const f = await fixture();
    const input = { workspaceRoot: f.repo, cwd: f.cwd, prompt: "use an applicable native skill", timeoutMs: 5000, codexCommand: f.command, guidance: DEFAULT_AGENT_GUIDANCE };
    const defaults = completed(await runCodexPrompt(input));
    expect(defaults).toMatchObject({ home: f.home, cwd: f.cwd, userSkill: "native-user", codexSkill: "default-codex", projectCodex: "project-codex" });
    vi.stubEnv("CODEX_HOME", f.codexHome);
    expect(completed(await runCodexPrompt(input)).codexSkill).toBe("custom-codex");
    const explicit = completed(await runCodexPrompt({ ...input, codexHome: path.join(f.home, ".codex"), guidance: PURE_AGENT_GUIDANCE }));
    expect(explicit).toMatchObject({ codexHome: path.join(f.home, ".codex"), codexSkill: "default-codex", userSkill: "native-user", projectCodex: "project-codex" });
    expect(explicit.args.join(" ")).not.toMatch(/skills\s*=\s*false/);
  });

  it("keeps managed Codex app-server native homes separate while preserving project cwd", async () => {
    const f = await fixture();
    const input = { workspaceRoot: f.repo, cwd: f.cwd, prompt: "native skills", timeoutMs: 5000, codexCommand: f.command };
    const first = completed(await runCodexAppServerPrompt(input));
    const reused = completed(await runCodexAppServerPrompt(input));
    expect(reused.pid).toBe(first.pid);
    expect(first).toMatchObject({ home: f.home, cwd: f.cwd, userSkill: "native-user", codexSkill: "default-codex", projectCodex: "project-codex" });
    vi.stubEnv("CODEX_HOME", f.codexHome);
    const custom = completed(await runCodexAppServerPrompt(input));
    expect(custom.pid).not.toBe(first.pid);
    expect(custom.codexSkill).toBe("custom-codex");
    vi.stubEnv("HOME", f.alternateHome);
    const otherUser = completed(await runCodexAppServerPrompt(input));
    expect(otherUser.pid).not.toBe(custom.pid);
    expect(otherUser).toMatchObject({ userSkill: "alternate-user", codexSkill: "custom-codex" });
    const explicit = completed(await runCodexAppServerPrompt({ ...input, codexHome: path.join(f.home, ".codex") }));
    expect(explicit).toMatchObject({ codexSkill: "default-codex", userSkill: "alternate-user" });
  }, 20_000);

  it.each([false, true])("preserves Claude native skills and settings when persistentSession=%s", async (persistentSession) => {
    const f = await fixture();
    const input = { workspaceRoot: f.repo, cwd: f.cwd, prompt: "native skills", timeoutMs: 5000, claudeCommand: f.command, persistentSession, controlKey: "native-claude", guidance: DEFAULT_AGENT_GUIDANCE, settings: '{"env":{"NATIVE_TEST":"yes"}}' };
    const first = completed(await runClaudePrompt(input));
    expect(first).toMatchObject({ home: f.home, cwd: f.cwd, claudeSkill: "default-claude", projectClaude: "project-claude" });
    expect(first.args).not.toContain("--disable-slash-commands");
    expect(first.args).not.toContain("--setting-sources");
    expect(JSON.parse(first.args[first.args.indexOf("--settings") + 1])).toMatchObject({ env: { NATIVE_TEST: "yes" }, outputStyle: "cdc-guidance:attention-kind" });
    vi.stubEnv("CLAUDE_CONFIG_DIR", f.claudeConfig);
    const custom = completed(await runClaudePrompt(input));
    expect(custom).toMatchObject({ claudeConfig: f.claudeConfig, claudeSkill: "custom-claude", projectClaude: "project-claude" });
    expect(custom.pid).not.toBe(first.pid);
    vi.stubEnv("HOME", f.alternateHome);
    const otherUser = completed(await runClaudePrompt(input));
    expect(otherUser.pid).not.toBe(custom.pid);
    expect(otherUser).toMatchObject({ home: f.alternateHome, claudeSkill: "custom-claude" });
    const pure = completed(await runClaudePrompt({ ...input, guidance: PURE_AGENT_GUIDANCE }));
    expect(pure).toMatchObject({ claudeSkill: "custom-claude", projectClaude: "project-claude" });
    expect(pure.args).not.toContain("--plugin-dir");
    expect(pure.args).not.toContain("--disable-slash-commands");
  }, 20_000);
});
