import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access as accessPath, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildDirectConfig, renderEnvFile, type DirectConnectConfig } from "./config.js";

const safeText = z.string().trim().min(1).max(1024).refine(value => !/[\r\n\0"]/.test(value));
const snowflake = z.string().regex(/^\d{6,22}$/);
const channelName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const specSchema = z.object({
  schema: z.literal("cdc.host-spec.v1"),
  computerName: safeText,
  workspaceRoot: safeText.refine(path.isAbsolute, "workspaceRoot must be absolute"),
  initialCwd: safeText.refine(path.isAbsolute).optional(),
  workspaceName: safeText.optional(),
  codexHome: safeText.refine(path.isAbsolute).optional(),
  channels: z.object({ codex: channelName, claude: channelName.optional() }).strict(),
  locale: z.enum(["ko", "en", "zh", "ja"]).default("en"),
  maintenanceAgent: z.enum(["codex", "claude"]).default("codex"),
  agents: z.array(z.enum(["codex", "claude"])).min(1).max(2).optional(),
}).strict().refine(value => value.channels.codex !== value.channels.claude, "Channel names must differ")
  .refine(value => value.maintenanceAgent !== "claude" || !!value.channels.claude, "Claude maintenance needs a Claude channel")
  .refine(value => !value.agents || value.agents.includes(value.maintenanceAgent), "Maintenance agent must be selected")
  .refine(value => !value.agents?.includes("claude") || !!value.channels.claude, "Claude needs its own channel");
const accessSchema = z.object({
  schema: z.literal("cdc.discord-access.v1"),
  token: z.string().min(20).max(512).regex(/^[A-Za-z0-9._-]+$/),
  guildId: snowflake,
  allowedRoleIds: z.array(snowflake).min(1).max(50),
  locale: z.enum(["ko", "en", "zh", "ja"]).default("en"),
}).strict().refine(value => !value.allowedRoleIds.includes(value.guildId), "Do not authorize @everyone");

export type HostSpec = z.infer<typeof specSchema>;
export type DiscordAccess = z.infer<typeof accessSchema>;
export type HostRole = "codex" | "claude";
export interface ManagedHost {
  schema: "cdc.host.v1";
  installationId: string;
  computerId: string;
  fingerprint: string;
  preparedAt: string;
  spec: HostSpec;
}
export interface ProvisionReceipt {
  schema: "cdc.host-provision.v1";
  installationId: string;
  guildId: string;
  botUserId: string;
  allowedRoleIds: string[];
  status: "provisioning" | "ready" | "failed";
  channels: Partial<Record<HostRole, string>>;
  updatedAt: string;
  error?: string;
}
export interface ProvisionChannel {
  id: string;
  name: string;
  type: number;
  topic?: string | null;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
}
export interface HostDiscordApi {
  currentUser(): Promise<{ id: string; bot?: boolean }>;
  roleIds(guildId: string): Promise<string[]>;
  listChannels(guildId: string): Promise<ProvisionChannel[]>;
  createChannel(guildId: string, body: Omit<ProvisionChannel, "id">): Promise<ProvisionChannel>;
}
export type FingerprintProvider = (directory: string) => Promise<string>;
const canonicalJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function parseHostSpec(value: unknown): HostSpec {
  const parsed = specSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid host spec: use cdc.host-spec.v1 with absolute paths and distinct lowercase channel names; channel IDs, tokens and runtime state are not accepted.");
  return parsed.data;
}
export function parseDiscordAccess(value: unknown): DiscordAccess {
  const parsed = accessSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid access file: expected only schema, bot token, guildId, allowedRoleIds (not @everyone), and locale.");
  return { ...parsed.data, allowedRoleIds: [...new Set(parsed.data.allowedRoleIds)].sort() };
}

async function pathExists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
async function assertPrivateFile(filename: string): Promise<void> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular private file: ${filename}`);
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error(`File must be owned by the current user with mode 0600: ${filename}`);
  }
}
async function readJson(filename: string, privateFile = false): Promise<unknown> {
  if (privateFile) await assertPrivateFile(filename);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error(`Expected a JSON file smaller than 128 KiB: ${filename}`);
    try { return JSON.parse(await handle.readFile("utf8")) as unknown; }
    catch { throw new Error(`Invalid JSON file: ${filename}`); }
  } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writePrivate(filename: string, contents: string, exclusive = false): Promise<void> {
  if (exclusive) {
    const handle = await open(filename, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  } else {
    if (await pathExists(filename)) await assertPrivateFile(filename);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
  }
  await syncDirectory(path.dirname(filename));
}
async function managedDirectory(directory: string): Promise<string> {
  const resolved = await realpath(directory);
  const connect = path.join(resolved, ".connect");
  await mkdir(connect, { mode: 0o700, recursive: true });
  const stat = await lstat(connect);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(".connect must be a real directory, not a symbolic link.");
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) throw new Error(".connect must be owned by the current user.");
  await chmod(connect, 0o700);
  return resolved;
}
async function withHostLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(directory, ".connect", "host-operation.lock");
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another host operation holds host-operation.lock. If it crashed, verify that process has stopped before removing only that lock.");
    throw error;
  }
  try {
    await handle.writeFile(canonicalJson({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.sync();
    return await action();
  } finally { await handle.close(); await rm(lock); }
}

/** Detects accidental copies, not a global lease or a defense against cloned machine identities. */
export async function hostFingerprint(directory: string): Promise<string> {
  let machineId = "";
  if (process.platform === "linux") {
    for (const filename of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try { machineId = (await readFile(filename, "utf8")).trim(); if (machineId) break; } catch { /* hostname fallback */ }
    }
  }
  return sha256(JSON.stringify({ machineId, hostname: os.hostname(), platform: process.platform, uid: process.getuid?.() ?? os.userInfo().username, directory: await realpath(directory) }));
}
export async function readManagedHost(directory: string): Promise<ManagedHost | null> {
  const filename = path.join(directory, ".connect", "host.json");
  if (!await pathExists(filename)) return null;
  const parsed = z.object({
    schema: z.literal("cdc.host.v1"), installationId: z.string().uuid(), computerId: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), preparedAt: z.string(), spec: specSchema,
  }).strict().safeParse(await readJson(filename, true));
  if (!parsed.success || parsed.data.computerId !== `host-${parsed.data.installationId}`) throw new Error("Invalid managed host manifest.");
  return parsed.data;
}
async function checkedHost(directory: string, fingerprint: FingerprintProvider): Promise<ManagedHost> {
  const host = await readManagedHost(directory);
  if (!host) throw new Error("Run host prepare in a fresh target directory first; existing setups are not adopted.");
  if (host.fingerprint !== await fingerprint(directory)) throw new Error("Foreign or moved host configuration detected. Prepare a fresh target directory; do not copy .connect, .env or channel IDs.");
  return host;
}
async function readReceipt(directory: string): Promise<ProvisionReceipt | null> {
  const filename = path.join(directory, ".connect", "provision.json");
  if (!await pathExists(filename)) return null;
  const parsed = z.object({
    schema: z.literal("cdc.host-provision.v1"), installationId: z.string().uuid(), guildId: snowflake,
    botUserId: snowflake, allowedRoleIds: z.array(snowflake), status: z.enum(["provisioning", "ready", "failed"]),
    channels: z.object({ codex: snowflake.optional(), claude: snowflake.optional() }).strict(),
    updatedAt: z.string(), error: z.string().optional(),
  }).strict().safeParse(await readJson(filename, true));
  if (!parsed.success) throw new Error("Invalid host provisioning receipt.");
  return parsed.data;
}
export async function prepareHost(input: { directory: string; spec: unknown; fingerprint?: FingerprintProvider }): Promise<ManagedHost> {
  const spec = parseHostSpec(input.spec);
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const directory = await managedDirectory(input.directory);
  return withHostLock(directory, async () => {
    const existing = await readManagedHost(directory);
    if (existing) {
      await checkedHost(directory, input.fingerprint ?? hostFingerprint);
      if (canonicalJson(existing.spec) !== canonicalJson(spec)) throw new Error("This host was prepared with a different spec. Configuration migration is not automatic; keep the original spec.");
      return existing;
    }
    const contents = (await readdir(path.join(directory, ".connect"))).filter(name => name !== "host-operation.lock");
    if (contents.length || await pathExists(path.join(directory, ".env"))) throw new Error("Existing or copied configuration/runtime state found. Use a fresh target directory; host prepare never adopts or deletes an existing setup.");
    const installationId = randomUUID();
    const host: ManagedHost = {
      schema: "cdc.host.v1", installationId, computerId: `host-${installationId}`,
      fingerprint: await (input.fingerprint ?? hostFingerprint)(directory), preparedAt: new Date().toISOString(), spec,
    };
    await writePrivate(path.join(directory, ".connect", "host.json"), canonicalJson(host), true);
    return host;
  });
}
export async function exportAccess(configPath: string, outputPath: string): Promise<void> {
  // Only the explicit input is read; runtime state, channel IDs and agent logins are never exported.
  const config = await readJson(configPath, true) as { discord?: unknown };
  const discord = config?.discord as Partial<DiscordAccess> | undefined;
  const access = parseDiscordAccess({ schema: "cdc.discord-access.v1", token: discord?.token, guildId: discord?.guildId, allowedRoleIds: discord?.allowedRoleIds, locale: discord?.locale });
  await writePrivate(outputPath, canonicalJson(access), true);
}
export async function loadAccessFile(filename: string): Promise<DiscordAccess> {
  return parseDiscordAccess(await readJson(filename, true));
}
export function managedChannelMarker(installationId: string, role: HostRole): string {
  return `cdc-host:v1:${installationId}:${role}`;
}

// Discord permissions are serialized decimal bitfields (API v10).
const view = 1n << 10n;
const memberPermissions = view | (1n << 11n) | (1n << 16n) | (1n << 14n) | (1n << 15n) | (1n << 31n) | (1n << 38n);
const botPermissions = memberPermissions | (1n << 4n) | (1n << 34n) | (1n << 35n);
function expectedOverwrites(access: DiscordAccess, botUserId: string): NonNullable<ProvisionChannel["permission_overwrites"]> {
  return [
    { id: access.guildId, type: 0, allow: "0", deny: view.toString() },
    ...access.allowedRoleIds.map(id => ({ id, type: 0, allow: memberPermissions.toString(), deny: "0" })),
    { id: botUserId, type: 1, allow: botPermissions.toString(), deny: "0" },
  ];
}
function normalizeOverwrites(overwrites: ProvisionChannel["permission_overwrites"]): string {
  return JSON.stringify((overwrites ?? []).map(value => ({ id: value.id, type: value.type, allow: value.allow, deny: value.deny })).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)));
}
function validateChannel(channel: ProvisionChannel, expected: Omit<ProvisionChannel, "id">): void {
  if (!snowflake.safeParse(channel.id).success || channel.type !== 0 || channel.topic !== expected.topic || channel.name !== expected.name || normalizeOverwrites(channel.permission_overwrites) !== normalizeOverwrites(expected.permission_overwrites)) {
    throw new Error("Owned channel differs from the prepared name, topic, type or private role permissions. Review it manually; provision will not alter or adopt it.");
  }
}
function verifyReceiptIdentity(host: ManagedHost, receipt: ProvisionReceipt): void {
  if (receipt.installationId !== host.installationId || !receipt.channels.codex || (!!host.spec.channels.claude !== !!receipt.channels.claude)) throw new Error("Host receipt has incomplete or foreign channel ownership.");
}
function verifyConfig(host: ManagedHost, receipt: ProvisionReceipt, config: unknown): void {
  const value = config as Partial<DirectConnectConfig>;
  if (value?.mode !== "direct" || value.direct?.hostInstallationId !== host.installationId || value.direct.computerId !== host.computerId || value.direct.channelId !== receipt.channels.codex || value.direct.claudeChannelId !== receipt.channels.claude || value.discord?.guildId !== receipt.guildId || JSON.stringify([...(value.discord?.allowedRoleIds ?? [])].sort()) !== JSON.stringify([...receipt.allowedRoleIds].sort())) {
    throw new Error("Managed config does not match its host/channel receipt; copied or edited routing is not allowed.");
  }
}
export async function assertManagedHost(directory: string, expectedConfig?: unknown): Promise<void> {
  const config = expectedConfig !== undefined ? expectedConfig : (await pathExists(path.join(directory, ".connect", "config.json")) ? await readJson(path.join(directory, ".connect", "config.json")) : undefined);
  const sentinel = (config as { direct?: { hostInstallationId?: unknown } } | undefined)?.direct?.hostInstallationId;
  const host = await readManagedHost(directory);
  if (!host) {
    if (sentinel !== undefined) throw new Error("Managed config is missing its host manifest. Do not copy configuration to another server.");
    return;
  }
  await checkedHost(directory, hostFingerprint);
  const receipt = await readReceipt(directory);
  if (!receipt || receipt.status !== "ready") throw new Error("Host provisioning is incomplete. Complete host provision before starting services.");
  verifyReceiptIdentity(host, receipt);
  verifyConfig(host, receipt, config);
}
export async function provisionHost(input: { directory: string; access: DiscordAccess; api: HostDiscordApi; fingerprint?: FingerprintProvider }): Promise<ProvisionReceipt> {
  const directory = await realpath(input.directory);
  // Do not initialize a path during provision; it must have an existing valid prepare result.
  await checkedHost(directory, input.fingerprint ?? hostFingerprint);
  return withHostLock(directory, async () => {
    const host = await checkedHost(directory, input.fingerprint ?? hostFingerprint);
    const access = parseDiscordAccess(input.access);
    const previous = await readReceipt(directory);
    if (previous && (previous.installationId !== host.installationId || previous.guildId !== access.guildId || JSON.stringify(previous.allowedRoleIds) !== JSON.stringify(access.allowedRoleIds))) throw new Error("Access scope changed since provisioning. Guild/role migration is not automatic.");
    const configPath = path.join(directory, ".connect", "config.json");
    const envPath = path.join(directory, ".env");
    if (await pathExists(configPath)) {
      if (!previous) throw new Error("An unmanaged configuration appeared after prepare; refusing to overwrite it.");
      verifyReceiptIdentity(host, previous);
      verifyConfig(host, previous, await readJson(configPath, true));
    } else if (await pathExists(envPath) && !previous) throw new Error("An unmanaged .env appeared after prepare; refusing to overwrite it.");
    let receipt: ProvisionReceipt | null = null;
    let changedReceipt = false;
    const saveReceipt = async () => {
      if (!receipt) return;
      receipt.updatedAt = new Date().toISOString();
      await writePrivate(path.join(directory, ".connect", "provision.json"), canonicalJson(receipt));
      changedReceipt = true;
    };
    try {
      const bot = await input.api.currentUser();
      if (bot.bot !== true || !snowflake.safeParse(bot.id).success) throw new Error("The access token must belong to a Discord bot.");
      if (previous && previous.botUserId !== bot.id) throw new Error("The bot identity changed; automatic bot migration is disabled.");
      const roles = await input.api.roleIds(access.guildId);
      if (access.allowedRoleIds.some(id => !roles.includes(id))) throw new Error("An allowed role does not exist in this Discord guild.");
      const channels = await input.api.listChannels(access.guildId);
      receipt = { schema: "cdc.host-provision.v1", installationId: host.installationId, guildId: access.guildId, botUserId: bot.id, allowedRoleIds: access.allowedRoleIds, status: "provisioning", channels: { ...previous?.channels }, updatedAt: new Date().toISOString() };
      if (previous?.status !== "ready") await saveReceipt();
      for (const role of ["codex", "claude"] as const) {
        const name = host.spec.channels[role];
        if (!name) continue;
        const body = { name, type: 0, topic: managedChannelMarker(host.installationId, role), permission_overwrites: expectedOverwrites(access, bot.id) };
        const owned = channels.filter(channel => channel.topic === body.topic);
        if (owned.length > 1) throw new Error("Multiple channels claim this host and role; no channel was selected. Review duplicates manually.");
        const recorded = receipt.channels[role];
        let channel = owned[0];
        if (recorded && (!channel || channel.id !== recorded)) throw new Error("A recorded owned channel is missing or its ownership changed. No replacement channel will be created automatically.");
        if (!channel) {
          if (channels.some(candidate => candidate.name === name)) throw new Error("The requested channel name already exists without this host's ownership marker. Choose fresh names in a fresh host spec; it will not be reused.");
          channel = await input.api.createChannel(access.guildId, body);
          channels.push(channel);
        }
        validateChannel(channel, body);
        receipt.channels[role] = channel.id;
        if (previous?.status !== "ready") await saveReceipt();
      }
      verifyReceiptIdentity(host, receipt);
      const config = buildDirectConfig({
        token: access.token, guildId: access.guildId, roleIds: access.allowedRoleIds,
        channelId: receipt.channels.codex!, claudeChannelId: receipt.channels.claude,
        computerId: host.computerId, computerDisplayName: host.spec.computerName,
        workspaceRoot: host.spec.workspaceRoot, initialCwd: host.spec.initialCwd,
        workspaceDisplayName: host.spec.workspaceName, codexHome: host.spec.codexHome,
        locale: host.spec.locale, maintenanceAgent: host.spec.maintenanceAgent,
      });
      config.direct.hostInstallationId = host.installationId;
      const configText = canonicalJson(config);
      const envText = renderEnvFile(config);
      // Existing local customizations are never silently discarded, including .env additions.
      for (const [filename, expected] of [[configPath, configText], [envPath, envText]]) {
        if (await pathExists(filename)) {
          await assertPrivateFile(filename);
          if (await readFile(filename, "utf8") !== expected) throw new Error("Generated config or .env has local changes (or a different token). Provision will not overwrite them; review migration separately.");
        }
      }
      if (previous?.status === "ready" && await pathExists(configPath) && await pathExists(envPath)) return previous;
      await saveReceipt();
      // Receipt remains non-ready until both private files are durable. A retry repairs an interrupted pair.
      await writePrivate(configPath, configText);
      await writePrivate(envPath, envText);
      receipt.status = "ready";
      await saveReceipt();
      return receipt;
    } catch (error) {
      if (receipt && changedReceipt) {
        receipt.status = "failed";
        // Never persist error messages or Discord response bodies; they may contain request credentials.
        receipt.error = "Provisioning did not complete. Retry with the same host/access after resolving the reported issue; existing channels are preserved.";
        await saveReceipt();
      }
      throw error;
    }
  });
}
async function executablePath(command: string, environment: NodeJS.ProcessEnv): Promise<string | null> {
  const extensions = process.platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const folder of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const filename = path.resolve(folder, command + extension);
      try { await accessPath(filename, constants.X_OK); if ((await stat(filename)).isFile()) return filename; } catch { /* next PATH entry */ }
    }
  }
  return null;
}
export async function hostDoctor(directory: string, environment: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const host = await readManagedHost(directory);
  if (!host) throw new Error("No managed host manifest found; use host prepare in a fresh target directory.");
  await checkedHost(directory, hostFingerprint);
  const receipt = await readReceipt(directory);
  if (receipt?.status === "ready") await assertManagedHost(directory);
  const workspaceExists = !!(await stat(host.spec.workspaceRoot).catch(() => null))?.isDirectory();
  const initialCwdExists = !!(await stat(host.spec.initialCwd ?? host.spec.workspaceRoot).catch(() => null))?.isDirectory();
  const selected = host.spec.agents ?? (host.spec.maintenanceAgent === "claude" ? ["claude"] : host.spec.channels.claude ? ["codex", "claude"] : ["codex"]);
  const executables = Object.fromEntries(await Promise.all(selected.map(async name => [name, await executablePath(name, environment)])));
  const localReadyToStart = receipt?.status === "ready" && workspaceExists && initialCwdExists && Object.values(executables).every(Boolean);
  return { schema: "cdc.host-doctor.v1", scope: "local-only", computerId: host.computerId, installationId: host.installationId, ownership: "local-match", provisioning: receipt?.status ?? "not-started", workspaceExists, initialCwdExists, executables, nodeVersion: process.version, channels: receipt?.channels ?? {}, agentAuthentication: "not-checked", discordPermissions: "not-checked", localReadyToStart };
}
export async function loadHostSpec(filename: string): Promise<HostSpec> {
  return parseHostSpec(await readJson(filename));
}
