import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  agentGuidanceSchema,
  agentSkillIdSchema,
  DEFAULT_AGENT_GUIDANCE,
  type AgentGuidance,
} from "../../../packages/core/src/agentGuidance.js";

const overrideSchema = agentGuidanceSchema.partial();
const stateSchema = z.object({
  version: z.literal(1),
  channels: z.record(overrideSchema),
});
type State = z.infer<typeof stateSchema>;
type Override = z.infer<typeof overrideSchema>;
export type GuidanceScope = { channelId: string; parentId?: string | null };
export type AgentGuidanceStore = ReturnType<typeof createAgentGuidanceStore>;

export function createAgentGuidanceStore(file: string) {
  // One store is shared by a Gateway. Serialize read-modify-write operations.
  let tail: Promise<unknown> = Promise.resolve();
  async function read(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, channels: {} };
      throw error; // Never silently re-enable defaults after a damaged /pure setting.
    }
  }
  function resolve(state: State, scope: GuidanceScope): AgentGuidance {
    return agentGuidanceSchema.parse({
      ...DEFAULT_AGENT_GUIDANCE,
      ...(scope.parentId ? state.channels[scope.parentId] : {}),
      ...state.channels[scope.channelId],
    });
  }
  async function change(
    scope: GuidanceScope,
    update: (
      current: AgentGuidance,
      own: Override,
      state: State,
    ) => Override | null,
  ) {
    const result = tail.then(async () => {
      const state = await read();
      const patch = update(
        resolve(state, scope),
        state.channels[scope.channelId] ?? {},
        state,
      );
      if (patch === null) delete state.channels[scope.channelId];
      else state.channels[scope.channelId] = overrideSchema.parse(patch);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
          mode: 0o600,
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return resolve(state, scope);
    });
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    async get(scope: GuidanceScope) {
      await tail;
      return resolve(await read(), scope);
    },
    setStyle(scope: GuidanceScope, style: string | null | "inherit") {
      return change(scope, (_current, own) => {
        const next = { ...own };
        if (style === "inherit") delete next.style;
        else next.style = style;
        return next;
      });
    },
    setSkill(scope: GuidanceScope, skill: string, enabled: boolean) {
      return change(scope, (current, own) => {
        agentSkillIdSchema.parse(skill);
        return {
          ...own,
          skills: enabled
            ? [...new Set([...current.skills, skill])]
            : current.skills.filter((id) => id !== skill),
        };
      });
    },
    copy(source: GuidanceScope, target: GuidanceScope) {
      return change(target, (_current, _own, state) => resolve(state, source));
    },
    pure(scope: GuidanceScope) {
      return change(scope, () => ({ style: null, skills: [] }));
    },
    reset(scope: GuidanceScope) {
      return change(scope, () => null);
    },
  };
}
