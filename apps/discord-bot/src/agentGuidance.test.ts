import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_GUIDANCE,
  PURE_AGENT_GUIDANCE,
} from "../../../packages/core/src/agentGuidance.js";
import { createAgentGuidanceStore } from "./agentGuidanceStore.js";
import { agentGuidancePanel } from "./agentGuidanceCommands.js";
import { routeDiscordComponent } from "./componentRouter.js";
import { routeDiscordMessage } from "./commandRouter.js";
import { routeDiscordApplicationCommand } from "./applicationCommands.js";
import {
  createDiscordMessageHandler,
  type ManagedDiscordChannelContext,
} from "./messageHandler.js";

const roots: string[] = [];
async function storeAt() {
  const root = await mkdtemp(path.join(os.tmpdir(), "guidance-store-"));
  roots.push(root);
  const file = path.join(root, "state.json");
  return { file, store: createAgentGuidanceStore(file) };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent guidance preferences", () => {
  it("inherits defaults, isolates channels, persists pure, and restores inheritance", async () => {
    const { file, store } = await storeAt();
    const parent = { channelId: "parent" };
    const child = { channelId: "child", parentId: "parent" };
    expect(await store.get(child)).toEqual(DEFAULT_AGENT_GUIDANCE);
    await store.setStyle(parent, "spartan");
    expect((await store.get(child)).style).toBe("spartan");
    await store.pure(child);
    await store.copy(child, { channelId: "fork", parentId: "parent" });
    await store.setStyle(parent, "rundown");
    const reopened = createAgentGuidanceStore(file);
    expect(await reopened.get(child)).toEqual(PURE_AGENT_GUIDANCE);
    expect(
      await reopened.get({ channelId: "fork", parentId: "parent" }),
    ).toEqual(PURE_AGENT_GUIDANCE);
    expect(
      (await reopened.get({ channelId: "other", parentId: "parent" })).style,
    ).toBe("rundown");
    await reopened.setStyle(child, "tldr");
    expect(await reopened.get(child)).toEqual({ style: "tldr", skills: [] });
    await reopened.reset(child);
    expect(await reopened.get(child)).toEqual({
      ...DEFAULT_AGENT_GUIDANCE,
      style: "rundown",
    });
  });

  it("defaults connector styles and skills off without overwriting explicit persisted choices", async () => {
    const { file, store } = await storeAt();
    expect(DEFAULT_AGENT_GUIDANCE).toEqual({ style: null, skills: [] });
    const skills = ["karpathy-guidelines", "verification-before-completion"];
    await writeFile(file, JSON.stringify({ version: 1, channels: {
      explicit: { skills }, styleOnly: { style: "spartan" },
    } }));
    expect((await store.get({ channelId: "explicit" })).skills).toEqual(skills);
    expect((await store.get({ channelId: "child", parentId: "explicit" })).skills).toEqual(skills);
    expect((await store.get({ channelId: "styleOnly" })).skills).toEqual([]);
    expect((await store.get({ channelId: "styleOnly" })).style).toBe("spartan");
    expect((await store.get({ channelId: "new" })).style).toBeNull();
    await store.reset({ channelId: "explicit" });
    expect((await store.get({ channelId: "explicit" })).skills).toEqual([]);
    await store.setSkill({ channelId: "styleOnly" }, "karpathy-guidelines", true);
    expect((await store.get({ channelId: "styleOnly" })).skills).toEqual(["karpathy-guidelines"]);
    expect(agentGuidancePanel(DEFAULT_AGENT_GUIDANCE, false).embeds![0].description)
      .toContain("로컬 Codex·Claude에 설치한 스킬은 이 설정과 별개");
  });

  it("serializes concurrent changes and rejects unknown files without losing settings", async () => {
    const { file, store } = await storeAt();
    const scope = { channelId: "thread" };
    await Promise.all([
      store.setStyle(scope, "spartan"),
      store.setSkill(scope, "verification-before-completion", true),
    ]);
    expect(await store.get(scope)).toEqual({
      style: "spartan",
      skills: ["verification-before-completion"],
    });
    const before = await readFile(file, "utf8");
    await expect(store.setStyle(scope, "../../secret")).rejects.toThrow();
    await expect(
      store.setSkill(scope, "unknown-skill", false),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before);
    await writeFile(file, "broken");
    await expect(store.get(scope)).rejects.toThrow();
  });

  it("routes slash commands and dropdown selections through role authorization", () => {
    const command = routeDiscordApplicationCommand({
      commandName: "set_skill",
      options: {
        getString: () => "karpathy-guidelines",
        getBoolean: () => false,
      },
    });
    expect(command).toBe("set_skill karpathy-guidelines off");
    const panel = agentGuidancePanel(DEFAULT_AGENT_GUIDANCE, false);
    const menu = panel.components![0].components[0];
    expect(menu.type).toBe(3);
    expect(routeDiscordComponent("cdc:guidance:style", ["tldr"])).toBe(
      "set_style tldr",
    );
    expect(
      routeDiscordComponent("cdc:guidance:style", ["../../bad"]),
    ).toBeNull();
    const common = {
      channelMode: "session-linked" as const,
      content: command!,
      allowedRoleIds: ["operator"],
    };
    expect(routeDiscordMessage({ ...common, userRoleIds: [] })).toMatchObject({
      type: "denied",
    });
    expect(
      routeDiscordMessage({ ...common, userRoleIds: ["operator"] }),
    ).toMatchObject({
      type: "agent-guidance",
      request: { action: "skill", enabled: false },
    });
  });

  it.each(["codex", "claude"] as const)(
    "preserves %s defaults and pure across requests, Gateway restart, and forks",
    async (agent) => {
      const { file, store } = await storeAt();
      const context: ManagedDiscordChannelContext = {
        channelMode: agent === "codex" ? "session-linked" : "claude-code",
        allowedRoleIds: ["operator"],
        computerId: "pc",
        computerDisplayName: "pc",
        workspaceDisplayName: "repo",
        workspaceRoot: "/repo",
        cwd: "/repo",
        timeoutMs: 1000,
        discordParentChannelId: "parent",
        codexSessionId: null,
        claudeSessionId: null,
      };
      const submit = vi.fn().mockResolvedValue({
        jobId: "job",
        result: {
          status: "completed",
          finalMessage: "answer",
          sessionId: "test-session",
          exitCode: 0,
        },
      });
      const recordClaudeSession = vi.fn();
      const linkNewCodexSession = vi.fn();
      const makeHandler = () =>
        createDiscordMessageHandler({
          guidanceStore: createAgentGuidanceStore(file),
          resolveChannelContext: async () => context,
          submitCommandJob: vi.fn(),
          submitCodexPrompt: submit,
          submitClaudePrompt: submit,
          createForkedSessionThread: vi.fn().mockResolvedValue({
            discordChannelId: "fork",
            channelMode: context.channelMode,
            workspaceRoot: "/repo",
            cwd: "/repo",
            threadName: "Fork",
          }),
          linkNewCodexSession,
          recordClaudeSession,
          updateChannelCwd: vi.fn(),
          recordCommandAudit: vi.fn(),
        });
      const message = (content: string, roles = ["operator"]) => ({
        channelId: "thread",
        userId: "user",
        authorBot: false,
        roleIds: roles,
        content,
        reply: vi.fn().mockResolvedValue({ edit: vi.fn() }),
      });
      const handler = makeHandler();
      await handler(message("Fix this code"));
      expect(submit.mock.calls[0][0].payload.guidance).toEqual(
        DEFAULT_AGENT_GUIDANCE,
      );
      await handler(message("/pure", []));
      expect(await store.get({ channelId: "thread" })).toEqual(
        DEFAULT_AGENT_GUIDANCE,
      );
      await handler(message("/pure"));
      await makeHandler()(message("Another request"));
      expect(submit.mock.calls[1][0].payload.guidance).toEqual(
        PURE_AGENT_GUIDANCE,
      );
      submit.mockResolvedValueOnce({
        jobId: "fork-job",
        result: {
          status: "completed",
          finalMessage: "Fork ready",
          sessionId: "fork-session",
          exitCode: 0,
        },
      });
      await handler({
        ...message("__cdc_fork_session %7B%22name%22%3A%22Fork%22%7D"),
        guild: {
          createCategory: vi.fn(),
          createTextChannel: vi.fn(),
          sendTextMessage: vi.fn(),
        },
      });
      expect(submit.mock.calls[2][0].payload.guidance).toEqual(
        PURE_AGENT_GUIDANCE,
      );
      expect(
        agent === "codex" ? linkNewCodexSession : recordClaudeSession,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({ discordChannelId: "fork" }),
      );
      await store.reset({ channelId: "thread" });
      expect(
        await store.get({ channelId: "fork", parentId: "parent" }),
      ).toEqual(PURE_AGENT_GUIDANCE);
    },
  );
});
