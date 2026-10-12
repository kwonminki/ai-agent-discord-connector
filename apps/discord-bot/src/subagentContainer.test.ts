import { randomUUID } from "node:crypto";
import { ChannelType, Collection, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDiscordGuildSurface } from "./discordClient.js";

function fixture(existing = true, category = true) {
  const overwrites = new Collection([["operator", { id: "operator", type: 0, allow: new PermissionsBitField(1024n), deny: new PermissionsBitField(0n) }]]);
  const parent = { id: "admin", name: "familiar-admin", type: ChannelType.GuildText, parentId: "old-category", permissionOverwrites: { cache: overwrites } };
  const child = { id: "container", name: "familiar-admin-subagents", type: ChannelType.GuildText, parentId: "old-category", topic: "AI Agent Discord Connector subagents for admin", permissionOverwrites: { cache: overwrites, set: vi.fn() }, edit: vi.fn(async (input) => { Object.assign(child, { name: input.name, parentId: input.parent }); return child; }) };
  const channels = new Collection<string, Record<string, unknown>>([["admin", parent]]);
  if (existing) channels.set(child.id, child);
  if (category) channels.set("category", { id: "category", name: "subagents", type: ChannelType.GuildCategory });
  const guild = { id: randomUUID(), channels: {
    fetch: vi.fn(async (id?: string) => id ? channels.get(id) : channels),
    create: vi.fn(async (input) => { const channel = { ...input, id: input.type === ChannelType.GuildCategory ? "category" : "new-container" }; channels.set(channel.id, channel); return channel; }),
  } };
  return { guild, child, parent, channels, surface: createDiscordGuildSurface(guild as never)! };
}

describe("subagent category", () => {
  it("moves an existing container without recreating it or changing permissions", async () => {
    const { guild, child, surface } = fixture();
    expect(await surface.ensureSubagentContainer!("admin", "Familiar0 Mingi")).toMatchObject({ id: "container" });
    expect(child.edit).toHaveBeenCalledWith(expect.objectContaining({ parent: "category", name: "familiar0-mingi", lockPermissions: false }));
    expect(child.permissionOverwrites.set).not.toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
    await surface.ensureSubagentContainer!("admin", "Familiar0 Mingi");
    expect(child.edit).toHaveBeenCalledTimes(1);
  });
  it("creates the category and a server channel with the original access rules", async () => {
    const { guild, surface } = fixture(false, false);
    await surface.ensureSubagentContainer!("admin", "Kwon Mac");
    expect(guild.channels.create.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ name: "subagents", type: ChannelType.GuildCategory }),
      expect.objectContaining({ name: "kwon-mac", type: ChannelType.GuildText, parent: "category", permissionOverwrites: [expect.objectContaining({ id: "operator" })] }),
    ]);
  });
  it("reuses a shared category and retains separate ownership for each server", async () => {
    const { guild, channels, surface } = fixture(false);
    channels.set("another-container", { id: "another-container", name: "familiar0-mingi", type: ChannelType.GuildText, topic: "AI Agent Discord Connector subagents for another-admin" });
    await surface.ensureSubagentContainer!("admin", "Familiar0 Mingi");
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ parent: "category", topic: "AI Agent Discord Connector subagents for admin" }));
  });
  it("refuses ambiguous categories without moving or creating anything", async () => {
    const { channels, guild, child, surface } = fixture();
    channels.set("duplicate", { id: "duplicate", name: "subagents", type: ChannelType.GuildCategory });
    await expect(surface.ensureSubagentContainer!("admin", "PC")).rejects.toThrow("Duplicate subagents categories");
    expect(child.edit).not.toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
  });
});
