import type {
  AgentPromptProgressEvent,
  CodexPromptApprovalDecision,
  CodexPromptApprovalRequest,
  CodexPromptUserInputRequest,
  CodexPromptUserInputResponse,
  CodexTurnControlResult,
} from "./controlApiClient.js";
import {
  createDirectWorkerStore,
  type DirectWorkerJobEvent,
  type DirectWorkerJobResult,
  type DirectWorkerJobType,
  type DirectWorkerStore,
} from "../../local-agent/src/directWorkerStore.js";

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;
const PROGRESS_BACKLOG_COMPACTION_THRESHOLD = 20;

function isTransientProgressEvent(event: AgentPromptProgressEvent): boolean {
  return event.type === "operation-progress" || event.type === "codex-event";
}

function shouldDeliverProgressEvent(
  events: DirectWorkerJobEvent[],
  index: number,
  lastTransientProgressIndex: number,
): boolean {
  const workerEvent = events[index];

  if (
    events.length < PROGRESS_BACKLOG_COMPACTION_THRESHOLD ||
    workerEvent?.type !== "progress" ||
    !isTransientProgressEvent(workerEvent.event as AgentPromptProgressEvent)
  ) {
    return true;
  }

  // Operation/codex events only refresh the single mutable progress card. When
  // a disconnected gateway catches up, replaying thousands of those edits can
  // sit behind Discord rate limits and delay public agent messages by minutes.
  // Keep every public message/thought and deliver the newest transient state.
  return index === lastTransientProgressIndex;
}

function findLastTransientProgressIndex(events: DirectWorkerJobEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "progress" &&
      isTransientProgressEvent(event.event as AgentPromptProgressEvent)
    ) {
      return index;
    }
  }

  return -1;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SubmitDirectWorkerJobInput<
  TProgress extends AgentPromptProgressEvent = AgentPromptProgressEvent,
> {
  jobId?: string;
  type: DirectWorkerJobType;
  queueKey: string;
  payload: unknown;
  onProgress?: (event: TProgress) => Promise<void> | void;
  onApprovalRequest?: (
    request: CodexPromptApprovalRequest,
  ) => Promise<CodexPromptApprovalDecision> | CodexPromptApprovalDecision;
  onUserInputRequest?: (
    request: CodexPromptUserInputRequest,
  ) => Promise<CodexPromptUserInputResponse> | CodexPromptUserInputResponse;
}

export function createDirectWorkerClient(options: {
  store?: DirectWorkerStore;
  pollIntervalMs?: number;
} = {}) {
  const store = options.store ?? createDirectWorkerStore();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  async function submit<TProgress extends AgentPromptProgressEvent = AgentPromptProgressEvent>(
    input: SubmitDirectWorkerJobInput<TProgress>,
  ): Promise<DirectWorkerJobResult> {
    const request = await store.enqueue({
      jobId: input.jobId,
      type: input.type,
      queueKey: input.queueKey,
      payload: input.payload,
    });
    let deliveredEventCount = await store.readDeliveryCursor(request.jobId);

    for (;;) {
      const events = await store.readEvents(request.jobId);
      const unseenEvents = events.slice(deliveredEventCount);
      const lastTransientProgressIndex = findLastTransientProgressIndex(unseenEvents);
      let deliveryFailed = false;
      let cursorDirty = false;

      const persistDeliveryCursor = async () => {
        if (!cursorDirty) {
          return;
        }

        await store.writeDeliveryCursor(request.jobId, deliveredEventCount);
        cursorDirty = false;
      };

      for (const [eventIndex, workerEvent] of unseenEvents.entries()) {
        try {
          if (workerEvent.type === "progress") {
            if (!shouldDeliverProgressEvent(unseenEvents, eventIndex, lastTransientProgressIndex)) {
              deliveredEventCount += 1;
              cursorDirty = true;
              continue;
            }

            // Make a compacted transient run durable before the next public
            // callback. If that callback fails, it remains the first retry.
            await persistDeliveryCursor();
            await input.onProgress?.(workerEvent.event as TProgress);
          } else if (workerEvent.type === "approval" && !await store.readApprovalDecision(request.jobId, workerEvent.approvalId)) {
            await persistDeliveryCursor();
            const decision = input.onApprovalRequest
              ? await Promise.resolve(input.onApprovalRequest(workerEvent.request)).catch(() => ({
                  decision: "decline" as const,
                }))
              : { decision: "decline" as const };
            await store.writeApprovalDecision(request.jobId, workerEvent.approvalId, decision);
          } else if (workerEvent.type === "user-input" && !await store.readUserInputResponse(request.jobId, workerEvent.userInputId)) {
            await persistDeliveryCursor();
            const response = input.onUserInputRequest
              ? await Promise.resolve(input.onUserInputRequest(workerEvent.request))
              : { answers: {} };
            await store.writeUserInputResponse(request.jobId, workerEvent.userInputId, response);
          }

          deliveredEventCount += 1;
          cursorDirty = true;
          await persistDeliveryCursor();
        } catch (error) {
          deliveryFailed = true;
          console.warn(`direct-worker event delivery failed for ${request.jobId}; retrying`, error);
          break;
        }
      }

      await persistDeliveryCursor();

      if (deliveryFailed) {
        await wait(Math.max(1_000, pollIntervalMs));
        continue;
      }

      const result = await store.readResult(request.jobId);
      if (result) {
        return result;
      }

      await wait(pollIntervalMs);
    }
  }

  async function control(input: {
    controlKey: string;
    action: "steer" | "interrupt";
    content?: string;
  }): Promise<CodexTurnControlResult> {
    const request = await store.enqueueControl(input);
    const startedAt = Date.now();

    for (;;) {
      const result = await store.readControlResult(request.controlId);
      if (result) {
        await store.removeControl(request.controlId);
        return result.result as CodexTurnControlResult;
      }

      if (Date.now() - startedAt >= DEFAULT_CONTROL_TIMEOUT_MS) {
        await store.removeControl(request.controlId);
        return {
          status: "failed",
          message: "Direct worker did not acknowledge the turn control request in time. " +
            "The worker may be restarting or draining; check the worker service logs.",
        };
      }

      await wait(pollIntervalMs);
    }
  }

  return {
    store,
    submit,
    control,
    async markDelivered(jobId: string): Promise<void> {
      await store.markDelivered(jobId);
    },
    async readPendingClaudeSessionNotifications() {
      return store.readPendingClaudeSessionNotifications();
    },
    async ackClaudeSessionNotifications(controlKey: string, deliveredCount: number): Promise<void> {
      await store.ackClaudeSessionNotifications(controlKey, deliveredCount);
    },
    async executionState(): Promise<{ activeCount: number; pendingCount: number }> {
      let activeCount = 0;
      let pendingCount = 0;

      for (const request of await store.listRequests()) {
        if (await store.isDelivered(request.jobId)) {
          continue;
        }

        const state = await store.readState(request.jobId);
        if (state?.status === "running") {
          activeCount += 1;
        } else if (state?.status === "queued") {
          pendingCount += 1;
        }
      }

      return { activeCount, pendingCount };
    },
  };
}

export type DirectWorkerClient = ReturnType<typeof createDirectWorkerClient>;
