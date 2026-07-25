import { z } from "zod";

const identifierSchema = z.string().trim().regex(/^[a-zA-Z0-9._:-]{1,160}$/);
const nullableStringSchema = z.string().nullable().optional();
const timeoutSchema = z.number().int().nonnegative();

export const runWorkspaceCommandInputSchema = z.object({
  workspaceRoot: z.string(),
  cwd: z.string(),
  command: z.string(),
  timeoutMs: timeoutSchema,
  confirmedDangerous: z.boolean(),
}).passthrough();

export const runCodexPromptInputSchema = z.object({
  workspaceRoot: z.string(),
  cwd: z.string(),
  prompt: z.string(),
  timeoutMs: timeoutSchema,
  sessionId: nullableStringSchema,
  forkSession: z.boolean().optional(),
  sessionName: nullableStringSchema,
  codexHome: z.string().optional(),
  codexCommand: z.string().optional(),
  mode: z.enum(["prompt", "review"]).optional(),
  model: nullableStringSchema,
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
  controlKey: z.string().optional(),
}).passthrough();

export const runClaudePromptInputSchema = z.object({
  workspaceRoot: z.string(),
  cwd: z.string(),
  prompt: z.string(),
  timeoutMs: timeoutSchema,
  controlKey: z.string().optional(),
  sessionId: nullableStringSchema,
  forkSession: z.boolean().optional(),
  sessionName: nullableStringSchema,
  claudeCommand: nullableStringSchema,
  permissionMode: nullableStringSchema,
  model: nullableStringSchema,
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  settings: nullableStringSchema,
  persistentSession: z.boolean().nullable().optional(),
}).passthrough();

const directWorkerRequestBase = {
  version: z.literal(1),
  jobId: identifierSchema,
  queueKey: z.string().trim().min(1),
  createdAt: z.string().min(1),
};

export const directWorkerJobRequestSchema = z.discriminatedUnion("type", [
  z.object({
    ...directWorkerRequestBase,
    type: z.literal("run-command"),
    payload: runWorkspaceCommandInputSchema,
  }).passthrough(),
  z.object({
    ...directWorkerRequestBase,
    type: z.literal("run-codex-prompt"),
    payload: z.object({
      runner: z.enum(["app-server", "exec"]).optional(),
      input: runCodexPromptInputSchema,
    }).passthrough(),
  }).passthrough(),
  z.object({
    ...directWorkerRequestBase,
    type: z.literal("run-claude-prompt"),
    payload: runClaudePromptInputSchema,
  }).passthrough(),
]);

export const directWorkerControlRequestSchema = z.object({
  version: z.literal(1),
  controlId: identifierSchema,
  controlKey: z.string().min(1),
  action: z.enum(["steer", "interrupt"]),
  content: z.string().optional(),
  createdAt: z.string().min(1),
}).passthrough();

export type DirectWorkerJobRequest = z.infer<typeof directWorkerJobRequestSchema>;
export type DirectWorkerJobType = DirectWorkerJobRequest["type"];
export type DirectWorkerControlRequest = z.infer<typeof directWorkerControlRequestSchema>;
