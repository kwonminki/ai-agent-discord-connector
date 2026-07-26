import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  disposeCodexPersistentAppServers,
  interruptActiveCodexAppServerTurn,
  runCodexAppServerPrompt,
  setCodexSessionIdleNotificationSink,
  steerActiveCodexAppServerTurn,
} from "./codexAppServerRunner.js";
import {
  disposeClaudePersistentSessions,
  interruptActiveClaudeTurn,
  runClaudePrompt,
  setClaudeSessionIdleNotificationSink,
  steerActiveClaudeTurn,
} from "./claudeRunner.js";
import {
  runCodexPrompt,
  type CodexApprovalDecision,
  type CodexUserInputResponse,
  type RunCodexPromptInput,
} from "./codexRunner.js";
import {
  createDirectWorkerStore,
  DIRECT_WORKER_WAKE_FILE,
  type DirectWorkerJobRequest,
  type DirectWorkerStore,
} from "./directWorkerStore.js";
import { runWorkspaceCommand } from "./runner.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_CONCURRENCY = 4;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function processIsAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApproval(
  store: DirectWorkerStore,
  jobId: string,
  approvalId: string,
  waitForWake: () => Promise<void>,
): Promise<CodexApprovalDecision> {
  for (;;) {
    const decision = await store.readApprovalDecision(jobId, approvalId);
    if (decision) {
      return decision;
    }
    await waitForWake();
  }
}

async function waitForUserInput(
  store: DirectWorkerStore,
  jobId: string,
  userInputId: string,
  waitForWake: () => Promise<void>,
): Promise<CodexUserInputResponse> {
  for (;;) {
    const response = await store.readUserInputResponse(jobId, userInputId);
    if (response) {
      return response;
    }
    await waitForWake();
  }
}

async function runWorkerJob(
  store: DirectWorkerStore,
  request: DirectWorkerJobRequest,
  waitForWake: () => Promise<void>,
  signal: AbortSignal,
): Promise<unknown> {
  if (request.type === "run-command") {
    return runWorkspaceCommand(request.payload);
  }

  if (request.type === "run-claude-prompt") {
    return runClaudePrompt({
      ...request.payload,
      controlKey: request.payload.controlKey ?? request.queueKey,
      onProgress: (event) => store.appendProgress(request.jobId, event),
      signal,
    });
  }

  const runnerInput: RunCodexPromptInput = {
    ...request.payload.input,
    onProgress: (event) => store.appendProgress(request.jobId, event),
    onApprovalRequest: async (approvalRequest) => {
      const approvalId = await store.requestApproval(request.jobId, approvalRequest);
      return waitForApproval(store, request.jobId, approvalId, waitForWake);
    },
    onUserInputRequest: async (userInputRequest) => {
      const userInputId = await store.requestUserInput(request.jobId, userInputRequest);
      return waitForUserInput(store, request.jobId, userInputId, waitForWake);
    },
  };

  return request.payload.runner === "app-server" && runnerInput.mode !== "review"
    ? runCodexAppServerPrompt(runnerInput)
    : runCodexPrompt(runnerInput);
}

async function acquireWorkerLock(rootPath: string): Promise<() => Promise<void>> {
  const lockPath = path.join(rootPath, "worker.lock");
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  await chmod(rootPath, 0o700);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(path.join(lockPath, "pid"), `${process.pid}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }

      const ownerPid = Number.parseInt(await readFile(path.join(lockPath, "pid"), "utf8").catch(() => ""), 10);
      if (processIsAlive(ownerPid)) {
        throw new Error(`Direct worker is already running with PID ${ownerPid}.`);
      }
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  throw new Error("Could not acquire the direct worker lock.");
}

export async function startDirectWorker(options: {
  store?: DirectWorkerStore;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  controlCodexTurn?: (input: {
    controlKey: string;
    action: "steer" | "interrupt";
    content?: string;
  }) => Promise<unknown>;
} = {}): Promise<{ stop(): Promise<void> }> {
  const store = options.store ?? createDirectWorkerStore();
  const releaseLock = await acquireWorkerLock(store.rootPath);
  const pollIntervalMs = options.pollIntervalMs ?? positiveInteger(
    process.env.CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const maxConcurrency = options.maxConcurrency ?? positiveInteger(
    process.env.CONNECT_DIRECT_WORKER_CONCURRENCY,
    DEFAULT_MAX_CONCURRENCY,
  );
  const activeJobs = new Map<string, Promise<void>>();
  const activeQueueKeys = new Set<string>();
  const activeExecutions = new Map<string, {
    request: DirectWorkerJobRequest;
    controller: AbortController;
  }>();
  let stopping = false;
  let ticking = false;
  let rerunRequested = false;
  let stopPromise: Promise<void> | null = null;
  let wakeWatcher: FSWatcher | null = null;
  const wakeWaiters = new Set<() => void>();
  const controlCodexTurn = options.controlCodexTurn ?? (async (control) =>
    control.action === "steer"
      ? steerActiveCodexAppServerTurn(control.controlKey, control.content ?? "")
      : interruptActiveCodexAppServerTurn(control.controlKey));

  await store.initialize();

  setClaudeSessionIdleNotificationSink((notification) => {
    store.appendClaudeSessionNotification({ ...notification, agent: "claude" }).catch((error) => {
      console.error("direct-worker failed to persist Claude idle notification", error);
    });
  });
  setCodexSessionIdleNotificationSink((notification) => {
    store.appendClaudeSessionNotification({ ...notification, agent: "codex" }).catch((error) => {
      console.error("direct-worker failed to persist Codex idle notification", error);
    });
  });

  function notifyWakeWaiters(): void {
    for (const wake of [...wakeWaiters]) {
      wake();
    }
  }

  function waitForWorkerWake(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        wakeWaiters.delete(finish);
        resolve();
      };

      timer = setTimeout(finish, pollIntervalMs);
      wakeWaiters.add(finish);
    });
  }

  async function recoverInterruptedJobs(): Promise<void> {
    for (const request of await store.listRequests()) {
      const state = await store.readState(request.jobId);
      if (state?.status === "running" && state.workerPid !== process.pid && !processIsAlive(state.workerPid)) {
        await store.fail(request.jobId, new Error("Direct worker restarted while this job was running."));
      }
    }
  }

  async function execute(request: DirectWorkerJobRequest): Promise<void> {
    const controller = new AbortController();
    activeQueueKeys.add(request.queueKey);
    activeExecutions.set(request.queueKey, { request, controller });
    await store.markRunning(request.jobId);

    try {
      await store.complete(
        request.jobId,
        await runWorkerJob(store, request, waitForWorkerWake, controller.signal),
      );
    } catch (error) {
      await store.fail(request.jobId, error);
    } finally {
      activeQueueKeys.delete(request.queueKey);
      if (activeExecutions.get(request.queueKey)?.request.jobId === request.jobId) {
        activeExecutions.delete(request.queueKey);
      }
      activeJobs.delete(request.jobId);
      if (!stopping) {
        requestTick();
      }
    }
  }

  async function processControls(): Promise<void> {
    for (const control of await store.listPendingControls()) {
      const activeExecution = activeExecutions.get(control.controlKey);
      if (control.action === "steer") {
        const claudeResult = await steerActiveClaudeTurn(control.controlKey, control.content ?? "");
        if (claudeResult.status !== "no-active-turn") {
          await store.completeControl(control.controlId, claudeResult);
          continue;
        }
      }
      if (control.action === "interrupt") {
        const claudeResult = interruptActiveClaudeTurn(control.controlKey);
        if (claudeResult.status !== "no-active-turn") {
          await store.completeControl(control.controlId, claudeResult);
          continue;
        }
      }
      if (
        control.action === "interrupt" &&
        activeExecution?.request.type === "run-claude-prompt"
      ) {
        activeExecution.controller.abort();
        await store.completeControl(control.controlId, {
          status: "accepted",
          message: "Claude Code interrupt requested.",
        });
        continue;
      }
      if (control.action === "interrupt" && !activeExecution) {
        let queued: DirectWorkerJobRequest | null = null;
        for (const request of await store.listRequests()) {
          if (
            request.queueKey === control.controlKey &&
            (await store.readState(request.jobId))?.status === "queued"
          ) {
            queued = request;
            break;
          }
        }
        if (queued) {
          await store.fail(queued.jobId, new Error("Agent turn was interrupted before execution."));
          await store.completeControl(control.controlId, {
            status: "accepted",
            message: "Queued agent turn was cancelled.",
          });
          continue;
        }
      }
      const result = await controlCodexTurn(control);
      await store.completeControl(control.controlId, result);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) {
      return;
    }

    ticking = true;
    try {
      await processControls();
      if (stopping) {
        return;
      }
      const requests = await store.listRequests();

      for (const request of requests) {
        if (stopping) {
          break;
        }
        if (activeJobs.size >= maxConcurrency) {
          break;
        }

        if (activeJobs.has(request.jobId) || activeQueueKeys.has(request.queueKey)) {
          continue;
        }

        const state = await store.readState(request.jobId);
        if (state?.status !== "queued") {
          continue;
        }

        const execution = execute(request);
        activeJobs.set(request.jobId, execution);
      }
    } finally {
      ticking = false;
      if (rerunRequested && !stopping) {
        rerunRequested = false;
        queueMicrotask(requestTick);
      }
    }
  }

  function requestTick(): void {
    if (ticking) {
      rerunRequested = true;
      return;
    }

    void tick().catch((error) => console.error("direct-worker poll failed", error));
  }

  await recoverInterruptedJobs();
  try {
    wakeWatcher = watch(store.rootPath, { persistent: false }, (_eventType, filename) => {
      if (filename?.toString() === DIRECT_WORKER_WAKE_FILE) {
        notifyWakeWaiters();
        requestTick();
      }
    });
    wakeWatcher.on("error", (error) => {
      console.warn("direct-worker wake watcher failed; periodic polling remains active", error);
      wakeWatcher?.close();
      wakeWatcher = null;
    });
  } catch (error) {
    console.warn("direct-worker wake watcher unavailable; periodic polling remains active", error);
  }
  await tick();
  const timer = setInterval(() => {
    requestTick();
  }, pollIntervalMs);

  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }
    stopping = true;
    clearInterval(timer);
    wakeWatcher?.close();
    wakeWatcher = null;
    stopPromise = (async () => {
      while (ticking) {
        await wait(Math.min(pollIntervalMs, 25));
      }
      while (activeJobs.size > 0) {
        await processControls();
        if (activeJobs.size === 0) {
          break;
        }
        await Promise.race([
          Promise.allSettled([...activeJobs.values()]),
          wait(Math.min(pollIntervalMs, 250)),
        ]);
      }
      while (ticking) {
        await wait(Math.min(pollIntervalMs, 25));
      }
      await processControls();
      await disposeClaudePersistentSessions("worker-stop");
      await disposeCodexPersistentAppServers();
      setClaudeSessionIdleNotificationSink(null);
      setCodexSessionIdleNotificationSink(null);
      await releaseLock();
    })();
    return stopPromise;
  }

  return { stop };
}

async function main(): Promise<void> {
  const worker = await startDirectWorker();
  console.info(`direct-worker ready with PID ${process.pid}`);
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(`direct-worker received ${signal}; draining active jobs before exit`);
    void worker.stop().finally(() => process.exit(0));
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

const isDirectExecution =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  await main();
}
