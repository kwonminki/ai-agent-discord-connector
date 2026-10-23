import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), setToken: vi.fn(), options: vi.fn() }));
vi.mock("discord.js", () => ({
  REST: class {
    constructor(options: unknown) { mock.options(options); }
    setToken(token: string) { mock.setToken(token); return this; }
    get = mock.get;
    post = mock.post;
  },
  Routes: { user: (id: string) => `/users/${id}`, guildRoles: (id: string) => `/guilds/${id}/roles`, guildChannels: (id: string) => `/guilds/${id}/channels` },
}));
import { createHostDiscordApi } from "./hostDiscord.js";
beforeEach(() => vi.clearAllMocks());
describe("Discord REST adapter", () => {
  it("uses REST with bounded timeout and no automatic create retries", async () => {
    const api = createHostDiscordApi("mock-secret");
    expect(mock.options).toHaveBeenCalledWith({ version: "10", timeout: 15_000, retries: 0 });
    expect(mock.setToken).toHaveBeenCalledWith("mock-secret");
    mock.get.mockResolvedValueOnce([{ id: "role" }]);
    expect(await api.roleIds("guild")).toEqual(["role"]);
    mock.post.mockResolvedValueOnce({ id: "channel" });
    await api.createChannel("guild", { name: "name", type: 0, topic: "owner" });
    expect(mock.post).toHaveBeenCalledWith("/guilds/guild/channels", { body: { name: "name", type: 0, topic: "owner" }, reason: expect.any(String) });
  });
  it("returns sanitized HTTP/code errors without Discord request bodies, token or stack cause", async () => {
    const api = createHostDiscordApi("mock-secret");
    mock.get.mockRejectedValue({ status: 403, code: 50013, rawError: { secret: "mock-secret" }, message: "mock-secret", requestBody: { token: "mock-secret" } });
    let caught: unknown;
    try { await api.currentUser(); } catch (error) { caught = error; }
    expect(String(caught)).toContain("HTTP 403, Discord 50013");
    expect(String(caught)).not.toContain("mock-secret");
    expect((caught as Error).cause).toBeUndefined();
  });
});
