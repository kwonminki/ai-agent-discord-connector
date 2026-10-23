# Add a server without copying another server's identity

Use this workflow when a connector is already installed and the user asks to connect another machine over SSH. The connector remains a public, provider-neutral project; organization skills and private connection values stay outside its source tree.

If no local installation exists, ask whether the user has one on another machine. Continue there when possible. For a first installation, use the [AI Agent Guide](AI_AGENT_GUIDE.en.md) to create the Discord application, invite the bot, and identify the guild and Operator roles. These account actions cannot be replaced by copying somebody else's credentials.

## How the connection works

```text
Private Discord guild
  host-a-codex / host-a-claude -> gateway A -> durable worker A -> local agent CLI
  host-b-codex / host-b-claude -> gateway B -> durable worker B -> local agent CLI
```

Each host runs its own gateway and worker. Hosts may share the user's bot token, guild and Operator roles. Each host must have different parent channels and its own computer ID, queues, session state and installation manifest. There is no central hosted control service in this Direct-mode workflow.

Slash commands belong to the shared Discord application/guild, not to an individual host. When hosts share one bot, designate one existing host to publish the command definitions. On additional hosts, set `CONNECT_REGISTER_COMMANDS_ON_START=0` in the gateway service environment before starting it. The default remains enabled; disabling it skips only automatic startup registration and leaves message handling and existing commands available. Explicit `/reload commands` and `/reload restart` still publish this checkout's definitions, so run those actions only on the designated publisher; restart a follower through its service manager instead. Keep follower code compatible with the published command definitions, especially when the existing host has custom commands.

## 1. Inspect the source and target

Use the provided SSH connection, including its jump host or configured SSH alias. Preserve host-key verification. Inspect the target OS, execution user, workspace, Node/pnpm, agent CLI paths and existing connector services. For an existing installation, inspect active jobs and local changes before deciding whether it needs repair or an update.

Install the same tested connector commit with `pnpm install --frozen-lockfile`. Public HTTPS clone needs no GitHub private key:

```bash
git clone https://github.com/kwonminki/ai-agent-discord-connector.git
cd ai-agent-discord-connector
git checkout --detach VERIFIED_COMMIT
pnpm install --frozen-lockfile
```

Replace `VERIFIED_COMMIT` with a real reviewed revision. The managed-host commands described here are part of this source change; they are not yet available in the previously published v2.3.1 package. A local development checkout is not a published release.

Do not copy `.connect/`, `.env`, agent login directories, service units, or the whole modified checkout from the source host. Transfer only the selected access bootstrap described below and the nonsecret host specification. Install project code and skills from their own repositories.

## 2. Export the reusable Discord access

On the existing host, run from this connector checkout:

```bash
node bin/cdc.js host export-access \
  --config /absolute/existing-connector/.connect/config.json \
  --output /absolute/private/bootstrap-access.json
```

The mode-0600 output contains the bot token, guild ID, Operator role IDs and locale. It excludes channel IDs, computer identity, session state and queues. The input config must also be owned by the current user and private; use `chmod 600` on that file if necessary. Create the private output directory first. Transfer the output over the already authorized SSH connection into a private location on the target. Keep the token out of chat, command-line arguments, Git, service-unit contents and installation receipts. The exporter refuses to overwrite an existing file.

The target gateway needs this bot credential in Direct mode. OAuth approval for the agent CLIs is separate. No token registration in a company's shared credential registry is required for a personal Discord bot.

## 3. Prepare a new target identity

Create a nonsecret target specification, for example:

```json
{
  "schema": "cdc.host-spec.v1",
  "computerName": "GPU 02",
  "workspaceRoot": "/home/worker/projects",
  "initialCwd": "/home/worker/projects/my-project",
  "channels": {
    "codex": "gpu02-codex",
    "claude": "gpu02-claude"
  },
  "locale": "en"
}
```

Use the user's actual target paths. For Codex-only usage, omit `channels.claude`. The existing Direct routing format always requires the admin/Codex channel named by `channels.codex`. For Claude-only usage, keep both channel entries, set `agents: ["claude"]` and `maintenanceAgent: "claude"`, and use the Claude channel; the unused admin channel remains. This does not require installing or logging into Codex. Optional fields and validation are defined by `apps/connect-cli/src/host.ts`.

Run on the target from its new checkout:

```bash
node bin/cdc.js host prepare --dir "$PWD" --spec /absolute/host-spec.json
```

Preparation creates a private host manifest and a fresh installation identity; it does not contact Discord or start services. A matching repeat uses the same identity. A copied manifest, incompatible existing configuration or changed specification requires investigation rather than silently taking over channels.

## 4. Provision dedicated channels

```bash
node bin/cdc.js host provision --dir "$PWD" \
  --access-file /absolute/private/bootstrap-access.json
node bin/cdc.js host doctor --dir "$PWD"
```

Provisioning creates private text channels for the host and records the API-returned IDs in `.connect/config.json`. It recognizes its own channels by an installation-specific topic marker, not just a similar name. Repeating the same operation reuses those channels. Keep `.connect/host.json` and the provisioning receipt with this installation.

This is protection against accidental configuration copying, not a distributed lease. Discord channel creation and topic writes provide no cross-host compare-and-swap. A legacy gateway, a fully cloned machine identity, manually removed markers or an operator bypassing the workflow can still conflict. Do not start a second gateway on an existing host's parent channels. For intentional channel migration, stop and verify the old gateway first, then perform and record an explicit migration.

Local doctor checks describe local ownership, configuration, workspace paths and selected provider executables on PATH. A failed prerequisite gives exit code 1. `localReadyToStart` is not an agent-login, Discord-response or remote-permission check; these remain explicitly untested in the output.

## 5. Log in and install native skills as the service user

The gateway launches the target's own Codex/Claude Code. Native skills are discovered by those CLIs in their normal user/project locations. The connector's `/set_skill` catalog is a separate optional source of instructions; registering every installed skill in that catalog is unnecessary.

| Client | User skill folder | Project skill folder |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | `.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |

Preserve the actual worker's OS user, `HOME`, any custom `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, and session working directory. Install complete skill folders, including linked references. Check custom configuration directories against the installed CLI version. An existing long-running session may need a new session to discover a newly installed skill.

For Codex, check `codex login status`; if needed, use `codex login --device-auth` and let the user complete browser approval. For Claude Code, use the installed version's `claude auth status` / `claude auth login`, or launch `claude` for its interactive login. The browser approval and any returned code belong in the user's private terminal, not a shared channel. Do not copy another machine's OAuth state.

New or inherited connector guidance has no enabled connector skills. `attention-kind` remains the default output style. Explicit `/set_skill` choices remain saved; disable those individually or use `/skills_reset` at the appropriate scope. A thread may still inherit an explicit parent setting. `/pure` also disables the connector's style, but does not disable native CLI skills.

Official references: [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code authentication](https://code.claude.com/docs/en/authentication).

## 6. Generate separate Linux user services

On a Linux target with a working user systemd manager:

```bash
node scripts/render-systemd-user.mjs \
  --install-dir "$PWD" \
  --output-dir "$PWD/.connect/systemd" \
  --prefix ai-agent-discord
systemd-analyze --user verify .connect/systemd/*.service
```

This records the current Node executable, home and PATH and creates two unit files. Pass `--codex-home` or `--claude-config-dir` if the working agent setup uses those custom locations. The script accepts explicit overrides shown by `--help`. It generates files only; it never installs, enables, stops or restarts a service. Identical output is reusable; differing existing files are preserved and rejected for review.

After checking for pre-existing connector services and resolving any overlap, register the generated pair for the same OS user:

```bash
mkdir -p "$HOME/.config/systemd/user"
cp -n .connect/systemd/ai-agent-discord-*.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now ai-agent-discord-worker.service ai-agent-discord-bot.service
systemctl --user status ai-agent-discord-worker.service ai-agent-discord-bot.service --no-pager
```

Check that `cp -n` actually installed the intended files: it deliberately keeps existing ones. Use one service pair per installation. On a cloud host, user services need lingering to survive logout; inspect `loginctl show-user "$USER" -p Linger` and enable it through the host's administrator if needed. If no user systemd manager is available, use the existing platform guide's system service or process-manager setup, retaining the same user and separate worker/gateway processes.

Restart the bot alone for gateway changes. The worker uses graceful shutdown with no finite drain timeout; wait for active work before replacing it. These units do not tie the worker's lifetime to a bot restart. See [systemd execution settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) and [service settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

## 7. Verify and record completion

Confirm separate service PIDs and ready logs. In each enabled agent channel, create a new session, inspect `/where`, and send one short request that identifies its host and working directory. Ask it to read one installed skill and a linked reference without modifying anything. Restart only the bot and verify that the worker PID stays the same. Check that another host's channels are still handled by that host.

Record the target, execution user, source revision, Node/agent versions, channel URLs, service names, configuration location, checks performed and any pending login step. Keep tokens and OAuth codes out of the record. Local mocks or generated service files alone are not an end-to-end Discord test.

## Repair without accumulating private forks

For missing skills, compare the worker user's home/config paths, CLI executable and session cwd with the working terminal. For duplicate replies, identify the two gateways and their channel IDs; do not solve it by copying configuration again. For a failed provisioning retry, inspect the host receipt and existing ownership markers before creating anything manually.

Keep fixes generic in this public repository. Add a regression test for the demonstrated failure, record compatibility in the relevant guide, and submit the change through the normal contribution workflow. Keep personal host specifications, access files and company skill sources private. Apply a tested revision on another host instead of copying an uncommitted running checkout.
