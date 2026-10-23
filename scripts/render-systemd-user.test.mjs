import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderUnits, writeUnits } from "./render-systemd-user.mjs";

const options = { installDir: "/srv/agent checkout", home: "/home/worker", node: "/opt/node/bin/node", path: "/opt/node/bin:/usr/bin", codexHome: "/home/worker/.codex", claudeConfigDir: "/home/worker/.claude" };

test("separate user services preserve native configuration and isolate bot restart", () => {
  const units = renderUnits(options);
  const worker = units["ai-agent-discord-worker.service"];
  const bot = units["ai-agent-discord-bot.service"];
  assert.match(worker, /Environment="HOME=\/home\/worker"/);
  assert.match(worker, /Environment="CLAUDE_CONFIG_DIR=\/home\/worker\/\.claude"/);
  assert.match(worker, /ExecStart="\/opt\/node\/bin\/node" --import tsx "\/srv\/agent checkout\/apps\/local-agent\/src\/directWorker.ts"/);
  assert.match(worker, /KillMode=mixed\nTimeoutStopSec=infinity/);
  assert.match(bot, /Wants=ai-agent-discord-worker.service/);
  assert.doesNotMatch(worker, /PartOf=|BindsTo=|Requires=|DISCORD_TOKEN|User=root/);
  assert.doesNotMatch(bot, /PartOf=|BindsTo=|Requires=|DISCORD_TOKEN/);
});

test("escapes systemd specifiers and command environment expansion", () => {
  const units = renderUnits({ ...options, installDir: '/srv/100% $USER "dir"' });
  const worker = units["ai-agent-discord-worker.service"];
  assert.ok(worker.includes('WorkingDirectory=/srv/100%% $USER "dir"\n'));
  assert.match(worker, /ExecStart=.*100%% \$\$USER/);
  assert.throws(() => renderUnits({ ...options, prefix: "../../worker" }), /prefix/);
  assert.throws(() => renderUnits({ ...options, home: "relative" }), /absolute/);
  assert.throws(() => renderUnits({ ...options, path: "/usr/bin\nExecStart=evil" }), /control/);
});

test("repeated generation reuses identical files and refuses local edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdc-unit-test-"));
  try {
    const units = renderUnits(options);
    assert.equal((await writeUnits(directory, units)).created, 2);
    assert.equal((await writeUnits(directory, units)).created, 0);
    const bot = path.join(directory, "ai-agent-discord-bot.service");
    await writeFile(bot, "locally edited service\n");
    await assert.rejects(writeUnits(directory, units), /different content/);
    assert.equal(await readFile(bot, "utf8"), "locally edited service\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("does not follow destination symlinks or partially overwrite a pair", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cdc-unit-test-"));
  try {
    const outside = path.join(directory, "existing.txt");
    await writeFile(outside, "keep");
    await symlink(outside, path.join(directory, "ai-agent-discord-bot.service"));
    await assert.rejects(writeUnits(directory, renderUnits(options)), /different content/);
    await assert.rejects(readFile(path.join(directory, "ai-agent-discord-worker.service")), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), "keep");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
