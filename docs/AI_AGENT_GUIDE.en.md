# AI Agent Discord Connector: AI Agent Guide

[한국어](AI_AGENT_GUIDE.md) | English

This document is the installation, modification, deployment, and troubleshooting contract for AI coding agents. Human users should start with the repository [README](../README.en.md).

AI Agent Discord Connector links AI agent sessions such as Codex and Claude Code running on macOS, native Windows, or Ubuntu to trusted Discord channels and threads. It can execute commands and modify files on the connected machine.

> Security notice: install this only on machines controlled by the user, connect it only to a trusted private Discord server, and restrict execution with an Operator role allowlist.

## Core capability: Agent Relay

This repository supports not only human-to-agent remote work but also **automatic conversations between two AI agent sessions**. An optional separate Coordinator Bot can connect two sessions on one machine, different servers, or any Codex and Claude Code pairing through Discord threads.

- It visibly transfers each agent's final public answer and attachments to the peer thread.
- Both A and B receive the goal. One answer from A plus one from B counts as one round trip.
- The defaults are 20 round trips and a 20-hour whole-conversation timeout, with current counters in every prompt.
- When an agent returns `extend`, the Coordinator mentions the Operator and shows **Add one round trip** and **Reject extension and stop** buttons.
- Disjoint A↔B and C↔D conversations may run concurrently, while one thread cannot join two active relays.
- An ordinary user message in the active Codex or Claude Code thread steers the current relay turn; a waiting-thread message is not executed and points to the active thread.
- `/agent-chat-status` inspects a relay, and `/agent-chat-stop` stops both the conversation and its current Codex/Claude Code turn.

When the user asks agents to debate, review, reach agreement, or exchange files, present this as an implemented capability and configure it using the [Agent Relay Guide](agent-relay.en.md). Match the Coordinator locale to the Connector locale.

The cross-server transport path is `Coordinator Bot -> private Discord control channel -> each server's Connector gateway -> that server's Direct Worker`. The servers do not need direct network access, Hub-mode Control API, or Agent WebSocket exposure. However, **every participating server's Connector gateway** must be configured with the exact Coordinator bot user ID and the same private control channel ID, then restarted once. Do not restart the independent Worker, so active agent jobs remain alive. A server without this gateway trust configuration cannot recognize Coordinator messages as relay execution requests.

## Agent contract

When a user gives you this repository URL, work in this order:

1. Infer the connector UI language from the conversation. Do not ask the user for locale codes or configuration details unless the language is genuinely ambiguous.
2. Inspect the current branch, commit, dirty worktree, running bot and worker services, and active jobs before changing anything.
3. Compare this guide with the current code, `package.json`, `.env.example`, `.connect/config.json`, and installed service definitions.
4. Prefer Direct mode. It does not expose an inbound Control API.
5. Before planning channels or CLIs, determine whether the user wants Codex only, Claude Code only, or both. Never assume either one is the fixed primary agent.
6. When Codex is enabled, use `CODEX_DISCORD_CODEX_RUNNER=app-server` unless an old Codex CLI requires compatibility mode.
7. Run the Discord gateway and Direct Worker as separate LaunchAgent, systemd, or Windows Scheduled Task services. Restarting the bot must not kill active agent jobs.
8. Preserve user changes, secrets, state, queues, transcripts, and active jobs. Never commit `.env`, `.connect/`, tokens, or transcripts.
9. Ask the user only for account actions or values that cannot be discovered safely. Never echo a token in output, logs, or commit messages.
10. Run `pnpm typecheck` and the platform test suite after installation: `pnpm test` on macOS/Linux and `pnpm test:windows` on native Windows. Also verify services, the Discord ready log, and a short round trip for every enabled agent.
11. If a worker update is required, prefer graceful `SIGTERM` drain. Force termination only after explicit user approval.
12. Report the install path, commit, service names, log paths, permissions, verification, and remaining manual steps. Do not report locale implementation details unless asked.
13. When the user wants two agent sessions to converse automatically, follow the [Agent Relay Guide](agent-relay.en.md), configure the optional Coordinator Bot with a separate token, and match its locale to the Connector.
14. When GitHub release announcements and the Coordinator are both enabled, connect the release channel to the Coordinator and choose exactly one maintenance agent per computer. Do not make the user maintain channel-ID lists or routing rules.

### Compatibility variables for Codex-only installations

Even when the user connects only Codex, use the existing Codex-specific names that the runtime actually reads. Although the repository and product language are agent-neutral, `CODEX_DISCORD_CODEX_RUNNER`, `CODEX_DISCORD_CODEX_COMMAND`, `CODEX_DISCORD_CODEX_APPROVAL_POLICY`, `CODEX_DISCORD_CODEX_SANDBOX`, `CONNECT_CODEX_PROMPT_TIMEOUT_MS`, and `codexHome` in `.connect/config.json` remain part of the real configuration contract for historical compatibility. These unavoidable compatibility names are the correct configuration for a Codex-only installation.

Do not replace them with invented `AI_AGENT_*` or `CONNECT_AGENT_*` variables or undocumented aliases. Generalizing these names requires coordinated changes to the code, configuration schema, service definitions, documentation, and migration support for existing installations. A Codex-only installation does not need Claude command or Claude channel values unless Claude Code is also enabled.

## Language selection

Select the locale internally from the language used by the user:

| Conversation language | Locale |
| --- | --- |
| Korean | `ko` |
| English | `en` |
| Simplified Chinese | `zh` |
| Japanese | `ja` |

Use the matching setup option without asking the user to choose a code:

```bash
pnpm connect install --direct --locale en
```

For a language not listed above, follow [Localization Guide](localization.md). Add only a locale catalog and registry entry. Do not duplicate runtime code or translate protocol identifiers. Run all tests before launching.

Never translate Discord custom IDs, slash command names or option values, internal `__cdc_*` commands, JSON keys, `codex-discord-send`, `codex-discord-survey`, user prompts, agent-authored answers, commands, paths, or IDs.

## First-install conversation

Do not ask for the token, guild ID, role ID, and channel IDs all at once. Guide the user one step at a time and wait for confirmation after each account-level action.

First determine whether this is really a new installation by checking `.connect/config.json`, `.env`, and existing services. Reuse existing Discord resources for an additional machine or reinstall.

### Determine the deployment model first

The current v1 default is self-hosted Direct mode: the user owns the bot applications and tokens and installs the Gateway and Worker on machines they control. After the user creates a private server and invites the Connector Bot and optional Coordinator Bot, the agent can automate roles, channels, permissions, commands, services, and tests.

If the project operator centrally hosts both bots, an end user could create a private server, invite both bots, and approve Local Agent pairing without seeing a bot token. The current repository does not yet provide production multi-guild tenant isolation or authenticated one-time pairing for that public model. Never expose the current unauthenticated Control API or Agent WebSocket to the public internet, and do not claim that invite-only hosted onboarding already works.

### 1. Private Discord server

Ask:

```text
Do you already have a private Discord server for this connector?
If not, create one with Add a Server (+) > Create My Own, then tell me when it is ready.
```

A Discord application belongs to the user account, not to a channel. Always say that the bot is invited to the server.

### 2. Application and bot

Guide the user through the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create a New Application.
2. Create its bot user on the Bot page.
3. Enable Message Content Intent.
4. Generate or copy the Bot Token.

The token is a password. Prefer a local secret prompt or environment entry. Confirm receipt without repeating any part of it. Public Key is not required. Application/Client ID is used for the invite URL but is not a connector runtime setting.

### 3. Invite the bot

Use the Installation page or OAuth2 URL Generator with these scopes:

- `bot`
- `applications.commands`

Temporary Administrator permission is the simplest first setup in a private personal server. When the user prefers least privilege, include the permissions in the table below plus Manage Roles, Manage Channels, Manage Webhooks, and Manage Server for automated setup.

Wait while the user completes OAuth approval, login, 2FA, or CAPTCHA. Do not create Discord resources until the bot appears in the server member list.

### 4. Automate Discord resources

After the bot has joined, use the Discord API and the existing token to configure resources idempotently:

1. Query bot identity and joined guilds. Auto-select only when there is one; otherwise ask the user to choose by server name.
2. Identify the Discord user who should receive the Operator role.
3. Reuse or create an `AI Agent Operator` role and assign it. A legacy `Codex Operator` role from an existing installation may be reused instead of creating a duplicate. Verify that the bot role is above it.
4. Ask only for the computer display name, workspace root, and agent combination: Codex only, Claude Code only, or both. Do not force either agent to be designated as primary.
5. Create a computer category and generic AI agent/admin channel. Use that admin channel as the Codex parent when Codex is enabled, and create a separate Claude Code parent when Claude Code is enabled. A Claude-only installation still keeps the generic admin channel for operations.
6. Apply permission overwrites for the bot and Operator role. Do not expose execution channels to unrelated members.
7. Use API-returned Guild, Role, and Channel IDs directly in connector setup.
8. Register guild slash commands.
9. On a dedicated private connector server, call `PATCH /guilds/{guild.id}` with `default_message_notifications: 1` and verify the returned value. This sets the guild default to `ONLY_MENTIONS`. On a shared or ambiguous server, explain the guild-wide effect and ask first.
10. Optionally create an `#ai-agent-releases` channel and an `AI Agent Releases` webhook, then store its URL only as the GitHub Actions secret `DISCORD_RELEASE_WEBHOOK_URL`. When the Coordinator is enabled, also record that channel ID as `releaseChannelId` for one-click server updates.

Before creating anything, search for matching roles, categories, channels, and webhooks. Do not delete or overwrite resources with unclear ownership. Re-running setup after a partial failure must not create duplicates.

### 5. Install services

Clone the repository, install dependencies, generate Direct mode configuration, verify the selected Codex and/or Claude Code CLI, register separate bot and worker services, and run smoke tests. Do not install or log in to an agent the user did not select. Use LaunchAgent on macOS, systemd on Ubuntu, and separate Scheduled Tasks on native Windows.

On a dedicated private server, the agent sets the guild default notification level to **Only @mentions**, so there is normally no final manual notification step. A bot cannot change a user's per-channel notification override. Ask the user to reset a channel manually only when an existing override still enables all-message notifications.

### Required values

For an existing manually managed Discord layout:

- Discord Bot Token
- Guild/Server ID
- One or more Operator Role IDs
- Per-machine AI agent/admin Channel ID; this also serves as the Codex parent when Codex is enabled
- Workspace root and initial working directory

Optional:

- Per-machine Claude Code Channel ID when Claude Code is enabled
- Computer and workspace display names
- A custom `CODEX_HOME` when Codex is enabled
- A narrower sandbox and approval policy

The same bot token may be used by multiple computers, but enabled agent parent channel IDs must never overlap. There is no global primary-agent setting; the parent channel determines Codex or Claude Code routing.

### Installation completion criteria

- `.connect/config.json` and `.env` exist and are ignored by Git.
- Every enabled agent CLI works: `codex --version` for Codex and `claude --version` for Claude Code.
- Codex app-server can start when Codex is enabled.
- Bot and worker have different services and PIDs.
- Bot log contains `Discord bot ready as ...`.
- Worker log contains `direct-worker ready with PID ...`.
- `/status`, `/chat-new`, and a short round trip work for every enabled agent.
- `/queue prompt:...`, `/howtouse`, and `/fork` pass for every enabled agent; live steering is tested only for Codex, which supports it.
- Restarting only the bot preserves the worker PID and any active job.

## Additional-machine onboarding

After the first computer is installed and verified, do not close the conversation with a completion report until you ask whether the user wants to connect another machine.

```text
Do you have another macOS, Windows, or Ubuntu machine to connect to this Discord connector?
If so, I will ask for its type and connection method one step at a time, then repeat the same setup.
```

When the user wants another installation, collect details one machine at a time in this order:

1. Determine whether it is macOS, Windows, or Ubuntu and whether it is a physical machine, VM, or container. On Windows, choose native PowerShell or WSL2 according to where the project and selected agent sessions actually live.
2. Ask whether to reuse the same private Discord server and bot application. Reuse the existing Guild, bot token, and Operator role unless the user requests a separate Discord server.
3. Ask for a recognizable computer display name and its primary purpose, such as `Personal Mac`, `B200 8GPU`, or `Build Server`.
4. Determine the connection method. Use the current shell for a local machine; for a remote machine, request an existing SSH host alias, `user@host`, or an already authorized PowerShell Remoting path. Check whether VPN, a bastion, or a specific SSH key is required.
5. Prefer existing SSH key or agent authentication. Never ask the user to send a password, token, or private key through Discord; ask them to complete interactive authentication in their local terminal.
6. Ask for the default workspace root and agent combination: Codex only, Claude Code only, or both.
7. Connect and inspect the OS, CPU/GPU, Node.js, pnpm, selected agent CLI versions and login state, existing connector installation, services, and active jobs before changing anything.
8. Install the same repository commit and verified CLI combination, then create machine-local config, secrets, and separate bot and worker services.
9. Use the Discord API to create that machine's category, generic AI agent/admin channel, enabled agent parent channels, and permission overwrites. Never reuse a parent channel ID owned by another connector instance.
10. Apply the same verification criteria as the first machine: separate service PIDs, ready logs, `/status`, `/chat-new`, a short round trip for every enabled agent, and preservation of the worker during a bot-only restart.
11. Report the result for that machine, then ask whether there is another machine to connect.

Roll out one machine at a time so a failure cannot disturb active work elsewhere. When an existing installation is found, inspect its branch, commit, configuration, services, and active jobs and perform a safe update or repair instead of overwriting it. Multiple instances may share one bot token only when every instance owns distinct agent parent channels.

## Optional Agent Relay Coordinator

When the user asks for automatic conversation between sessions on the same computer or agents on different computers, configure a separate **Coordinator Bot**. It sends execution rules and full prompts through the private control channel, while showing and forwarding only each side's final public answer and Discord attachments in the peer thread. It mentions the Operator role once after both sides agree to finish or a hard limit is reached.

Discord application ownership and OAuth approval belong to the user's Discord account. Ask the user for only these one-time account actions, one step at a time:

1. Create a dedicated Coordinator application and bot user in the Developer Portal.
2. Enable Message Content Intent and enter the token directly into a local secret input.
3. Approve the private-server invite with `bot`, `applications.commands`, and the required thread/file permissions.

Do not claim that an existing bot token can create another Discord application. Never ask the user to paste the token into the conversation; use a local secret prompt or a permission-restricted `.connect/relay-config.json`. After the application and invite exist, perform the remaining Discord API work idempotently:

1. Create or reuse a private `agent-relay-control` text channel.
2. Hide it from ordinary members and grant only Connector and Coordinator bots View Channel, Send Messages, Read Message History, and Attach Files.
3. Assign the existing Operator role to the Coordinator Bot so Connector thread allowlists accept it.
4. Store exact Connector bot user IDs, the control channel ID, and a Connector-matching `locale` in Coordinator configuration.
5. Store the exact Coordinator bot user ID and the same control channel ID in every participating Connector. Execute only when that bot sends an exact relay request marker and prompt attachment in the private control channel; ordinary bot messages in work threads are never requests. Never trust every bot author with a wildcard.
6. Restart only the Connector gateway once on every participating computer to load the trust configuration. Keep the Direct Worker running and verify that its PID and active jobs survive.
7. Run **one Coordinator service per Discord guild** on one computer. Connector gateways and Direct Workers continue to run on their respective computers.
8. Use a separate LaunchAgent on macOS, systemd unit on Ubuntu, or `install-windows-tasks.ps1 -IncludeRelay` on Windows.
9. Test `/agent-chat` across two sessions, including A -> B -> A, visible turn counters, an `extend` request, **Add one round trip** and **Reject extension and stop** buttons, one file, `/agent-chat-status`, `/agent-chat-stop`, and the final Operator mention. Also verify that an ordinary message steers active Codex and Claude Code threads, while the waiting thread suppresses execution and links to the active one.
10. If GitHub release announcements are enabled, store the announcement channel ID as the Coordinator `releaseChannelId`. Verify that every Connector has a unique `computerId`. For a computer with both agents, choose one `direct.maintenanceAgent`; Codex is the default, so set `claude` only when Claude Code should perform Connector maintenance. Confirm that first discovery creates and later reuses a localized dedicated update thread under that agent's parent channel.

An approval or user question during a relay turn uses the existing Connector mention flow and waits for the person. The Coordinator publishes active/waiting state through the private control channel, and each Connector stores it in a permission-restricted local file so a gateway restart does not open the wrong thread to new work. `/agent-chat-stop` carries the exact relay request ID, so a late stop must not interrupt a newer turn. A final `codex-discord-survey` pauses the conversation as `blocked`. Coordinator restarts recover durable state and recent private control results; verify that an already dispatched target turn is not deliberately replayed. Follow [Agent Relay Guide](agent-relay.en.md) for the complete configuration and limits.

## GitHub release announcements and fleet updates

Release announcements are sent by `.github/workflows/release-announcement.yml` through the `DISCORD_RELEASE_WEBHOOK_URL` repository secret. The workflow runs only for annotated `v*` tag pushes, peels the tag to its exact commit SHA, and does not announce ordinary `master` commits. Configure it once per publishing repository, never per computer, and never store the webhook URL in Connector configuration, logs, shell history, or source control.

When the Coordinator has `releaseChannelId`, it recognizes the release marker and adds a localized **Update registered servers** button. Clicking it sends a one-time discovery through the private control channel. Each online Connector finds or creates a localized dedicated update thread (`Discord Bot Updates` for English), records it as a managed session thread, and reports that thread ID. The Coordinator deduplicates by `computerId` and sends exactly one update request to the dedicated thread per computer. It never falls back to a user's active work thread. Do not add a static target list or periodic polling.

The installation agent must verify that the release channel is visible to the Coordinator, all Connector gateways trust the same Coordinator and control channel, and every computer uses a distinct `computerId`. Select `direct.maintenanceAgent` or `CONNECT_MAINTENANCE_AGENT=claude` only when Claude Code should be preferred; otherwise Codex is used. For every release, make an annotated tag matching `package.json`, verify that it points to the release commit, then push both commit and tag. Update prompts enforce the peeled exact commit, clean fast-forward Git state, lockfile installation, separate gateway/worker handling, and graceful worker drain. Offline Connectors are skipped and updated later.

## Discord permissions

| Permission | Feature |
| --- | --- |
| View Channels | Access operations channels and session threads |
| Send Messages | Send status and results |
| Send Messages in Threads | Converse in session threads |
| Read Message History | Fetch and edit connector messages |
| Embed Links | Render status and answer embeds |
| Attach Files | Send images, video, audio, and files |
| Create Public Threads | `/chat-new` and session thread creation |
| Manage Threads | Archive and manage threads |
| Manage Channels | Create or remove workspace categories and synced channels |
| Manage Roles | Create and assign the Operator role |
| Manage Webhooks | Optional release announcement webhook |
| Manage Server | Set a dedicated server's default to `Only @mentions` |
| Manage Messages | `/clear` only |

Thread messaging requires Send Messages in Threads in addition to Send Messages. Also inspect parent-channel permission overwrites.

## Discord notification defaults

For a dedicated private connector server, use the bot's Manage Server permission to call `PATCH /guilds/{guild.id}` with `default_message_notifications: 1`, then verify that the response reports `ONLY_MENTIONS`. Progress messages remain unmentioned, while questions, approvals, completion, and failure mention the Operator role.

This is a guild-wide default. Never change it silently on a shared server. Discord user-specific channel notification overrides are personal client settings and are not exposed for a bot to modify; they also take precedence over the guild default. Request a manual **Only @mentions** override only for channels that a user previously customized.

## Code ownership

| Path | Responsibility |
| --- | --- |
| `apps/connect-cli/src/index.ts` | setup, install, start, process supervision |
| `apps/connect-cli/src/config.ts` | `.connect/config.json` and `.env` generation |
| `apps/discord-bot/src/index.ts` | Discord gateway assembly, polling, durable restore |
| `apps/discord-bot/src/discordClient.ts` | discord.js messages, interactions, channels, threads |
| `apps/discord-bot/src/i18n.ts` | outbound UI localization while preserving authored content |
| `apps/discord-bot/src/messageHandler.ts` | per-channel FIFO, steering, approvals, questions, orchestration |
| `apps/discord-bot/src/applicationCommands.ts` | slash command declarations and registration |
| `apps/discord-bot/src/commandRouter.ts` | text and slash command routing |
| `apps/discord-bot/src/responses.ts` | embeds, buttons, answer splitting, attachment output |
| `apps/discord-bot/src/directWorkerClient.ts` | durable bot-to-worker spool client |
| `apps/discord-bot/src/agentRelayBridge.ts` | converts public agent results and files into private relay callbacks |
| `apps/relay-bot/src/index.ts` | Coordinator gateway, slash commands, and control-channel recovery |
| `apps/relay-bot/src/coordinator.ts` | bounded A/B turn state machine, completion agreement, final mention |
| `apps/relay-bot/src/store.ts` | durable Coordinator conversation state |
| `apps/local-agent/src/directWorker.ts` | independent worker, queue serialization, graceful drain |
| `apps/local-agent/src/codexAppServerRunner.ts` | Codex app-server resume, fork, steer, interrupt, approval, questions |
| `apps/local-agent/src/codexRunner.ts` | compatibility `codex exec` runner |
| `apps/local-agent/src/claudeRunner.ts` | Claude Code headless stream JSON, resume, fork, model, effort |
| `packages/core/src/locales` | locale registry and translation catalogs |
| `packages/codex-adapter` | Codex native session and transcript parsing |

Primary flow:

```text
Discord message
  -> discordClient
  -> messageHandler channel queue
  -> durableRequestStore
  -> directWorkerClient
  -> .connect/worker job spool
  -> directWorker
  -> Codex app-server or Claude Code
  -> progress / approval / question / result
  -> Discord thread
```

An ordinary follow-up message steers an active Codex app-server or Claude Code stream-json turn. `/queue prompt:` guarantees a separate next turn.

## Persistent state and restart behavior

- `.connect/config.json`: runtime configuration and token
- `.env`: environment and secrets
- `.connect/state.json`: channel/session mapping, model and effort defaults, sync, schedules, notifications
- `.connect/discord-queue`: durable Discord requests
- `.connect/worker/jobs`: jobs, progress, approvals, questions, and results
- `.connect/incoming-attachments`: temporary Discord downloads
- `.connect/answer-copies`: final-answer copy cache
- `$CODEX_HOME`: native Codex sessions and transcripts
- `~/.claude/projects`: native Claude Code sessions

The Discord gateway does not own agent child processes. If only the bot dies, the worker continues and a new gateway reconnects by request ID and event cursor. If the worker is force-killed, its Codex, Claude, shell, and child processes may terminate.

`.connect/discord-queue` and `.connect/worker` retain user prompts, role IDs, progress, and results in plaintext for recovery. On POSIX systems the stores enforce `0700` directories and `0600` files, and move invalid schema records into local `dead-letter` directories. Delivered Discord requests are removed immediately. Pending requests default to a 7-day TTL, 1,000 records, 64 MiB total, and 4 MiB per request. Attachment bytes are stored separately under `.connect/incoming-attachments`; queue JSON contains only metadata and local paths. Configure `CONNECT_DISCORD_QUEUE_TTL_MS`, `CONNECT_DISCORD_QUEUE_MAX_REQUESTS`, `CONNECT_DISCORD_QUEUE_MAX_BYTES`, and `CONNECT_DISCORD_QUEUE_MAX_REQUEST_BYTES`; `0` disables the corresponding limit.

The connector does not redact or encrypt recoverable prompt content. Use OS full-disk encryption and keep `.connect` outside cloud-sync folders, network shares, and untrusted backup scopes. Treat dead-letter records as sensitive and remove them securely after diagnosis.

## Quick start

Requirements:

- Node.js `^20.19.0` or `>=22.12.0`
- pnpm `9.15.0`
- At least one logged-in agent CLI: Codex, Claude Code, or both

```bash
git clone https://github.com/kwonminki/ai-agent-discord-connector.git
cd ai-agent-discord-connector
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm connect install --direct --locale en
pnpm connect start --direct
```

For noninteractive setup:

```bash
pnpm connect install --direct \
  --locale en \
  --token "DISCORD_BOT_TOKEN" \
  --guild-id "DISCORD_GUILD_ID" \
  --role-ids "ROLE_ID_1,ROLE_ID_2" \
  --channel-id "AGENT_ADMIN_CHANNEL_ID" \
  --claude-channel-id "CLAUDE_CODE_CHANNEL_ID" \
  --workspace-root "$PWD" \
  --workspace-name "Workspace"
```

Use a broad allowed root with a narrower start directory when needed:

```bash
pnpm connect install --direct \
  --workspace-root "/home/user/projects" \
  --initial-cwd "/home/user/projects/current-app"
```

## Agent runners

When Codex is enabled, Direct mode defaults to app-server. Make it explicit in services:

```bash
CODEX_DISCORD_CODEX_RUNNER=app-server
```

Compatibility mode `CODEX_DISCORD_CODEX_RUNNER=exec` does not support session fork, live steering, or live `request_user_input` responses. Use it only for old CLI compatibility.

On macOS and Linux, the connector uses a temporary Unix domain socket for app-server. Native Windows automatically uses an ephemeral loopback WebSocket on `127.0.0.1`; it is never bound to an external interface and closes with the app-server process. If `codex.exe app-server --listen ws://127.0.0.1:<port>` fails, compare `codex --version` and `codex app-server --help` with a verified host.

Codex prompt timeout defaults to five hours. Set `CONNECT_CODEX_PROMPT_TIMEOUT_MS=0` to disable the overall timeout.

When Claude Code is enabled, the connector uses its headless stream JSON runner. Codex runner settings do not affect Claude Code requests. A Claude-only installation skips Codex CLI and app-server verification.

## Service topology

Production installations must separate gateway and worker:

```text
Discord gateway service
  - Discord WebSocket, commands, polling, message delivery
  - safe to restart while an agent job is active

Direct Worker service
  - owns Codex, Claude Code, shell, and child processes
  - drains active work on SIGTERM on macOS and Linux
  - must be stopped from Windows Task Scheduler only while idle
```

Always resolve absolute paths first:

```bash
pwd
command -v node
command -v codex
command -v claude
```

Service processes do not automatically inherit interactive shell aliases or rc-file PATH changes.

### macOS LaunchAgent

Use `scripts/start-mac-direct.sh` or a machine-local wrapper with explicit `HOME`, `PATH`, repository root, config paths, locale, and agent command paths.

Create separate labels such as:

```text
com.USER.codex-discord-connector.bot
com.USER.codex-discord-connector.worker
```

Both should use `RunAtLoad` and `KeepAlive`. The worker should have a long drain timeout:

```xml
<key>ExitTimeOut</key>
<integer>21600</integer>
```

Apply and inspect:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.USER.codex-discord-connector.bot.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.USER.codex-discord-connector.worker.plist"
launchctl print "gui/$(id -u)/com.USER.codex-discord-connector.bot"
launchctl print "gui/$(id -u)/com.USER.codex-discord-connector.worker"
```

macOS privacy controls may block Documents, Desktop, or external disks for LaunchAgents even when Terminal works. Verify file access as the service user.

### Ubuntu systemd

Use separate units. Essential worker settings:

```ini
[Service]
Type=simple
User=USER_NAME
WorkingDirectory=REPO_DIR
Environment=HOME=/home/USER_NAME
Environment=PATH=/home/USER_NAME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=CONNECT_MODE=direct
Environment=CONNECT_LOCALE=en
Environment=CONNECT_CONFIG_PATH=REPO_DIR/.connect/config.json
Environment=CONNECT_STATE_PATH=REPO_DIR/.connect/state.json
Environment=CONNECT_WORKER_ROOT=REPO_DIR/.connect/worker
Environment=CONNECT_DISCORD_QUEUE_ROOT=REPO_DIR/.connect/discord-queue
Environment=CODEX_DISCORD_CODEX_RUNNER=app-server
Environment=CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS=5000
ExecStart=/absolute/path/to/node --import tsx apps/local-agent/src/directWorker.ts
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity
```

The bot unit uses the same state paths but starts `apps/discord-bot/src/index.ts`. Start and inspect:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-discord-worker codex-discord-bot
sudo systemctl status codex-discord-worker codex-discord-bot --no-pager
journalctl -u codex-discord-worker -u codex-discord-bot -f
```

The worker watches `.connect/worker/wake` and responds immediately to new jobs, steering, approvals, and agent answers. The default five-second `CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS` is only a fallback for missed or unsupported filesystem notifications, replacing the old 250 ms full spool scan while idle. Empty job and control spool directories are created once at startup so idle polls do not raise repeated `ENOENT` exceptions. Progress JSONL uses an `mtime`/size cache and parses only appended byte ranges. Managed Codex app-server children are awaited after each turn and force-stopped after a short graceful timeout so completed jobs cannot accumulate orphan processes.

### Windows Scheduled Tasks

Use native Windows PowerShell 5.1 or PowerShell 7 when projects and Codex sessions live on the Windows filesystem. When they live entirely inside WSL2 with Linux tooling, treat WSL2 as an Ubuntu installation and use the systemd path instead of mixing Windows and Linux state.

Verify the current Windows user environment first:

```powershell
node --version
pnpm --version
codex --version
codex app-server --help
claude --version
```

Native `.exe` builds of Codex and Claude are preferred for Scheduled Tasks. If discovery fails, set `CODEX_DISCORD_NODE_COMMAND`, `CODEX_DISCORD_CODEX_COMMAND`, and `CODEX_DISCORD_CLAUDE_COMMAND` to verified absolute paths. Admin-channel commands use `powershell.exe` by default; set `CONNECT_WORKSPACE_SHELL` to the absolute `pwsh.exe` path for PowerShell 7.

Run a foreground smoke test, then register separate bot and worker tasks:

```powershell
Set-Location C:\path\to\ai-agent-discord-connector
pnpm connect start --direct

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows-tasks.ps1 -StartNow

Get-ScheduledTask -TaskName "CodexDiscordConnector-*" |
  Get-ScheduledTaskInfo
Get-Content "$env:LOCALAPPDATA\CodexDiscordConnector\Logs\bot.log" -Tail 50
Get-Content "$env:LOCALAPPDATA\CodexDiscordConnector\Logs\worker.log" -Tail 50
```

The installer creates `CodexDiscordConnector-Bot` and `CodexDiscordConnector-Worker` for the current user at logon. Use `-TaskPrefix` when names must differ. Restart only the bot task during a gateway update:

```powershell
Stop-ScheduledTask -TaskName "CodexDiscordConnector-Bot"
Start-ScheduledTask -TaskName "CodexDiscordConnector-Bot"
```

`Stop-ScheduledTask` is not equivalent to a draining Unix `SIGTERM`; it can terminate the process. Stop or restart the Worker task only after active jobs reach zero. A headless Windows Server that must run before user logon needs an explicitly approved service account and Windows service wrapper. Never store that account password in Discord, repository files, or logs.

## Launch checklist

- Service user matches the user who owns the enabled agent sessions.
- The service principal matches the OS user that owns those agent sessions.
- `HOME`/`USERPROFILE` and the enabled agents' state directories match IDE and CLI usage.
- Workspace root is broad enough but not unnecessarily permissive.
- Service user can read and write the workspace and `.connect` directories.
- GPU access works as the same service user before testing through the connector.
- Guild and parent channel IDs belong to the intended machine.
- Parent channels for enabled agents are distinct.
- No other connector instance owns the same channels.
- Operator role is assigned and channel overwrites allow the bot and operator.
- `.env` and `.connect/config.json` are mode `600` where practical and ignored by Git.
- `.connect/discord-queue` and `.connect/worker` are mode `700`, with JSON/JSONL files created or read by those stores set to mode `600` on POSIX; opening the stores enforces these modes.
- The repository and `.connect` are outside cloud-sync folders, network shares, and untrusted backup scopes.
- Exactly one worker owns a given `CONNECT_WORKER_ROOT`.
- Bot starts after the worker.

Smoke test sequence:

1. Confirm worker ready log and PID.
2. Confirm bot ready log and identity.
3. Run `/status`.
4. Create a test thread with `/chat-new` under every enabled agent parent.
5. Run a short file-read request with every enabled agent.
6. Test `/queue prompt:` for every enabled agent; test ordinary-message steering only for Codex.
7. Run `/howtouse` and send a small attachment both directions.
8. When Codex is enabled, test one approval or `request_user_input` flow; skip this Codex-specific step for a Claude-only installation.
9. Restart only the bot and confirm that worker PID and active work survive.

## Safe updates

Before an update:

```bash
git status --short
git rev-parse --short HEAD
git fetch origin
git diff --name-only HEAD..origin/master
```

Classify restart scope:

| Changed area | Action |
| --- | --- |
| README and docs only | No service restart |
| `apps/discord-bot/` only | Restart bot |
| Slash command definitions | Restart bot and verify registration |
| `apps/local-agent/`, worker store, runner | Restart worker only when idle; defer while busy |
| Shared packages or config schema | Restart bot; restart worker only when idle |
| Dependencies or lockfile | Install and test, restart bot, then restart worker only when idle |

Check `/status`, `.connect/worker/jobs/*/state.json`, durable queues, bot PID, worker PID, and child processes. If any active or queued work exists, do not send the worker `SIGTERM`, `SIGKILL`, `restart`, `stop`, or `kill`. Update the repository, dependencies, and bot only, then report that the worker rollout is deferred until both active and queued counts reach zero.

- Restart bot now and preserve worker work.
- Leave the busy worker accepting new jobs and replace it later when idle.
- Force-stop worker and lose active work, only with explicit approval.

Do not pre-schedule a graceful worker drain while it is busy. The worker stops accepting new jobs as soon as it receives the signal, so one long-running turn can leave every other Discord thread waiting in the durable queue.

A maintenance agent started by the **Update registered servers** button must never restart its own worker. The update request is itself an active worker job, so draining the worker from that turn, or scheduling a restart after the reply, can block every other thread and terminate background processes in the same cgroup. This path updates the repository, dependencies, and bot only, and must report the worker rollout as `deferred`. Do not schedule a delayed worker restart with `sleep`, `at`, `nohup`, `systemd-run`, timers, or traps. A separate external operator may apply the worker later only after verifying zero active jobs, zero queued jobs, and no background child processes that must survive.

Apply only to a clean or understood worktree:

```bash
git pull --ff-only origin master
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
git diff --check
```

For multiple servers, update one canary, run an end-to-end request, then roll out sequentially. Record old and new commits, service names, worker PIDs, active jobs, and ready logs.

Do not repeatedly restart a failing service. Stop the loop, inspect logs, compare Node, pnpm, Codex, and Claude versions, then fix or roll back.

## Runtime behavior

- Use `/chat-new` in a Codex or Claude parent channel to create a new thread and agent session.
- Use `/fork` inside a session thread to clone conversation context into a new session.
- Ordinary messages steer an active Codex or Claude Code turn.
- `/queue prompt:<request>` schedules a separate next turn.
- `/interrupt` stops an active Codex or Claude Code turn.
- `/status` shows connection, session, active task, activity time, model, effort, and queue.
- `/model`, `/effort`, and `/settings` manage parent defaults and thread overrides. The `model` option autocompletes channel-aware Codex or Claude Code suggestions while still accepting custom model names.
- `/howtouse` teaches the active agent the attachment and media-survey protocol.
- Agent questions, approval requests, completion, and failure mention the Operator role.
- Progress messages do not mention the role.

Users attach files directly to ordinary Discord messages. The bot downloads them and appends local metadata to the agent prompt. Agents return files with `codex-discord-send` only after receiving `/howtouse` instructions.

Default attachment limits:

- Input: 10 files per message, 100 MiB each, 250 MiB total
- Output: 10 MiB per file

Final media surveys work for Codex and Claude Code. Every survey also includes an **Other...** button that opens a modal for a free-text answer and routes it through the same guarded question or queued-turn path. Live mid-task `request_user_input` round trips require Codex app-server.

## Permissions and models

Trusted personal Direct mode defaults:

```text
approval=never
sandbox=danger-full-access
network=enabled
```

Claude Code uses `bypassPermissions`. Default effort is Codex `xhigh` and Claude Code `max`. Models follow each CLI unless overridden in Discord.

The connector cannot bypass OS permissions, Windows ACL/UAC policy, sudo, macOS privacy controls, Linux ACLs, or container GPU exposure.

## Version compatibility

Record actual versions during installation and incident reports:

```bash
node --version
pnpm --version
codex --version
claude --version
git rev-parse --short HEAD
```

After Codex or Claude upgrades, smoke-test app-server startup, stream parsing, resume, fork, approval, user input, and final answers before fleet rollout.

The Windows code path is covered by platform-independent tests, but native CLI packaging, PowerShell policy, and Task Scheduler settings vary by host. The first Windows machine in a rollout is the canary: verify the loopback app-server, PowerShell command execution, both Scheduled Tasks, `/fork`, and a bot-only restart before treating the remaining Windows machines as compatible.

## Troubleshooting

### Slash command is missing

1. Confirm `applications.commands` scope.
2. Confirm Guild ID and bot identity.
3. Inspect command registration logs.
4. Restart the bot or run command registration from the admin channel.
5. Verify that this connector instance owns the channel.

### A command appears but does not run

Check channel ownership filtering, Operator role membership, channel permission overwrites, and whether another instance uses the same channel or bot interaction.

### Session messages mix after fork

Run `/status` in both threads and compare session IDs and control keys. New forks should have distinct mappings. Do not run source and fork against the same native session ID.

### Discord work disappeared after update

Check whether the worker was restarted or killed. Bot-only restart preserves jobs; worker termination may stop child processes. Inspect `.connect/worker/jobs`, durable requests, service history, and old PIDs.

### GPU is not visible

Run `nvidia-smi` as the exact service user and environment. Check PATH, device permissions, container runtime, `/dev/nvidia*`, mounts, and sandbox policy. The connector does not add GPU access by itself.

### Unexpected old completion notifications

Initial background scans may establish a baseline without sending old notifications. Test with a new task after the baseline. Ensure multiple instances do not own the same channels.

## Verification commands

```bash
pnpm typecheck
pnpm test
git diff --check
npm pack --dry-run --ignore-scripts
```

Before publishing, verify that the package contains both user READMEs, both AI Agent Guides, localization docs, runtime source, and no secrets or machine state.

## References

- [English README](../README.en.md)
- [Korean AI Agent Guide](AI_AGENT_GUIDE.md)
- [Localization Guide](localization.md)
- [Mac Direct Setup](mac-direct-setup.md)
- [Ubuntu Direct Setup](ubuntu-server-direct-setup.ko.md)
- [Operator Guide](operator-guide.md)
- [Security Policy](../SECURITY.md)
