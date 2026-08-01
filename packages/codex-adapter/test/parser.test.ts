import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeSqliteScript } from "../src/sqlite.js";
import { discoverCodexSessions, parseSessionIndexLine, parseSessionMetaLine } from "../src/parser.js";

const fixturesRoot = path.resolve("packages/codex-adapter/test/fixtures");

async function writeSessionIndex(codexHome: string, sessions: Array<{ id: string; name: string; updatedAt: string }>) {
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    sessions
      .map((session) =>
        JSON.stringify({
          id: session.id,
          thread_name: session.name,
          updated_at: session.updatedAt,
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
}

async function createCodexStateDatabase(codexHome: string, sql: string) {
  await executeSqliteScript(path.join(codexHome, "state_5.sqlite"), sql);
}

async function createCodexGoalsDatabase(codexHome: string, sql: string) {
  await executeSqliteScript(path.join(codexHome, "goals_1.sqlite"), sql);
}

describe("codex parser", () => {
  it("parses session index entries", () => {
    expect(
      parseSessionIndexLine(
        '{"id":"019db2be-b2b3-7e82-9e61-8c84b28ad287","thread_name":"Codex Discord planning","updated_at":"2026-04-22T01:15:24.714Z"}',
      ),
    ).toEqual({
      id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
      threadName: "Codex Discord planning",
      updatedAt: "2026-04-22T01:15:24.714Z",
    });
  });

  it("parses session meta cwd", () => {
    const line =
      '{"timestamp":"2026-04-22T01:15:24.714Z","type":"session_meta","payload":{"id":"019db2be-b2b3-7e82-9e61-8c84b28ad287","cwd":"/Users/me/project"}}';

    expect(parseSessionMetaLine(line)).toEqual({
      id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
      cwd: "/Users/me/project",
    });
  });

  it("discovers sessions with workspace hints", async () => {
    const sessions = await discoverCodexSessions(fixturesRoot);

    expect(sessions[0]).toMatchObject({
      id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
      threadName: "Codex Discord planning",
      cwdHint: "/Users/dgsw36/Desktop/01_프로젝트-개발/앱-도구/CodexDiscordConnector",
    });
  });

  it("returns an empty list when session index is missing", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("returns index entries with null cwd hints when sessions are missing", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      '{"id":"019db2be-b2b3-7e82-9e61-8c84b28ad287","thread_name":"Codex Discord planning","updated_at":"2026-04-22T01:15:24.714Z"}\n',
      "utf8",
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      {
        id: "019db2be-b2b3-7e82-9e61-8c84b28ad287",
        threadName: "Codex Discord planning",
        updatedAt: "2026-04-22T01:15:24.714Z",
        cwdHint: null,
      },
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("includes persisted Codex goal status for session completion classification", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    try {
      await writeSessionIndex(codexHome, [
        { id: sessionId, name: "Long goal", updatedAt: "2026-04-22T01:15:24.714Z" },
      ]);
      await createCodexGoalsDatabase(
        codexHome,
        [
          "create table thread_goals (thread_id text primary key, status text not null);",
          `insert into thread_goals values ('${sessionId}', 'usage_limited');`,
        ].join("\n"),
      );

      await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
        {
          id: sessionId,
          threadName: "Long goal",
          updatedAt: "2026-04-22T01:15:24.714Z",
          cwdHint: null,
          goalStatus: "usageLimited",
        },
      ]);
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("skips malformed index lines and keeps valid sessions", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const goodSessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"missing-thread-name","updated_at":"2026-04-22T01:15:24.714Z"}\n{"id":"${goodSessionId}","thread_name":"Codex Discord planning","updated_at":"2026-04-22T01:15:24.714Z"}\n`,
      "utf8",
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      {
        id: goodSessionId,
        threadName: "Codex Discord planning",
        updatedAt: "2026-04-22T01:15:24.714Z",
        cwdHint: null,
      },
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("ignores malformed transcript lines before a valid session meta line", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"${sessionId}","thread_name":"Codex Discord planning","updated_at":"2026-04-22T01:15:24.714Z"}\n`,
      "utf8",
    );

    await fs.mkdir(path.join(codexHome, "sessions", "2026", "04", "22"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "sessions", "2026", "04", "22", `rollout-${sessionId}.jsonl`),
      `not-json\n{"timestamp":"2026-04-22T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}\n`,
      "utf8",
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      {
        id: sessionId,
        threadName: "Codex Discord planning",
        updatedAt: "2026-04-22T01:15:24.714Z",
        cwdHint: "/Users/me/project",
      },
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("extracts a compact user and assistant context preview from session transcripts", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"${sessionId}","thread_name":"Context sync session","updated_at":"2026-04-22T01:15:24.714Z"}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(codexHome, "sessions", "2026", "04", "22"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "sessions", "2026", "04", "22", `rollout-${sessionId}.jsonl`),
      [
        `{"timestamp":"2026-04-22T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}`,
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\ninternal" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# In app browser (IAB):\n- Current URL: http://localhost\n\n## My request for Codex:\n이전 작업 요약해줘",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "작업 중입니다." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "최종 요약입니다." }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(discoverCodexSessions(codexHome, { includeContextPreview: true })).resolves.toEqual([
      expect.objectContaining({
        id: sessionId,
        cwdHint: "/Users/me/project",
        contextPreview: [
          { role: "user", text: "이전 작업 요약해줘" },
          { role: "assistant", text: "최종 요약입니다." },
        ],
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("extracts recent realtime session events for desktop-to-discord mirroring", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"${sessionId}","thread_name":"Realtime sync session","updated_at":"2026-04-24T01:15:24.714Z"}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(codexHome, "sessions", "2026", "04", "24"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "sessions", "2026", "04", "24", `rollout-${sessionId}.jsonl`),
      [
        `{"timestamp":"2026-04-24T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}`,
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_started",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "먼저 작업 시작해줘" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "rg --files" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "파일을 살펴보는 중입니다." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "작업을 마쳤습니다." }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(
      discoverCodexSessions(codexHome, {
        includeRealtimeEvents: true,
        realtimeEventLimit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: sessionId,
        realtimeEvents: [
          expect.objectContaining({ kind: "status", text: "작업 시작" }),
          expect.objectContaining({ kind: "user", text: "먼저 작업 시작해줘" }),
          expect.objectContaining({ kind: "status", text: expect.stringContaining("파일 탐색 중") }),
          expect.objectContaining({
            kind: "assistant",
            phase: "commentary",
            text: "파일을 살펴보는 중입니다.",
          }),
          expect.objectContaining({
            kind: "assistant",
            phase: "final_answer",
            text: "작업을 마쳤습니다.",
          }),
        ],
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("keeps cached session details current when a transcript file grows", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019dbcc5-5d37-7662-9b8e-d9f1eb824fc2";
    const sessionFile = path.join(codexHome, "sessions", "2026", "04", "24", `rollout-${sessionId}.jsonl`);

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"${sessionId}","thread_name":"Incremental session","updated_at":"2026-04-24T01:15:24.714Z"}\n`,
      "utf8",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        `{"timestamp":"2026-04-24T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}`,
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(
      discoverCodexSessions(codexHome, {
        activeOnly: false,
        includeExecSessions: true,
        includeRealtimeEvents: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        cwdHint: "/Users/me/project",
        realtimeEvents: [expect.objectContaining({ text: "작업 시작" })],
      }),
    ]);

    await fs.appendFile(
      sessionFile,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete" },
      }) + "\n",
      "utf8",
    );

    await expect(
      discoverCodexSessions(codexHome, {
        activeOnly: false,
        includeExecSessions: true,
        includeRealtimeEvents: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        cwdHint: "/Users/me/project",
        realtimeEvents: [
          expect.objectContaining({ text: "작업 시작" }),
          expect.objectContaining({ text: "작업 완료" }),
        ],
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("reads large session transcripts from the head and tail for recent events", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019dbcc5-5d37-7662-9b8e-d9f1eb824fc2";
    const sessionFile = path.join(codexHome, "sessions", "2026", "04", "24", `rollout-${sessionId}.jsonl`);

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"${sessionId}","thread_name":"Large session","updated_at":"2026-04-24T01:15:24.714Z"}\n`,
      "utf8",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        `{"timestamp":"2026-04-24T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}`,
        "x".repeat(2_200_000),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(
      discoverCodexSessions(codexHome, {
        activeOnly: false,
        includeExecSessions: true,
        includeRealtimeEvents: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        cwdHint: "/Users/me/project",
        realtimeEvents: [expect.objectContaining({ text: "작업 완료" })],
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("can discover an explicitly linked session even when it is absent from the session index", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019dbcc5-5d37-7662-9b8e-d9f1eb824fc2";

    await fs.mkdir(path.join(codexHome, "sessions", "2026", "04", "24"), { recursive: true });
    await fs.writeFile(path.join(codexHome, "session_index.jsonl"), "", "utf8");
    await fs.writeFile(
      path.join(codexHome, "sessions", "2026", "04", "24", `rollout-${sessionId}.jsonl`),
      [
        `{"timestamp":"2026-04-24T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}`,
        JSON.stringify({
          timestamp: "2026-04-24T01:15:25.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Discord에서 시작한 질문" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await expect(
      discoverCodexSessions(codexHome, {
        activeOnly: false,
        includeExecSessions: true,
        includeSessionIds: [sessionId],
        includeRealtimeEvents: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: sessionId,
        threadName: "Discord에서 시작한 질문",
        updatedAt: "2026-04-24T01:15:25.000Z",
        cwdHint: "/Users/me/project",
        realtimeEvents: [expect.objectContaining({ kind: "user", text: "Discord에서 시작한 질문" })],
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("does not rely on the full path when matching session files", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const sessionId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    await fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `{"id":"${sessionId}","thread_name":"Codex Discord planning","updated_at":"2026-04-22T01:15:24.714Z"}\n`,
      "utf8",
    );

    const decoyDir = path.join(codexHome, "sessions", "2026", "04", "22", sessionId);
    await fs.mkdir(decoyDir, { recursive: true });
    await fs.writeFile(path.join(decoyDir, "rollout-other.jsonl"), "{}", "utf8");

    await fs.mkdir(path.join(codexHome, "sessions", "2026", "04", "22"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "sessions", "2026", "04", "22", `rollout-${sessionId}.jsonl`),
      `{"timestamp":"2026-04-22T01:15:24.714Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/Users/me/project"}}\n`,
      "utf8",
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      {
        id: sessionId,
        threadName: "Codex Discord planning",
        updatedAt: "2026-04-22T01:15:24.714Z",
        cwdHint: "/Users/me/project",
      },
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("discovers only active human Codex sessions when thread state is available", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const activeId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";
    const archivedId = "019db2be-b2b3-7e82-9e61-8c84b28ad288";
    const subAgentId = "019db2be-b2b3-7e82-9e61-8c84b28ad289";
    const execId = "019db2be-b2b3-7e82-9e61-8c84b28ad28a";
    const cliId = "019db2be-b2b3-7e82-9e61-8c84b28ad28b";

    await writeSessionIndex(codexHome, [
      { id: activeId, name: "Active app session", updatedAt: "2026-04-23T10:00:00.000Z" },
      { id: archivedId, name: "Archived app session", updatedAt: "2026-04-23T09:00:00.000Z" },
      { id: subAgentId, name: "Explorer subagent", updatedAt: "2026-04-23T08:00:00.000Z" },
      { id: execId, name: "One-off exec session", updatedAt: "2026-04-23T07:00:00.000Z" },
      { id: cliId, name: "One-off cli session", updatedAt: "2026-04-23T06:00:00.000Z" },
    ]);
    await createCodexStateDatabase(
      codexHome,
      `
      create table threads (id text primary key, archived integer not null, source text not null);
      create table thread_spawn_edges (parent_thread_id text not null, child_thread_id text primary key, status text not null);
      insert into threads values ('${activeId}', 0, 'vscode');
      insert into threads values ('${archivedId}', 1, 'vscode');
      insert into threads values ('${subAgentId}', 0, 'vscode');
      insert into threads values ('${execId}', 0, 'exec');
      insert into threads values ('${cliId}', 0, 'cli');
      insert into thread_spawn_edges values ('${activeId}', '${subAgentId}', 'closed');
      `,
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      expect.objectContaining({
        id: activeId,
        threadName: "Active app session",
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("activeOnly excludes sessions that cannot be verified in Codex thread state", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const unknownId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";

    await writeSessionIndex(codexHome, [
      { id: unknownId, name: "Unknown indexed session", updatedAt: "2026-04-23T10:00:00.000Z" },
    ]);

    await expect(discoverCodexSessions(codexHome, { activeOnly: true })).resolves.toEqual([]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("excludes sessions that have already been moved into Codex archived_sessions", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const activeId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";
    const archivedId = "019db2be-b2b3-7e82-9e61-8c84b28ad288";

    await writeSessionIndex(codexHome, [
      { id: activeId, name: "Active app session", updatedAt: "2026-04-23T10:00:00.000Z" },
      { id: archivedId, name: "Archived file session", updatedAt: "2026-04-23T09:00:00.000Z" },
    ]);
    await fs.mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "archived_sessions", `rollout-2026-04-23T09-00-00-${archivedId}.jsonl`),
      "{}\n",
      "utf8",
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      expect.objectContaining({
        id: activeId,
        threadName: "Active app session",
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it("excludes index entries that are no longer present in Codex thread state", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
    const activeId = "019db2be-b2b3-7e82-9e61-8c84b28ad287";
    const expiredId = "019db2be-b2b3-7e82-9e61-8c84b28ad288";

    await writeSessionIndex(codexHome, [
      { id: activeId, name: "Active app session", updatedAt: "2026-04-23T10:00:00.000Z" },
      { id: expiredId, name: "Expired index session", updatedAt: "2026-04-23T09:00:00.000Z" },
    ]);
    await createCodexStateDatabase(
      codexHome,
      `
      create table threads (id text primary key, archived integer not null, source text not null);
      create table thread_spawn_edges (parent_thread_id text not null, child_thread_id text primary key, status text not null);
      insert into threads values ('${activeId}', 0, 'vscode');
      `,
    );

    await expect(discoverCodexSessions(codexHome)).resolves.toEqual([
      expect.objectContaining({
        id: activeId,
        threadName: "Active app session",
      }),
    ]);

    await fs.rm(codexHome, { recursive: true, force: true });
  });
});
