import { describe, expect, it, vi } from "vitest";
import { createDiscordMessageHandler, type ManagedDiscordChannelContext } from "./messageHandler.js";
const base: ManagedDiscordChannelContext = { channelMode: "session-linked", allowedRoleIds: ["operator"], computerId: "pc", computerDisplayName: "PC", workspaceRoot: "/repo", workspaceDisplayName: "repo", cwd: "/repo", timeoutMs: 3000, codexSessionId: "root" };
function setup(context: ManagedDiscordChannelContext) {
  const orca = vi.fn().mockResolvedValue(true), desktop = vi.fn().mockResolvedValue(true);
  const submitCodexPrompt = vi.fn();
  const handler = createDiscordMessageHandler({ orcaBridge: { handle: orca }, desktopBridge: { handle: desktop },
    resolveChannelContext: async id => id === "parent" ? base : context, resolveSubagentParentChannel: async () => "parent",
    submitCodexPrompt, submitCommandJob: vi.fn(), updateChannelCwd: vi.fn(), recordCommandAudit: vi.fn() });
  const message = { channelId: "child", userId: "user", roleIds: ["operator"], authorBot: false, content: "Check this edge case", messageId: "message", reply: vi.fn().mockResolvedValue(undefined) };
  return { handler, message, orca, desktop, submitCodexPrompt };
}
describe("subagent Discord input", () => {
  it.each(["subagent-index", "subagent-redirect"] as const)("keeps %s read-only before external input and commands", async channelPurpose => {
    const input = setup({ ...base, channelPurpose, redirectChannelId: channelPurpose === "subagent-redirect" ? "new" : undefined });
    for (const content of ["Hello", "/fork", "/orca send Hello"]) await input.handler({ ...input.message, content });
    expect(input.orca).not.toHaveBeenCalled(); expect(input.desktop).not.toHaveBeenCalled(); expect(input.submitCodexPrompt).not.toHaveBeenCalled();
    expect(input.message.reply).toHaveBeenCalledTimes(3);
  });
  it("routes a native child's message to its parent with an explicit exact-child request", async () => {
    const input = setup({ ...base, codexSessionId: "native-child", subagent: { source: "codex", parentSessionId: "root" } });
    await input.handler(input.message);
    expect(input.orca).toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent", content: expect.stringContaining("existing subagent native-child") }), base, expect.any(Function));
    expect(input.submitCodexPrompt).not.toHaveBeenCalled();
    expect(JSON.stringify(input.message.reply.mock.calls)).toContain("부모 작업");
  });
  it("keeps Orca workers on their exact child session and enforces native child authorization", async () => {
    const input = setup({ ...base, codexSessionId: "worker", subagent: { source: "orca", parentSessionId: "root" } });
    await input.handler(input.message);
    expect(input.orca).toHaveBeenCalledWith(input.message, expect.objectContaining({ codexSessionId: "worker" }), expect.any(Function));
    const denied = setup({ ...base, codexSessionId: "native-child", subagent: { source: "codex", parentSessionId: "root" } });
    await denied.handler({ ...denied.message, roleIds: [] });
    expect(denied.orca).not.toHaveBeenCalled(); expect(denied.submitCodexPrompt).not.toHaveBeenCalled();
  });
});
