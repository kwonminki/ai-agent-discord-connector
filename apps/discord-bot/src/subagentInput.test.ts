import { describe, expect, it, vi } from "vitest";
import { createDiscordMessageHandler, type CreateDiscordMessageHandlerInput, type ManagedDiscordChannelContext } from "./messageHandler.js";
const base: ManagedDiscordChannelContext = { channelMode: "session-linked", allowedRoleIds: ["operator"], computerId: "pc", computerDisplayName: "PC", workspaceRoot: "/repo", workspaceDisplayName: "repo", cwd: "/repo", timeoutMs: 3000, codexSessionId: "root" };
function setup(context: ManagedDiscordChannelContext, overrides: Partial<CreateDiscordMessageHandlerInput> = {}) {
  const orca = vi.fn().mockResolvedValue(true), desktop = vi.fn().mockResolvedValue(true);
  const submitCodexPrompt = vi.fn();
  const handler = createDiscordMessageHandler({ orcaBridge: { handle: orca }, desktopBridge: { handle: desktop },
    resolveChannelContext: async id => id === "parent" ? base : context, resolveSubagentParentChannel: async () => "parent",
    submitCodexPrompt, submitCommandJob: vi.fn(), updateChannelCwd: vi.fn(), recordCommandAudit: vi.fn(), ...overrides });
  const message = { channelId: "child", userId: "user", roleIds: ["operator"], authorBot: false, content: "Check this edge case", messageId: "message", reply: vi.fn().mockResolvedValue(undefined) };
  return { handler, message, orca, desktop, submitCodexPrompt };
}
describe("subagent Discord input", () => {
  it("passes native delegation requests to Codex and steers the existing parent when replying to a child", async () => {
    let finishParent: (response: unknown) => void = () => {};
    const controlCodexTurn = vi.fn().mockResolvedValue({ status: "accepted", threadId: "root", turnId: "turn", message: "steered" });
    const input = setup({ ...base, codexSessionId: "native-child", subagent: { source: "codex", parentSessionId: "root", agentPath: "/root/review" } }, { controlCodexTurn });
    input.orca.mockResolvedValue(false); input.desktop.mockResolvedValue(false);
    input.submitCodexPrompt.mockImplementation(() => new Promise(resolve => { finishParent = resolve; }));
    const prompt = "서브 에이전트 2개로 구현과 리뷰를 나눠 진행해줘";
    const parent = input.handler({ ...input.message, channelId: "parent", content: prompt });
    try {
      await vi.waitFor(() => expect(input.submitCodexPrompt).toHaveBeenCalledTimes(1));
      expect(input.submitCodexPrompt.mock.calls[0][0].payload).toMatchObject({ sessionId: "root", prompt, controlKey: "parent" });
      expect(input.submitCodexPrompt.mock.calls[0][0].payload.forkSession).toBeUndefined();
      await input.handler(input.message);
      expect(controlCodexTurn).toHaveBeenCalledWith(expect.objectContaining({ controlKey: "parent", action: "steer", content: expect.stringContaining("existing subagent native-child (agent path: /root/review)") }));
      expect(controlCodexTurn.mock.calls[0][0].content).toContain(input.message.content);
      expect(input.submitCodexPrompt).toHaveBeenCalledTimes(1);
    } finally {
      finishParent({ jobId: "job", result: { status: "completed", finalMessage: "Done", sessionId: "root" } });
      await parent;
    }
  });
  it("resumes the existing parent for an idle native child without opening or forking the child", async () => {
    const input = setup({ ...base, codexSessionId: "native-child", subagent: { source: "codex", parentSessionId: "root" } });
    input.orca.mockResolvedValue(false); input.desktop.mockResolvedValue(false);
    input.submitCodexPrompt.mockResolvedValue({ jobId: "job", result: { status: "completed", finalMessage: "Forwarded", sessionId: "root" } });
    await input.handler(input.message);
    expect(input.submitCodexPrompt).toHaveBeenCalledTimes(1);
    expect(input.submitCodexPrompt.mock.calls[0][0].payload).toMatchObject({ sessionId: "root", controlKey: "parent", prompt: expect.stringContaining("existing subagent native-child") });
    expect(input.submitCodexPrompt.mock.calls[0][0].payload.forkSession).toBeUndefined();
  });
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
