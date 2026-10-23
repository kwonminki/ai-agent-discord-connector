import { REST, Routes } from "discord.js";
import type { HostDiscordApi, ProvisionChannel } from "./host.js";

/** REST only: provisioning never starts a gateway, agent, service, or shell. */
export function createHostDiscordApi(token: string): HostDiscordApi {
  const rest = new REST({ version: "10", timeout: 15_000, retries: 0 }).setToken(token);
  async function request<T>(operation: () => Promise<unknown>): Promise<T> {
    try { return await operation() as T; }
    catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      // Discord.js error objects contain requestBody and rawError: do not print/persist them.
      const detail = typeof status === "number" ? ` (HTTP ${status}${typeof code === "number" ? `, Discord ${code}` : ""})` : "";
      throw new Error(`Discord provisioning request failed${detail}. Check bot access and Manage Channels permission, then retry the same host operation.`);
    }
  }
  return {
    currentUser: () => request(() => rest.get(Routes.user("@me"))),
    roleIds: async guildId => (await request<Array<{ id: string }>>(() => rest.get(Routes.guildRoles(guildId)))).map(role => role.id),
    listChannels: guildId => request(() => rest.get(Routes.guildChannels(guildId))),
    createChannel: (guildId, body) => request<ProvisionChannel>(() => rest.post(Routes.guildChannels(guildId), { body, reason: "Prepare a dedicated connector host channel" })),
  };
}
