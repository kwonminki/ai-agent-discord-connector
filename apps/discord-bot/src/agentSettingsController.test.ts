import { describe, expect, it, vi } from "vitest";
import type { ManagedDiscordChannelContext } from "./channelContext.js";
import { createAgentSettingsController } from "./agentSettingsController.js";

const codexThread: ManagedDiscordChannelContext = {
  channelMode: "session-linked",
  allowedRoleIds: [],
  computerId: "mac",
  computerDisplayName: "Mac",
  workspaceDisplayName: "repo",
  workspaceRoot: "/repo",
  cwd: "/repo",
  timeoutMs: 1_000,
  agentDefaults: {
    codex: { model: "gpt-main", effort: "high" },
    claude: { model: "claude-main", effort: "max" },
  },
};

describe("createAgentSettingsController", () => {
  it("preserves Ultra for Codex overrides and inherited defaults", async () => {
    const updateSession = vi.fn();
    const controller = createAgentSettingsController({ updateSession });
    await controller.updateEffort("main", { ...codexThread, agentMain: "codex" }, "ultra");
    expect(controller.codexReasoningEffort("inherited", codexThread)).toBe("ultra");
    await controller.updateEffort("override", codexThread, "ultra");
    expect(updateSession).toHaveBeenCalledWith("override", { effort: "ultra" });
    expect(controller.codexReasoningEffort("override", codexThread)).toBe("ultra");
    await controller.updateEffort("override", codexThread, "default");
    expect(controller.codexReasoningEffort("override", codexThread)).toBe("ultra");
  });

  it("resolves each agent from the channel context", () => {
    const controller = createAgentSettingsController();

    expect(controller.agentFor(codexThread)).toBe("codex");
    expect(controller.agentFor({ ...codexThread, channelMode: "claude-code" })).toBe("claude");
    expect(controller.agentFor({ ...codexThread, agentMain: "claude" })).toBe("claude");
  });

  it("keeps thread overrides local and restores main defaults", async () => {
    const updateSession = vi.fn().mockResolvedValue(undefined);
    const controller = createAgentSettingsController({ updateSession });

    await controller.updateModel("thread-a", codexThread, "gpt-thread");
    await controller.updateEffort("thread-a", codexThread, "xhigh");

    expect(controller.get("thread-a", codexThread)).toMatchObject({
      model: "gpt-thread",
      effort: "xhigh",
      modelSource: "thread override",
      effortSource: "thread override",
    });
    expect(controller.get("thread-b", codexThread)).toMatchObject({
      model: "gpt-main",
      effort: "high",
    });

    await controller.updateEffort("thread-a", codexThread, "default");
    expect(controller.get("thread-a", codexThread).effort).toBe("high");
    expect(updateSession).toHaveBeenLastCalledWith("thread-a", { effort: null });
  });

  it("persists main defaults and normalizes unsupported Codex max effort", async () => {
    const updateDefaults = vi.fn().mockResolvedValue({
      codex: { model: "gpt-updated", effort: "xhigh" },
      claude: { model: "claude-main", effort: "max" },
    });
    const controller = createAgentSettingsController({ updateDefaults });
    const mainContext = { ...codexThread, agentMain: "codex" as const };

    await controller.updateModel("main", mainContext, "gpt-updated");
    await controller.updateEffort("main", mainContext, "max");

    expect(updateDefaults).toHaveBeenLastCalledWith("codex", { effort: "xhigh" });
    expect(controller.get("main", mainContext)).toMatchObject({
      model: "gpt-updated",
      effort: "xhigh",
    });
    expect(controller.codexReasoningEffort("main", mainContext)).toBe("xhigh");
  });
});
