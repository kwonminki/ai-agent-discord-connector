export type AgentKind = "codex" | "claude";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface AgentSettings {
  model: string | null;
  effort: AgentEffort;
}

export interface AgentDefaultSettings {
  codex: AgentSettings;
  claude: AgentSettings;
}

export interface AgentSettingsOverride {
  model: string | null;
  effort: AgentEffort | null;
}

export const DEFAULT_AGENT_SETTINGS: AgentDefaultSettings = {
  codex: { model: null, effort: "xhigh" },
  claude: { model: null, effort: "max" },
};

export function isAgentEffort(value: unknown): value is AgentEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra";
}

export function normalizeAgentEffort(agent: "claude", value: unknown): Exclude<AgentEffort, "ultra">;
export function normalizeAgentEffort(agent: AgentKind, value: unknown): AgentEffort;
export function normalizeAgentEffort(agent: AgentKind, value: unknown): AgentEffort {
  if (!isAgentEffort(value)) {
    return DEFAULT_AGENT_SETTINGS[agent].effort;
  }

  if (agent === "claude" && value === "ultra") return "max";
  return agent === "codex" && value === "max" ? "xhigh" : value;
}

function normalizeModel(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeAgentDefaultSettings(value: unknown): AgentDefaultSettings {
  const defaults = value && typeof value === "object"
    ? value as Partial<Record<AgentKind, Partial<AgentSettings>>>
    : {};

  return {
    codex: {
      model: normalizeModel(defaults.codex?.model),
      effort: normalizeAgentEffort("codex", defaults.codex?.effort),
    },
    claude: {
      model: normalizeModel(defaults.claude?.model),
      effort: normalizeAgentEffort("claude", defaults.claude?.effort),
    },
  };
}

export function normalizeAgentSettingsOverride(
  agent: AgentKind,
  value: { model?: unknown; effort?: unknown },
): AgentSettingsOverride {
  return {
    model: normalizeModel(value.model),
    effort: value.effort === null || value.effort === undefined
      ? null
      : normalizeAgentEffort(agent, value.effort),
  };
}

export function effectiveAgentSettings(input: {
  agent: AgentKind;
  defaults?: AgentDefaultSettings | null;
  override?: Partial<AgentSettingsOverride> | null;
}): {
  model: string | null;
  effort: AgentEffort;
  modelSource: "thread override" | "main default" | "CLI default";
  effortSource: "thread override" | "main default";
} {
  const defaults = normalizeAgentDefaultSettings(input.defaults);
  const settings = defaults[input.agent];
  const overrideModel = normalizeModel(input.override?.model);
  const overrideEffort = input.override?.effort === null || input.override?.effort === undefined
    ? null
    : normalizeAgentEffort(input.agent, input.override.effort);

  return {
    model: overrideModel ?? settings.model,
    effort: overrideEffort ?? settings.effort,
    modelSource: overrideModel ? "thread override" : settings.model ? "main default" : "CLI default",
    effortSource: overrideEffort ? "thread override" : "main default",
  };
}
