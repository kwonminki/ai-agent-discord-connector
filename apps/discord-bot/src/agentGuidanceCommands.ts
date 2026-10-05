import {
  AGENT_SKILLS,
  AGENT_STYLES,
  type AgentGuidance,
} from "../../../packages/core/src/agentGuidance.js";
import type { DiscordMessagePayload } from "./responses.js";

export type AgentGuidanceCommand =
  | { action: "show" | "pure" | "reset" }
  | { action: "style"; style: string | null | "inherit" }
  | { action: "skill"; skill: string; enabled: boolean }
  | { action: "invalid" };

export function parseAgentGuidanceCommand(
  content: string,
): AgentGuidanceCommand | null {
  const parts = content.trim().replace(/^\//, "").split(/\s+/);
  const command = parts[0]?.toLowerCase();
  if (
    !["set_style", "set_skill", "skills", "skills_reset", "pure"].includes(
      command,
    )
  )
    return null;
  if (command === "pure" && parts.length === 1) return { action: "pure" };
  if (command === "skills_reset" && parts.length === 1)
    return { action: "reset" };
  if ((command === "skills" || command === "set_style") && parts.length === 1)
    return { action: "show" };
  if (command === "set_style" && parts.length === 2) {
    const style = parts[1];
    if (style === "off") return { action: "style", style: null };
    if (style === "inherit" || AGENT_STYLES.some((item) => item.id === style))
      return { action: "style", style };
  }
  if (
    command === "set_skill" &&
    parts.length === 3 &&
    AGENT_SKILLS.some((item) => item.id === parts[1]) &&
    ["on", "off"].includes(parts[2])
  ) {
    return { action: "skill", skill: parts[1], enabled: parts[2] === "on" };
  }
  return { action: "invalid" };
}

export function agentGuidancePanel(
  guidance: AgentGuidance,
  isParent: boolean,
): DiscordMessagePayload {
  return {
    allowedMentions: { parse: [] },
    ephemeral: true,
    embeds: [
      {
        title: "스타일 · 스킬",
        color: 0x3498db,
        description: `${isParent ? "이 부모 채널의 기본값" : "이 대화의 설정"} · 변경은 다음 요청부터 적용됩니다.\n스타일: **${guidance.style ?? "끔"}**\n${AGENT_SKILLS.map((skill) => `${guidance.skills.includes(skill.id) ? "✅" : "⬜"} ${skill.label}`).join("\n")}\n\n\`/set_skill\`로 개별 설정 · \`/pure\`로 모두 끄기 · \`/skills_reset\`으로 상속/기본값 복원`,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "cdc:guidance:style",
            placeholder: `스타일 선택 · 현재 ${guidance.style ?? "끔"}`,
            min_values: 1,
            max_values: 1,
            options: [
              ...AGENT_STYLES.map((style) => ({
                label: style.label,
                value: style.id,
                description: style.description,
              })),
              { label: "스타일 끄기", value: "off" },
              { label: "부모 채널 / 기본값 상속", value: "inherit" },
            ],
          },
        ],
      },
    ],
  };
}
