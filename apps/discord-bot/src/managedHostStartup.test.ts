import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectWorkerStore } from "../../local-agent/src/directWorkerStore.js";

const startup = vi.hoisted(() => ({
  assertManagedHost: vi.fn(),
  createDiscordClient: vi.fn(),
  createDirectSyncStateStore: vi.fn(),
  createDirectWorkerStore: vi.fn(),
}));

vi.mock("../../connect-cli/src/host.js", () => ({
  assertManagedHost: startup.assertManagedHost,
}));
vi.mock("./discordClient.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./discordClient.js")>(),
  createDiscordClient: startup.createDiscordClient,
}));
vi.mock("./directState.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./directState.js")>(),
  createDirectSyncStateStore: startup.createDirectSyncStateStore,
}));
vi.mock("../../local-agent/src/directWorkerStore.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../local-agent/src/directWorkerStore.js")>(),
  createDirectWorkerStore: startup.createDirectWorkerStore,
}));

describe("managed installation startup boundary", () => {
  let root: string;
  let config: unknown;
  let previousConfigPath: string | undefined;
  let previousToken: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), "managed-host-startup-"));
    await mkdir(path.join(root, ".connect"));
    // A custom filename must be checked using the config that will actually run.
    const configPath = path.join(root, ".connect", "custom-config.json");
    config = {
      mode: "direct",
      discord: { token: "test-token", guildId: "test-guild" },
      direct: { hostInstallationId: "test-installation", computerId: "test-host" },
    };
    await writeFile(configPath, JSON.stringify(config));
    previousConfigPath = process.env.CONNECT_CONFIG_PATH;
    previousToken = process.env.DISCORD_TOKEN;
    process.env.CONNECT_CONFIG_PATH = configPath;
    startup.assertManagedHost.mockRejectedValue(new Error("Managed host fingerprint mismatch"));
  });

  afterEach(async () => {
    if (previousConfigPath === undefined) delete process.env.CONNECT_CONFIG_PATH;
    else process.env.CONNECT_CONFIG_PATH = previousConfigPath;
    if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a copied gateway before constructing clients, state or event queues", async () => {
    const { startBot } = await import("./index.js");

    await expect(startBot()).rejects.toThrow("Managed host fingerprint mismatch");

    expect(startup.assertManagedHost).toHaveBeenCalledExactlyOnceWith(root, config);
    expect(startup.createDiscordClient).not.toHaveBeenCalled();
    expect(startup.createDirectSyncStateStore).not.toHaveBeenCalled();
    expect(startup.createDirectWorkerStore).not.toHaveBeenCalled();
  }, 15_000);

  it("rejects a copied worker before constructing its queue store", async () => {
    const { startDirectWorker } = await import("../../local-agent/src/directWorker.js");

    await expect(startDirectWorker()).rejects.toThrow("Managed host fingerprint mismatch");

    expect(startup.assertManagedHost).toHaveBeenCalledExactlyOnceWith(root, config);
    expect(startup.createDirectWorkerStore).not.toHaveBeenCalled();
  }, 15_000);

  it("checks injected worker stores before acquiring a lock or reading durable jobs", async () => {
    const { startDirectWorker } = await import("../../local-agent/src/directWorker.js");
    const rootPath = path.join(root, "worker");
    const initialize = vi.fn();
    const store = { rootPath, initialize } as unknown as DirectWorkerStore;

    await expect(startDirectWorker({ store })).rejects.toThrow("Managed host fingerprint mismatch");

    expect(initialize).not.toHaveBeenCalled();
    await expect(access(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a conflicting managed bot token without disclosing either token", async () => {
    startup.assertManagedHost.mockResolvedValueOnce(undefined);
    process.env.DISCORD_TOKEN = "SYNTHETIC_FOREIGN_TOKEN";
    const { startBot } = await import("./index.js");

    const error = await startBot().then(() => null, cause => cause as Error);

    expect(error?.message).toContain("DISCORD_TOKEN conflicts with this managed host's provisioned bot");
    expect(error?.message).not.toContain("SYNTHETIC_FOREIGN_TOKEN");
    expect(error?.message).not.toContain("test-token");
    expect(startup.createDiscordClient).not.toHaveBeenCalled();
  });

  it("allows the same provisioned token in the managed environment", async () => {
    startup.assertManagedHost.mockResolvedValueOnce(undefined);
    process.env.DISCORD_TOKEN = "test-token";
    startup.createDiscordClient.mockImplementationOnce(() => { throw new Error("Client construction reached"); });
    const { startBot } = await import("./index.js");

    await expect(startBot()).rejects.toThrow("Client construction reached");

    expect(startup.createDiscordClient).toHaveBeenCalledOnce();
  });

  it("sanitizes malformed credential JSON before the host guard or client sees it", async () => {
    await writeFile(process.env.CONNECT_CONFIG_PATH!, '{"discord":{"token":SYNTHETIC_SECRET_TOKEN}}');
    const { startBot } = await import("./index.js");

    const error = await startBot().then(() => null, cause => cause as Error);

    expect(error?.message).toBe("Invalid connector configuration JSON. Check the file selected by CONNECT_CONFIG_PATH.");
    expect(error?.message).not.toContain("SYNTHETIC_SECRET_TOKEN");
    expect(startup.assertManagedHost).not.toHaveBeenCalled();
    expect(startup.createDiscordClient).not.toHaveBeenCalled();
  });
});
