import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertManagedHost, exportAccess, hostDoctor, hostFingerprint, loadAccessFile, managedChannelMarker,
  parseDiscordAccess, parseHostSpec, prepareHost, provisionHost, readManagedHost,
  type DiscordAccess, type HostDiscordApi, type ProvisionChannel,
} from "./host.js";
import { parseHostArgs, runHostCommand } from "./hostCommands.js";

const roots: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdc-host-test-"));
  roots.push(directory);
  return directory;
}
const access: DiscordAccess = { schema: "cdc.discord-access.v1", token: "mock_bot_token_NOT_A_REAL_SECRET_123", guildId: "100000000000000001", allowedRoleIds: ["100000000000000002"], locale: "en" };
const botId = "100000000000000003";
const spec = (directory: string) => ({ schema: "cdc.host-spec.v1", computerName: "Mock GPU server", workspaceRoot: directory, channels: { codex: "mock-codex", claude: "mock-claude" }, locale: "en" });
const read = async (directory: string, name: string) => JSON.parse(await readFile(path.join(directory, ".connect", name), "utf8"));
const privateJson = async (filename: string, value: unknown) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function fakeApi() {
  const channels: ProvisionChannel[] = [];
  const api: HostDiscordApi = {
    currentUser: vi.fn(async () => ({ id: botId, bot: true })),
    roleIds: vi.fn(async () => [...access.allowedRoleIds]),
    listChannels: vi.fn(async () => [...channels]),
    createChannel: vi.fn(async (_guild, body) => {
      const channel = { ...structuredClone(body), id: String(200000000000000000n + BigInt(channels.length)) };
      channels.push(channel);
      return channel;
    }),
  };
  return { api, channels };
}
async function prepared() {
  const directory = await temporary();
  const host = await prepareHost({ directory, spec: spec(directory) });
  return { directory, host };
}
async function ready() {
  const value = await prepared();
  const api = fakeApi();
  const receipt = await provisionHost({ directory: value.directory, access, api: api.api });
  return { ...value, ...api, receipt };
}
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("managed host preparation", () => {
  it("creates a private unique identity without credentials, config, channels, or runtime state; repeat is identical", async () => {
    const { directory, host } = await prepared();
    const repeated = await prepareHost({ directory, spec: spec(directory) });
    expect(repeated).toEqual(host);
    expect(host.computerId).toBe(`host-${host.installationId}`);
    expect(JSON.stringify(host)).not.toContain(access.token);
    expect((await stat(path.join(directory, ".connect"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, ".connect", "host.json"))).mode & 0o777).toBe(0o600);
    expect(await readManagedHost(directory)).toEqual(host);
    const other = await prepared();
    expect(other.host.installationId).not.toBe(host.installationId);
    await expect(stat(path.join(directory, ".connect", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(assertManagedHost(directory)).rejects.toThrow("incomplete");
  });
  it("refuses legacy configuration, arbitrary state, and .env rather than adopting it", async () => {
    for (const name of [".env", ".connect/config.json", ".connect/state.json"]) {
      const directory = await temporary();
      await mkdir(path.join(directory, ".connect"), { mode: 0o700 });
      await writeFile(path.join(directory, name), "original", { mode: 0o600 });
      await expect(prepareHost({ directory, spec: spec(directory) })).rejects.toThrow("fresh target");
      expect(await readFile(path.join(directory, name), "utf8")).toBe("original");
    }
  });
  it("rejects copied/moved hosts and changed specs", async () => {
    const { directory } = await prepared();
    const copy = await temporary();
    await cp(path.join(directory, ".connect"), path.join(copy, ".connect"), { recursive: true });
    await expect(prepareHost({ directory: copy, spec: spec(directory) })).rejects.toThrow("Foreign or moved");
    await expect(prepareHost({ directory, spec: { ...spec(directory), computerName: "changed" } })).rejects.toThrow("different spec");
    expect(await hostFingerprint(directory)).not.toBe(await hostFingerprint(copy));
  });
  it("rejects symlink state directories, token fields and copied channel IDs", async () => {
    const directory = await temporary();
    const other = await temporary();
    await symlink(other, path.join(directory, ".connect"));
    await expect(prepareHost({ directory, spec: spec(directory) })).rejects.toThrow("symbolic link");
    for (const extra of [{ token: access.token }, { channelId: "123456789" }, { state: {} }]) expect(() => parseHostSpec({ ...spec(directory), ...extra })).toThrow("Invalid host spec");
    expect(() => parseHostSpec({ ...spec(directory), channels: { codex: "same", claude: "same" } })).toThrow();
    expect(() => parseHostSpec({ ...spec(directory), computerName: 'line\nDISCORD_TOKEN="bad' })).toThrow();
  });
  it("supports every connector locale and explicit Claude-only local readiness checks", () => {
    for (const locale of ["en", "ko", "zh", "ja"]) {
      expect(parseHostSpec({ ...spec("/tmp"), locale, maintenanceAgent: "claude", agents: ["claude"] }).locale).toBe(locale);
    }
    expect(() => parseHostSpec({ ...spec("/tmp"), maintenanceAgent: "claude", agents: ["codex"] })).toThrow();
  });
});

describe("access export", () => {
  it("exports only shared Discord access with owner-only mode and never overwrites a destination", async () => {
    const directory = await temporary();
    const source = path.join(directory, "config.json");
    const output = path.join(directory, "access.json");
    await privateJson(source, { discord: { token: access.token, guildId: access.guildId, allowedRoleIds: access.allowedRoleIds, locale: "ja" }, direct: { channelId: "do-not-export", computerId: "foreign", codexHome: "/do-not-export" } });
    await exportAccess(source, output);
    expect(await loadAccessFile(output)).toEqual({ ...access, locale: "ja" });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(exportAccess(source, output)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(output, "utf8")).not.toContain("do-not-export");
  });
  it("rejects public files, symlinks, extra fields and @everyone role access", async () => {
    const directory = await temporary();
    const filename = path.join(directory, "access.json");
    await privateJson(filename, access);
    await chmod(filename, 0o644);
    await expect(loadAccessFile(filename)).rejects.toThrow("0600");
    await chmod(filename, 0o600);
    await symlink(filename, path.join(directory, "link.json"));
    await expect(loadAccessFile(path.join(directory, "link.json"))).rejects.toThrow("regular private");
    expect(() => parseDiscordAccess({ ...access, channelId: "old" })).toThrow("Invalid access");
    expect(() => parseDiscordAccess({ ...access, allowedRoleIds: [access.guildId] })).toThrow("Invalid access");
  });
});

describe("Discord provisioning through a mocked API", () => {
  it("creates separate private owned channels, writes guarded config, and repeats without writes or duplicate channels", async () => {
    const { directory, host, api, channels, receipt } = await ready();
    expect(channels).toHaveLength(2);
    const config = await read(directory, "config.json");
    expect(config.direct.hostInstallationId).toBe(host.installationId);
    expect(config.direct.channelId).not.toBe(config.direct.claudeChannelId);
    expect(channels[0].topic).toBe(managedChannelMarker(host.installationId, "codex"));
    const overwrites = channels[0].permission_overwrites!;
    expect(overwrites.find(value => value.id === access.guildId)?.deny).toBe(String(1n << 10n));
    expect(BigInt(overwrites.find(value => value.id === botId)!.allow) & (1n << 35n)).not.toBe(0n);
    const originalReceipt = await readFile(path.join(directory, ".connect", "provision.json"), "utf8");
    expect(await provisionHost({ directory, access, api })).toEqual(receipt);
    expect(await readFile(path.join(directory, ".connect", "provision.json"), "utf8")).toBe(originalReceipt);
    expect(api.createChannel).toHaveBeenCalledTimes(2);
    await expect(assertManagedHost(directory, config)).resolves.toBeUndefined();
    expect((await stat(path.join(directory, ".env"))).mode & 0o777).toBe(0o600);
  });
  it("rejects unowned matching names and ambiguous owner markers", async () => {
    const { directory, host } = await prepared();
    const { api, channels } = fakeApi();
    channels.push({ id: "300000000000000001", name: "mock-codex", type: 0, topic: "some other host" });
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("without this host");
    expect(api.createChannel).not.toHaveBeenCalled();
    channels[0].topic = managedChannelMarker(host.installationId, "codex");
    channels.push({ ...channels[0], id: "300000000000000002" });
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("Multiple channels");
  });
  it("recovers a partial two-channel operation without duplicating the first channel", async () => {
    const { directory } = await prepared();
    const { api, channels } = fakeApi();
    const original = api.createChannel;
    let fail = true;
    api.createChannel = vi.fn(async (guild, body) => {
      if (body.name === "mock-claude" && fail) throw new Error("simulated API failure");
      return original(guild, body);
    });
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("simulated");
    expect(channels).toHaveLength(1);
    expect((await read(directory, "provision.json")).status).toBe("failed");
    await expect(stat(path.join(directory, ".connect", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    fail = false;
    await provisionHost({ directory, access, api });
    expect(channels).toHaveLength(2);
    await expect(assertManagedHost(directory)).resolves.toBeUndefined();
  });
  it("recovers a lost create response by exact owner topic without persisting the raw API error", async () => {
    const { directory } = await prepared();
    const { api, channels } = fakeApi();
    const original = api.createChannel;
    let loseResponse = true;
    api.createChannel = vi.fn(async (guild, body) => {
      const value = await original(guild, body);
      if (loseResponse) { loseResponse = false; throw new Error(access.token); }
      return value;
    });
    await expect(provisionHost({ directory, access, api })).rejects.toThrow(access.token);
    expect(await readFile(path.join(directory, ".connect", "provision.json"), "utf8")).not.toContain(access.token);
    await provisionHost({ directory, access, api });
    expect(channels).toHaveLength(2);
  });
  it("does not recreate deleted owned channels or mutate ready receipt on read-only verification failure", async () => {
    const { directory, api, channels } = await ready();
    const before = await readFile(path.join(directory, ".connect", "provision.json"), "utf8");
    channels.splice(0, 1);
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("recorded owned channel");
    expect(api.createChannel).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(directory, ".connect", "provision.json"), "utf8")).toBe(before);
  });
  it("rejects changed privacy, bot identity and guild roles", async () => {
    const { directory, api, channels } = await ready();
    channels[0].permission_overwrites = [];
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("private role permissions");
    vi.mocked(api.currentUser).mockResolvedValue({ id: "400000000000000001", bot: true });
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("bot identity changed");
    vi.mocked(api.currentUser).mockResolvedValue({ id: botId, bot: true });
    vi.mocked(api.roleIds).mockResolvedValue([]);
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("role does not exist");
  });
  it("refuses to overwrite local .env customizations or token changes", async () => {
    const { directory, api } = await ready();
    const filename = path.join(directory, ".env");
    const original = await readFile(filename, "utf8");
    await writeFile(filename, original + "LOCAL_SETTING=keep\n");
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("local changes");
    expect(await readFile(filename, "utf8")).toBe(original + "LOCAL_SETTING=keep\n");
    await writeFile(filename, original);
    await expect(provisionHost({ directory, access: { ...access, token: "another_mock_token_not_a_real_secret" }, api })).rejects.toThrow("different token");
  });
  it("serializes provisioning on one installation and refuses a concurrent operation", async () => {
    const { directory } = await prepared();
    const { api } = fakeApi();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    api.currentUser = async () => { entered(); await pending; return { id: botId, bot: true }; };
    const first = provisionHost({ directory, access, api });
    await started;
    await expect(provisionHost({ directory, access, api })).rejects.toThrow("host-operation.lock");
    release();
    await first;
  });
});

describe("startup and local doctor", () => {
  it("rejects foreign copies, edited channel routing, missing manifest and explicitly missing actual config", async () => {
    const { directory } = await ready();
    const config = await read(directory, "config.json");
    await expect(assertManagedHost(directory, null)).rejects.toThrow("does not match");
    await expect(assertManagedHost(directory, { ...config, direct: { ...config.direct, channelId: "999999999999999999" } })).rejects.toThrow("does not match");
    const copy = await temporary();
    await cp(path.join(directory, ".connect"), path.join(copy, ".connect"), { recursive: true });
    await expect(assertManagedHost(copy, config)).rejects.toThrow("Foreign or moved");
    await rm(path.join(directory, ".connect", "host.json"));
    await expect(assertManagedHost(directory, config)).rejects.toThrow("missing its host manifest");
    await expect(assertManagedHost(copy, config)).rejects.toThrow();
    const legacy = await temporary();
    await expect(assertManagedHost(legacy, { mode: "direct", direct: { computerId: "local-dev" } })).resolves.toBeUndefined();
  });
  it("checks initial cwd and selected executable paths without claiming login/network readiness", async () => {
    const { directory } = await ready();
    const empty = await hostDoctor(directory, { PATH: "" });
    expect(empty.localReadyToStart).toBe(false);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    for (const command of ["codex", "claude"]) await writeFile(path.join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const report = await hostDoctor(directory, { PATH: bin });
    expect(report).toMatchObject({ localReadyToStart: true, scope: "local-only", agentAuthentication: "not-checked", discordPermissions: "not-checked", initialCwdExists: true });
    const other = await temporary();
    await prepareHost({ directory: other, spec: { ...spec(other), initialCwd: path.join(other, "missing") } });
    const { api } = fakeApi();
    await provisionHost({ directory: other, access, api });
    expect(await hostDoctor(other, { PATH: bin })).toMatchObject({ initialCwdExists: false, localReadyToStart: false });
  });
});

describe("noninteractive CLI", () => {
  it("prints help without reading or changing an installation", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    await runHostCommand(["--help"]);
    expect(output.mock.calls.flat().join("\n")).toContain("host export-access");
    expect(output.mock.calls.flat().join("\n")).toContain("host provision");
    expect(process.exitCode ?? 0).toBe(0);
  });
  it("accepts exact options without dropping equals signs and rejects token/ID/unknown/repeated options", () => {
    expect(parseHostArgs(["prepare", "--dir=/tmp/a=b", "--spec", "/tmp/spec.json"]).flags.get("dir")).toBe("/tmp/a=b");
    for (const args of [["provision", "--token", access.token], ["prepare", "--channel-id", "123"], ["doctor", "--dir", "/a", "--dir", "/b"], ["doctor", "extra"], ["prepare", "--spec"]]) expect(() => parseHostArgs(args)).toThrow();
  });
  it("fails missing flags without a prompt and returns non-ready doctor exit1", async () => {
    await expect(runHostCommand(["prepare"])).rejects.toThrow("requires --spec");
    const { directory } = await prepared();
    vi.spyOn(console, "info").mockImplementation(() => {});
    await runHostCommand(["doctor", "--dir", directory]);
    expect(process.exitCode).toBe(1);
  });
});
