import { z } from "zod";

// Add catalog entries here and vendor their source under agent-assets/.
export const AGENT_STYLES = [
  {
    id: "attention-kind",
    label: "Attention-kind",
    description: "핵심부터 짧고 친절하게",
    file: "vendor/attention-span/skills/attention-kind/SKILL.md",
  },
  {
    id: "rundown",
    label: "Rundown",
    description: "요약과 진행 상태 중심",
    file: "vendor/attention-span/skills/rundown/SKILL.md",
  },
  {
    id: "spartan",
    label: "Spartan",
    description: "짧고 직설적으로",
    file: "vendor/attention-span/skills/spartan/SKILL.md",
  },
  {
    id: "tldr",
    label: "TL;DR",
    description: "최소한의 핵심 답변",
    file: "vendor/attention-span/skills/tldr/SKILL.md",
  },
] as const;

export const AGENT_SKILLS = [
  {
    id: "karpathy-guidelines",
    defaultEnabled: false,
    label: "Karpathy coding guidelines",
    file: "vendor/andrej-karpathy-skills/skills/karpathy-guidelines/SKILL.md",
    when: "Before writing, reviewing, debugging, or refactoring code, read this file and apply it. For non-coding requests it is not required.",
  },
  {
    id: "verification-before-completion",
    defaultEnabled: false,
    label: "Verification before completion",
    file: "vendor/superpowers/skills/verification-before-completion/SKILL.md",
    when: "Before claiming work is complete or successful, read this file and perform the relevant verification. Report what was actually checked and any remaining gaps.",
  },
] as const;

export const agentStyleIdSchema = z
  .string()
  .refine(
    (id) => AGENT_STYLES.some((entry) => entry.id === id),
    "Unknown agent style",
  );
export const agentSkillIdSchema = z
  .string()
  .refine(
    (id) => AGENT_SKILLS.some((entry) => entry.id === id),
    "Unknown agent skill",
  );
export const agentGuidanceSchema = z
  .object({
    style: agentStyleIdSchema.nullable(),
    skills: z
      .array(agentSkillIdSchema)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate skills"),
  })
  .strict();
export type AgentGuidance = z.infer<typeof agentGuidanceSchema>;
export const DEFAULT_AGENT_GUIDANCE: AgentGuidance = {
  style: "attention-kind",
  skills: AGENT_SKILLS.filter((entry) => entry.defaultEnabled).map(
    (entry) => entry.id,
  ),
};
export const PURE_AGENT_GUIDANCE: AgentGuidance = { style: null, skills: [] };
