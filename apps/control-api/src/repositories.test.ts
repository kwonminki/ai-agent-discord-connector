import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { recordAuditEvent } from "./audit.js";
import { createChannelContextService } from "./channelContexts.js";
import { createCommandAuditService } from "./commandAudit.js";
import { createComputerPresenceService } from "./computerPresence.js";
import { createInventoryService } from "./inventory.js";
import { createRepositories } from "./repositories.js";
import { createSessionLinkService } from "./sessionLinks.js";
import { createWorkspaceMappingService } from "./workspaceMappings.js";

const tempDatabaseDirectory = mkdtempSync(
  join(tmpdir(), "codex-discord-repositories-"),
);
const databaseUrl = `file:${join(tempDatabaseDirectory, "test.sqlite")}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

process.env.DATABASE_URL = databaseUrl;
closeSync(openSync(join(tempDatabaseDirectory, "test.sqlite"), "w"));

execFileSync(process.execPath, [
  join(repoRoot, "node_modules", "prisma", "build", "index.js"),
  "db",
  "push",
  "--skip-generate",
], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "pipe",
});

const prisma = new PrismaClient();

describe("repositories", () => {
  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.managedChannel.updateMany({
      data: { currentSessionLinkId: null },
    });
    await prisma.codexSessionLink.deleteMany();
    await prisma.managedChannel.deleteMany();
    await prisma.categoryMapping.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.computer.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(tempDatabaseDirectory, { force: true, recursive: true });
  });

  it("registers a computer, workspace, and channel", async () => {
    const repos = createRepositories(prisma);

    await repos.computers.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });

    const workspace = await repos.workspaces.create({
      id: "workspace-1",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
    });

    const channel = await repos.channels.create({
      id: "channel-1",
      discordChannelId: "discord-channel-1",
      computerId: "computer-1",
      workspaceId: workspace.id,
      channelMode: "shell-admin",
      cwd: "/Users/me/project",
    });

    expect(channel.status).toBe("created");
    expect(channel.cwd).toBe("/Users/me/project");

    const foundChannel = await repos.channels.findByDiscordChannelId(
      "discord-channel-1",
    );
    expect(foundChannel?.id).toBe(channel.id);

    const auditEvent = await recordAuditEvent(prisma, {
      id: "audit-1",
      channelId: channel.id,
      userId: "discord-user-1",
      targetComputerId: "computer-1",
      targetWorkspaceId: workspace.id,
      cwd: "/Users/me/project",
      rawCommand: "pwd",
      tier: "safe",
      resultStatus: "success",
    });

    expect(auditEvent.resultStatus).toBe("success");
    expect(auditEvent.channelId).toBe(channel.id);
  });

  it("builds a Discord channel context from the control database", async () => {
    const repos = createRepositories(prisma);
    const channelContexts = createChannelContextService(prisma, { defaultTimeoutMs: 4_000 });

    await repos.computers.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });
    const workspace = await repos.workspaces.create({
      id: "workspace-1",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
    });
    await repos.channels.create({
      id: "channel-1",
      discordChannelId: "discord-channel-1",
      computerId: "computer-1",
      workspaceId: workspace.id,
      channelMode: "shell-admin",
      cwd: "/Users/me/project",
    });

    await expect(channelContexts.findByDiscordChannelId("discord-channel-1")).resolves.toEqual({
      channelMode: "shell-admin",
      allowedRoleIds: ["role-operator"],
      computerId: "computer-1",
      computerDisplayName: "macbook-pro-01",
      workspaceDisplayName: "project",
      workspaceRoot: "/Users/me/project",
      cwd: "/Users/me/project",
      timeoutMs: 4_000,
    });

    await channelContexts.updateCwdByDiscordChannelId(
      "discord-channel-1",
      "/Users/me/project/src",
    );

    await expect(channelContexts.findByDiscordChannelId("discord-channel-1")).resolves.toMatchObject({
      cwd: resolve("/Users/me/project/src"),
    });
  });

  it("persists computer heartbeat and advertised workspaces", async () => {
    const computerPresence = createComputerPresenceService(prisma);

    await computerPresence.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
      workspaces: [
        {
          id: "computer-1:/Users/me/project",
          absolutePath: "/Users/me/project",
          displayName: "project",
        },
      ],
    });

    await expect(prisma.computer.findUnique({ where: { id: "computer-1" } })).resolves.toMatchObject({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      status: "online",
      allowedRoleIds: JSON.stringify(["role-operator"]),
      capabilities: JSON.stringify(["shell", "codex-import"]),
    });
    await expect(
      prisma.workspace.findUnique({ where: { id: "computer-1:/Users/me/project" } }),
    ).resolves.toMatchObject({
      id: "computer-1:/Users/me/project",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
      status: "valid",
    });

    await computerPresence.markOffline("computer-1");

    await expect(prisma.computer.findUnique({ where: { id: "computer-1" } })).resolves.toMatchObject({
      status: "offline",
    });
  });

  it("lists computer inventory with advertised workspaces", async () => {
    const computerPresence = createComputerPresenceService(prisma);
    const inventory = createInventoryService(prisma);

    await computerPresence.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
      workspaces: [
        {
          id: "computer-1:/Users/me/project",
          absolutePath: "/Users/me/project",
          displayName: "project",
        },
      ],
    });

    await expect(inventory.listComputers()).resolves.toEqual([
      {
        id: "computer-1",
        displayName: "macbook-pro-01",
        hostname: "macbook-pro-01.local",
        status: "online",
        allowedRoleIds: ["role-operator"],
        capabilities: ["shell", "codex-import"],
        workspaces: [
          {
            id: "computer-1:/Users/me/project",
            absolutePath: "/Users/me/project",
            displayName: "project",
            status: "valid",
          },
        ],
      },
    ]);
  });

  it("creates Discord category and channel mappings for a workspace", async () => {
    const repos = createRepositories(prisma);
    const workspaceMappings = createWorkspaceMappingService(prisma);

    await repos.computers.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });
    await repos.workspaces.create({
      id: "workspace-1",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
    });

    await expect(
      workspaceMappings.createCategoryMapping({
        id: "category-1",
        discordCategoryId: "discord-category-1",
        computerId: "computer-1",
        workspaceId: "workspace-1",
      }),
    ).resolves.toMatchObject({
      id: "category-1",
      discordCategoryId: "discord-category-1",
      computerId: "computer-1",
      workspaceId: "workspace-1",
      syncStatus: "created",
    });
    await expect(
      workspaceMappings.createManagedChannel({
        id: "channel-1",
        discordChannelId: "discord-channel-1",
        computerId: "computer-1",
        workspaceId: "workspace-1",
        channelMode: "shell-admin",
      }),
    ).resolves.toMatchObject({
      id: "channel-1",
      discordChannelId: "discord-channel-1",
      computerId: "computer-1",
      workspaceId: "workspace-1",
      channelMode: "shell-admin",
      cwd: "/Users/me/project",
      status: "created",
    });
  });

  it("records command audit events by Discord channel id", async () => {
    const repos = createRepositories(prisma);
    const commandAudit = createCommandAuditService(prisma);

    await repos.computers.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });
    const workspace = await repos.workspaces.create({
      id: "workspace-1",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
    });
    const channel = await repos.channels.create({
      id: "channel-1",
      discordChannelId: "discord-channel-1",
      computerId: "computer-1",
      workspaceId: workspace.id,
      channelMode: "shell-admin",
      cwd: "/Users/me/project",
    });

    await expect(
      commandAudit.recordForDiscordChannel({
        discordChannelId: "discord-channel-1",
        userId: "discord-user-1",
        cwd: "/Users/me/project",
        rawCommand: "ls",
        tier: "safe-read",
        resultStatus: "completed",
      }),
    ).resolves.toMatchObject({
      channelId: channel.id,
      userId: "discord-user-1",
      targetComputerId: "computer-1",
      targetWorkspaceId: workspace.id,
      cwd: "/Users/me/project",
      rawCommand: "ls",
      tier: "safe-read",
      resultStatus: "completed",
    });
  });

  it("links an imported Codex session to a managed Discord channel", async () => {
    const repos = createRepositories(prisma);
    const sessionLinks = createSessionLinkService(prisma);

    await repos.computers.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });
    const workspace = await repos.workspaces.create({
      id: "workspace-1",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
    });
    const channel = await repos.channels.create({
      id: "channel-1",
      discordChannelId: "discord-channel-1",
      computerId: "computer-1",
      workspaceId: workspace.id,
      channelMode: "session-linked",
      cwd: "/Users/me/project",
    });

    await expect(
      sessionLinks.linkCodexSessionToDiscordChannel({
        discordChannelId: "discord-channel-1",
        id: "session-link-1",
        codexSessionId: "codex-session-1",
        origin: "imported_native",
        threadNameSnapshot: "Codex Discord planning",
      }),
    ).resolves.toMatchObject({
      id: "session-link-1",
      channelId: channel.id,
      codexSessionId: "codex-session-1",
      origin: "imported_native",
      threadNameSnapshot: "Codex Discord planning",
      availabilityStatus: "available",
    });
    await expect(prisma.managedChannel.findUnique({ where: { id: channel.id } })).resolves.toMatchObject({
      currentSessionLinkId: "session-link-1",
      status: "attached",
    });
  });

  it("rejects channel creation when workspace belongs to another computer", async () => {
    const repos = createRepositories(prisma);

    await repos.computers.upsertHeartbeat({
      id: "computer-1",
      displayName: "macbook-pro-01",
      hostname: "macbook-pro-01.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });
    await repos.computers.upsertHeartbeat({
      id: "computer-2",
      displayName: "macbook-pro-02",
      hostname: "macbook-pro-02.local",
      allowedRoleIds: ["role-operator"],
      capabilities: ["shell", "codex-import"],
    });

    const workspace = await repos.workspaces.create({
      id: "workspace-1",
      computerId: "computer-1",
      absolutePath: "/Users/me/project",
      displayName: "project",
    });

    await expect(
      repos.channels.create({
        id: "channel-1",
        discordChannelId: "discord-channel-1",
        computerId: "computer-2",
        workspaceId: workspace.id,
        channelMode: "shell-admin",
        cwd: "/Users/me/project",
      }),
    ).rejects.toThrow(
      "Cannot create channel for computer computer-2 in workspace workspace-1 owned by computer computer-1.",
    );
  });

  it("rejects direct channel writes when workspace belongs to another computer", async () => {
    await prisma.computer.createMany({
      data: [
        {
          id: "computer-1",
          displayName: "macbook-pro-01",
          hostname: "macbook-pro-01.local",
          status: "online",
          allowedRoleIds: "[]",
          capabilities: "[]",
        },
        {
          id: "computer-2",
          displayName: "macbook-pro-02",
          hostname: "macbook-pro-02.local",
          status: "online",
          allowedRoleIds: "[]",
          capabilities: "[]",
        },
      ],
    });
    await prisma.workspace.create({
      data: {
        id: "workspace-1",
        computerId: "computer-1",
        absolutePath: "/Users/me/project",
        displayName: "project",
        status: "valid",
      },
    });

    await expect(
      prisma.managedChannel.create({
        data: {
          id: "channel-1",
          discordChannelId: "discord-channel-1",
          computerId: "computer-2",
          workspaceId: "workspace-1",
          channelMode: "shell-admin",
          cwd: "/Users/me/project",
          status: "created",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects direct category mapping writes when workspace belongs to another computer", async () => {
    await prisma.computer.createMany({
      data: [
        {
          id: "computer-1",
          displayName: "macbook-pro-01",
          hostname: "macbook-pro-01.local",
          status: "online",
          allowedRoleIds: "[]",
          capabilities: "[]",
        },
        {
          id: "computer-2",
          displayName: "macbook-pro-02",
          hostname: "macbook-pro-02.local",
          status: "online",
          allowedRoleIds: "[]",
          capabilities: "[]",
        },
      ],
    });
    await prisma.workspace.create({
      data: {
        id: "workspace-1",
        computerId: "computer-1",
        absolutePath: "/Users/me/project",
        displayName: "project",
        status: "valid",
      },
    });

    await expect(
      prisma.categoryMapping.create({
        data: {
          id: "category-1",
          discordCategoryId: "discord-category-1",
          computerId: "computer-2",
          workspaceId: "workspace-1",
          syncStatus: "created",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects setting a current session link from another channel", async () => {
    await prisma.computer.create({
      data: {
        id: "computer-1",
        displayName: "macbook-pro-01",
        hostname: "macbook-pro-01.local",
        status: "online",
        allowedRoleIds: "[]",
        capabilities: "[]",
      },
    });
    await prisma.workspace.create({
      data: {
        id: "workspace-1",
        computerId: "computer-1",
        absolutePath: "/Users/me/project",
        displayName: "project",
        status: "valid",
      },
    });
    await prisma.managedChannel.createMany({
      data: [
        {
          id: "channel-a",
          discordChannelId: "discord-channel-a",
          computerId: "computer-1",
          workspaceId: "workspace-1",
          channelMode: "session-linked",
          cwd: "/Users/me/project",
          status: "created",
        },
        {
          id: "channel-b",
          discordChannelId: "discord-channel-b",
          computerId: "computer-1",
          workspaceId: "workspace-1",
          channelMode: "session-linked",
          cwd: "/Users/me/project",
          status: "created",
        },
      ],
    });
    await prisma.codexSessionLink.create({
      data: {
        id: "session-link-a",
        channelId: "channel-a",
        codexSessionId: "codex-session-a",
        origin: "created",
        threadNameSnapshot: "thread-a",
        attachedAt: new Date(),
        availabilityStatus: "available",
      },
    });

    await expect(
      prisma.managedChannel.update({
        where: { id: "channel-b" },
        data: { currentSessionLinkId: "session-link-a" },
      }),
    ).rejects.toThrow();
  });
});
