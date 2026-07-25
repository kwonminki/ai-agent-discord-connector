import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexRunnerProgressEvent,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from "./codexRunner.js";
import type { ClaudeRunnerProgressEvent } from "./claudeRunner.js";

export type DirectWorkerProgressEvent = CodexRunnerProgressEvent | ClaudeRunnerProgressEvent;
import {
  directWorkerControlRequestSchema,
  directWorkerJobRequestSchema,
  type DirectWorkerControlRequest,
  type DirectWorkerJobRequest,
  type DirectWorkerJobType,
} from "./directWorkerSchemas.js";

export type { DirectWorkerControlRequest, DirectWorkerJobRequest, DirectWorkerJobType };
export type DirectWorkerJobStatus = "queued" | "running" | "completed" | "failed";
export const DIRECT_WORKER_WAKE_FILE = "wake";

export interface DirectWorkerJobState {
  version: 1;
  jobId: string;
  status: DirectWorkerJobStatus;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  workerPid?: number | null;
}

export type DirectWorkerJobResult =
  | { jobId: string; result: unknown; completedAt: string }
  | { jobId: string; error: { message: string }; completedAt: string };

export type DirectWorkerJobEvent =
  | { type: "progress"; at: string; event: DirectWorkerProgressEvent }
  | { type: "approval"; at: string; approvalId: string; request: CodexApprovalRequest }
  | { type: "user-input"; at: string; userInputId: string; request: CodexUserInputRequest };

export interface DirectWorkerControlResult {
  controlId: string;
  result: unknown;
  completedAt: string;
}

export interface ClaudeSessionNotificationRecord {
  at: string;
  controlKey: string;
  sessionId: string | null;
  message: string;
  isError?: boolean;
}

export interface PendingClaudeSessionNotifications {
  controlKey: string;
  records: ClaudeSessionNotificationRecord[];
  totalCount: number;
}

interface CachedDirectWorkerEvents {
  mtimeMs: number;
  size: number;
  events: DirectWorkerJobEvent[];
  trailingText: string;
}

function validId(value: string): string {
  const normalized = value.trim();

  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(normalized)) {
    throw new Error("Direct worker identifier contains unsupported characters.");
  }

  return normalized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createJsonOnce(filePath: string, value: unknown): Promise<boolean> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await link(temporaryPath, filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function appendPrivateJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function parseDirectWorkerEventText(text: string): {
  events: DirectWorkerJobEvent[];
  trailingText: string;
} {
  const lastNewline = text.lastIndexOf("\n");
  const completeText = lastNewline >= 0 ? text.slice(0, lastNewline) : "";
  const trailingText = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
  const events = completeText
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as DirectWorkerJobEvent];
      } catch {
        return [];
      }
    });

  return { events, trailingText };
}

async function readTextSlice(filePath: string, position: number, length: number): Promise<string> {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function defaultDirectWorkerRoot(): string {
  return path.resolve(process.env.CONNECT_WORKER_ROOT ?? ".connect/worker");
}

function parseClaudeSessionNotificationText(text: string): ClaudeSessionNotificationRecord[] {
  const lastNewline = text.lastIndexOf("\n");
  const completeText = lastNewline >= 0 ? text.slice(0, lastNewline) : "";

  return completeText
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as ClaudeSessionNotificationRecord;
        return typeof parsed?.message === "string" && typeof parsed?.controlKey === "string"
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
}

export function createDirectWorkerStore(rootPath = defaultDirectWorkerRoot()) {
  const root = path.resolve(rootPath);
  const jobsRoot = path.join(root, "jobs");
  const controlsRoot = path.join(root, "controls");
  const deadLetterRoot = path.join(root, "dead-letter");
  const claudeNotificationsRoot = path.join(root, "claude-session-notifications");
  const eventCache = new Map<string, CachedDirectWorkerEvents>();

  function jobDirectory(jobId: string): string {
    return path.join(jobsRoot, validId(jobId));
  }

  function controlDirectory(controlId: string): string {
    return path.join(controlsRoot, validId(controlId));
  }

  async function signalWorker(): Promise<void> {
    const wakePath = path.join(root, DIRECT_WORKER_WAKE_FILE);
    await writeFile(wakePath, `${Date.now()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
      .then(() => chmod(wakePath, 0o600))
      .catch(() => undefined);
  }

  async function quarantineInvalidDirectory(input: {
    kind: "jobs" | "controls";
    entry: string;
    error: unknown;
  }): Promise<string | null> {
    const sourceRoot = input.kind === "jobs" ? jobsRoot : controlsRoot;
    const sourcePath = path.join(sourceRoot, input.entry);
    const destinationRoot = path.join(deadLetterRoot, input.kind);
    const destinationPath = path.join(
      destinationRoot,
      `${Date.now()}-${input.entry}-${randomUUID()}`,
    );

    await ensurePrivateDirectory(destinationRoot);
    try {
      await rename(sourcePath, destinationPath);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }

    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await writeJsonAtomic(path.join(destinationPath, "dead-letter.json"), {
      movedAt: new Date().toISOString(),
      source: `${input.kind}/${input.entry}`,
      error: message,
    });
    console.error(`Direct worker moved invalid ${input.kind} entry ${input.entry} to dead-letter: ${message}`);
    return destinationPath;
  }

  async function failQuarantinedJob(jobId: string, error: unknown): Promise<void> {
    const completedAt = new Date().toISOString();
    const message = `Invalid direct worker job request: ${error instanceof Error ? error.message : String(error)}`;
    await writeJsonAtomic(path.join(jobDirectory(jobId), "result.json"), {
      jobId,
      error: { message },
      completedAt,
    } satisfies DirectWorkerJobResult);
    await writeJsonAtomic(path.join(jobDirectory(jobId), "state.json"), {
      version: 1,
      jobId,
      status: "failed",
      updatedAt: completedAt,
      completedAt,
    } satisfies DirectWorkerJobState);
  }

  async function failQuarantinedControl(controlId: string, error: unknown): Promise<void> {
    const message = `Invalid direct worker control request: ${error instanceof Error ? error.message : String(error)}`;
    await writeJsonAtomic(path.join(controlDirectory(controlId), "result.json"), {
      controlId,
      result: { status: "failed", message },
      completedAt: new Date().toISOString(),
    } satisfies DirectWorkerControlResult);
  }

  return {
    rootPath: root,
    async initialize(): Promise<void> {
      await Promise.all([
        ensurePrivateDirectory(root),
        ensurePrivateDirectory(jobsRoot),
        ensurePrivateDirectory(controlsRoot),
        ensurePrivateDirectory(deadLetterRoot),
      ]);
    },
    async enqueue(input: {
      jobId?: string;
      type: DirectWorkerJobType;
      queueKey: string;
      payload: unknown;
    }): Promise<DirectWorkerJobRequest> {
      const jobId = validId(input.jobId ?? randomUUID());
      const request = directWorkerJobRequestSchema.parse({
        version: 1,
        jobId,
        type: input.type,
        queueKey: input.queueKey.trim() || jobId,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      });
      const directory = jobDirectory(jobId);
      const requestPath = path.join(directory, "request.json");
      const created = await createJsonOnce(requestPath, request);

      if (!created) {
        const existingValue = await readJson<unknown>(requestPath);
        const existing = directWorkerJobRequestSchema.parse(existingValue);
        if (!existing) {
          throw new Error(`Direct worker job request disappeared: ${jobId}`);
        }
        return existing;
      }

      await writeJsonAtomic(path.join(directory, "state.json"), {
        version: 1,
        jobId,
        status: "queued",
        updatedAt: request.createdAt,
      } satisfies DirectWorkerJobState);
      await signalWorker();
      return request;
    },
    async listRequests(): Promise<DirectWorkerJobRequest[]> {
      let entries: string[];
      try {
        entries = await readdir(jobsRoot);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }

      const requests = await Promise.all(entries.map(async (entry) => {
        try {
          const value = await readJson<unknown>(path.join(jobsRoot, entry, "request.json"));
          if (value === null) {
            return null;
          }
          const parsed = directWorkerJobRequestSchema.safeParse(value);
          if (parsed.success) {
            return parsed.data;
          }
          await quarantineInvalidDirectory({ kind: "jobs", entry, error: parsed.error });
          try {
            await failQuarantinedJob(validId(entry), parsed.error);
          } catch {
            // Invalid external directory names have no client that can receive a result.
          }
          return null;
        } catch (error) {
          await quarantineInvalidDirectory({ kind: "jobs", entry, error });
          try {
            await failQuarantinedJob(validId(entry), error);
          } catch {
            // Invalid external directory names have no client that can receive a result.
          }
          return null;
        }
      }));
      return requests
        .filter((request): request is DirectWorkerJobRequest => request !== null)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async readRequest(jobId: string) {
      const value = await readJson<unknown>(path.join(jobDirectory(jobId), "request.json"));
      return value === null ? null : directWorkerJobRequestSchema.parse(value);
    },
    readState(jobId: string) {
      return readJson<DirectWorkerJobState>(path.join(jobDirectory(jobId), "state.json"));
    },
    async markRunning(jobId: string): Promise<void> {
      const now = new Date().toISOString();
      await writeJsonAtomic(path.join(jobDirectory(jobId), "state.json"), {
        version: 1,
        jobId,
        status: "running",
        updatedAt: now,
        startedAt: now,
        workerPid: process.pid,
      } satisfies DirectWorkerJobState);
    },
    async complete(jobId: string, result: unknown): Promise<void> {
      const completedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(jobDirectory(jobId), "result.json"), {
        jobId,
        result,
        completedAt,
      } satisfies DirectWorkerJobResult);
      await writeJsonAtomic(path.join(jobDirectory(jobId), "state.json"), {
        version: 1,
        jobId,
        status: "completed",
        updatedAt: completedAt,
        completedAt,
        workerPid: process.pid,
      } satisfies DirectWorkerJobState);
    },
    async fail(jobId: string, error: unknown): Promise<void> {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error || "Direct worker job failed");
      await writeJsonAtomic(path.join(jobDirectory(jobId), "result.json"), {
        jobId,
        error: { message },
        completedAt,
      } satisfies DirectWorkerJobResult);
      await writeJsonAtomic(path.join(jobDirectory(jobId), "state.json"), {
        version: 1,
        jobId,
        status: "failed",
        updatedAt: completedAt,
        completedAt,
        workerPid: process.pid,
      } satisfies DirectWorkerJobState);
    },
    readResult(jobId: string) {
      return readJson<DirectWorkerJobResult>(path.join(jobDirectory(jobId), "result.json"));
    },
    async appendProgress(jobId: string, event: DirectWorkerProgressEvent): Promise<void> {
      const record: DirectWorkerJobEvent = { type: "progress", at: new Date().toISOString(), event };
      await appendPrivateJsonLine(path.join(jobDirectory(jobId), "events.jsonl"), record);
    },
    async requestApproval(jobId: string, request: CodexApprovalRequest): Promise<string> {
      const approvalId = randomUUID();
      const record: DirectWorkerJobEvent = {
        type: "approval",
        at: new Date().toISOString(),
        approvalId,
        request,
      };
      await appendPrivateJsonLine(path.join(jobDirectory(jobId), "events.jsonl"), record);
      return approvalId;
    },
    async requestUserInput(jobId: string, request: CodexUserInputRequest): Promise<string> {
      const userInputId = randomUUID();
      const record: DirectWorkerJobEvent = {
        type: "user-input",
        at: new Date().toISOString(),
        userInputId,
        request,
      };
      await appendPrivateJsonLine(path.join(jobDirectory(jobId), "events.jsonl"), record);
      return userInputId;
    },
    async readEvents(jobId: string): Promise<DirectWorkerJobEvent[]> {
      const normalizedJobId = validId(jobId);
      const filePath = path.join(jobDirectory(normalizedJobId), "events.jsonl");
      let fileStat: Awaited<ReturnType<typeof stat>>;

      try {
        fileStat = await stat(filePath);
      } catch (error) {
        if (isMissing(error)) {
          eventCache.delete(normalizedJobId);
          return [];
        }
        throw error;
      }

      const cached = eventCache.get(normalizedJobId);

      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        return cached.events;
      }

      if (cached && fileStat.size > cached.size) {
        const appendedText = await readTextSlice(filePath, cached.size, fileStat.size - cached.size);
        const parsed = parseDirectWorkerEventText(`${cached.trailingText}${appendedText}`);
        const nextCache: CachedDirectWorkerEvents = {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          events: [...cached.events, ...parsed.events],
          trailingText: parsed.trailingText,
        };
        eventCache.set(normalizedJobId, nextCache);
        return nextCache.events;
      }

      const parsed = parseDirectWorkerEventText(await readFile(filePath, "utf8"));
      const nextCache: CachedDirectWorkerEvents = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        events: parsed.events,
        trailingText: parsed.trailingText,
      };
      eventCache.set(normalizedJobId, nextCache);
      return nextCache.events;
    },
    async readDeliveryCursor(jobId: string): Promise<number> {
      const cursor = await readJson<{ eventCount?: unknown }>(
        path.join(jobDirectory(jobId), "delivery-cursor.json"),
      );
      return typeof cursor?.eventCount === "number" && cursor.eventCount >= 0
        ? Math.floor(cursor.eventCount)
        : 0;
    },
    writeDeliveryCursor(jobId: string, eventCount: number): Promise<void> {
      return writeJsonAtomic(path.join(jobDirectory(jobId), "delivery-cursor.json"), {
        eventCount: Math.max(0, Math.floor(eventCount)),
        updatedAt: new Date().toISOString(),
      });
    },
    async writeApprovalDecision(jobId: string, approvalId: string, decision: CodexApprovalDecision) {
      await writeJsonAtomic(
        path.join(jobDirectory(jobId), "approvals", `${validId(approvalId)}.json`),
        decision,
      );
      await signalWorker();
    },
    readApprovalDecision(jobId: string, approvalId: string) {
      return readJson<CodexApprovalDecision>(
        path.join(jobDirectory(jobId), "approvals", `${validId(approvalId)}.json`),
      );
    },
    async writeUserInputResponse(jobId: string, userInputId: string, response: CodexUserInputResponse) {
      await writeJsonAtomic(
        path.join(jobDirectory(jobId), "user-input", `${validId(userInputId)}.json`),
        response,
      );
      await signalWorker();
    },
    readUserInputResponse(jobId: string, userInputId: string) {
      return readJson<CodexUserInputResponse>(
        path.join(jobDirectory(jobId), "user-input", `${validId(userInputId)}.json`),
      );
    },
    async markDelivered(jobId: string): Promise<void> {
      await writeJsonAtomic(path.join(jobDirectory(jobId), "delivered.json"), {
        jobId,
        deliveredAt: new Date().toISOString(),
      });
      eventCache.delete(validId(jobId));
      await rm(jobDirectory(jobId), { recursive: true, force: true });
    },
    isDelivered(jobId: string) {
      return pathExists(path.join(jobDirectory(jobId), "delivered.json"));
    },
    async removeJob(jobId: string): Promise<void> {
      eventCache.delete(validId(jobId));
      await rm(jobDirectory(jobId), { recursive: true, force: true });
    },
    async enqueueControl(input: {
      controlKey: string;
      action: "steer" | "interrupt";
      content?: string;
    }): Promise<DirectWorkerControlRequest> {
      const controlId = randomUUID();
      const request = directWorkerControlRequestSchema.parse({
        version: 1,
        controlId,
        controlKey: input.controlKey,
        action: input.action,
        ...(input.content ? { content: input.content } : {}),
        createdAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path.join(controlDirectory(controlId), "request.json"), request);
      await signalWorker();
      return request;
    },
    async listPendingControls(): Promise<DirectWorkerControlRequest[]> {
      let entries: string[];
      try {
        entries = await readdir(controlsRoot);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }

      const controls = await Promise.all(entries.map(async (entry) => {
        try {
          if (await pathExists(path.join(controlsRoot, entry, "result.json"))) {
            return null;
          }
          const value = await readJson<unknown>(path.join(controlsRoot, entry, "request.json"));
          if (value === null) {
            return null;
          }
          const parsed = directWorkerControlRequestSchema.safeParse(value);
          if (parsed.success) {
            return parsed.data;
          }
          await quarantineInvalidDirectory({ kind: "controls", entry, error: parsed.error });
          try {
            await failQuarantinedControl(validId(entry), parsed.error);
          } catch {
            // Invalid external directory names have no client that can receive a result.
          }
          return null;
        } catch (error) {
          await quarantineInvalidDirectory({ kind: "controls", entry, error });
          try {
            await failQuarantinedControl(validId(entry), error);
          } catch {
            // Invalid external directory names have no client that can receive a result.
          }
          return null;
        }
      }));
      return controls
        .filter((control): control is DirectWorkerControlRequest => control !== null)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async completeControl(controlId: string, result: unknown): Promise<void> {
      await writeJsonAtomic(path.join(controlDirectory(controlId), "result.json"), {
        controlId,
        result,
        completedAt: new Date().toISOString(),
      } satisfies DirectWorkerControlResult);
    },
    readControlResult(controlId: string) {
      return readJson<DirectWorkerControlResult>(path.join(controlDirectory(controlId), "result.json"));
    },
    async removeControl(controlId: string): Promise<void> {
      await rm(controlDirectory(controlId), { recursive: true, force: true });
    },
    async appendClaudeSessionNotification(record: ClaudeSessionNotificationRecord): Promise<void> {
      const controlKey = validId(record.controlKey);
      await appendPrivateJsonLine(
        path.join(claudeNotificationsRoot, `${controlKey}.jsonl`),
        { ...record, controlKey },
      );
      await signalWorker();
    },
    async readPendingClaudeSessionNotifications(): Promise<PendingClaudeSessionNotifications[]> {
      let entries: string[];
      try {
        entries = await readdir(claudeNotificationsRoot);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }

      const pending = await Promise.all(entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map(async (entry) => {
          const controlKey = entry.slice(0, -".jsonl".length);

          try {
            validId(controlKey);
          } catch {
            return null;
          }

          const text = await readFile(path.join(claudeNotificationsRoot, entry), "utf8")
            .catch(() => "");
          const records = parseClaudeSessionNotificationText(text);
          const cursor = await readJson<{ deliveredCount?: unknown }>(
            path.join(claudeNotificationsRoot, `${controlKey}.cursor.json`),
          );
          const deliveredCount =
            typeof cursor?.deliveredCount === "number" && cursor.deliveredCount >= 0
              ? Math.floor(cursor.deliveredCount)
              : 0;

          return {
            controlKey,
            records: records.slice(deliveredCount),
            totalCount: records.length,
          } satisfies PendingClaudeSessionNotifications;
        }));

      return pending.filter(
        (entry): entry is PendingClaudeSessionNotifications =>
          entry !== null && entry.records.length > 0,
      );
    },
    async ackClaudeSessionNotifications(controlKey: string, deliveredCount: number): Promise<void> {
      await writeJsonAtomic(
        path.join(claudeNotificationsRoot, `${validId(controlKey)}.cursor.json`),
        {
          deliveredCount: Math.max(0, Math.floor(deliveredCount)),
          updatedAt: new Date().toISOString(),
        },
      );
    },
  };
}

export type DirectWorkerStore = ReturnType<typeof createDirectWorkerStore>;
