import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SQLITE_SEPARATOR = "\u001f";

type NodeSqliteModule = typeof import("node:sqlite");

async function loadNodeSqlite(): Promise<NodeSqliteModule | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

export async function executeSqliteScript(databasePath: string, sql: string): Promise<void> {
  const sqlite = await loadNodeSqlite();
  if (sqlite) {
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    return;
  }

  await execFileAsync("sqlite3", [databasePath, sql]);
}

export async function querySqliteText(databasePath: string, sql: string): Promise<string> {
  const sqlite = await loadNodeSqlite();
  if (!sqlite) {
    const { stdout } = await execFileAsync("sqlite3", [databasePath, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .flatMap((statement) => database.prepare(statement).all());
    return rows
      .map((row) => Object.values(row).map(String).join(SQLITE_SEPARATOR))
      .join("\n");
  } finally {
    database.close();
  }
}
