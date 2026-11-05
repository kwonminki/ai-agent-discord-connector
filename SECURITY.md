# Security Policy

AI Agent Discord Connector can execute shell commands and expose local workspace output through Discord. Treat it as a powerful local administration tool, not as a public bot.

## Supported Versions

Security fixes are handled on the latest published npm version and the default branch until a stable release policy is documented.

## Reporting a Vulnerability

Please do not open a public issue for a vulnerability that exposes tokens, local files, command execution, or Discord access controls. Report privately to the maintainer listed on the npm package or repository.

Include:

- A short impact summary.
- Reproduction steps.
- Affected version or commit.
- Whether a Discord token, workspace file, or shell command path is involved.

## Threat Model

The connector runs commands on the machine where it is installed. Anyone who can send authorized commands in a configured Discord channel may be able to run local shell commands with the permissions of that local user.

The recommended deployment is Direct mode, where the Discord bot runs on the same computer it controls. Direct mode has the smallest deployment surface and is the primary supported path.

Hub mode is an experimental multi-computer option. It adds a Control API and Local Agent websocket path so one Discord bot can reach multiple computers. Treat Hub mode as higher risk: it expands the network attack surface, increases the number of credentials and runtime processes to protect, and can fan out operator mistakes across more machines.

Use it only with:

- Private Discord servers you control.
- Explicit Discord role allowlists.
- Trusted operators.
- Workspaces where Discord-visible output is acceptable.

Do not connect it to public or community servers.

For Hub mode, also require:

- No direct public-internet exposure for the Control API.
- Firewall, VPN, localhost tunnel, or equivalent network access control.
- Separate review of every connected computer's workspace root.
- Minimal operator roles and periodic role membership review.
- Test-only or low-sensitivity machines until you have audited your deployment.

## Secrets

Never commit or publish:

- `.env`
- `.connect/config.json`
- `.connect/state.json`
- Discord bot tokens
- local database files
- logs containing command output
- `.connect/discord-queue` and `.connect/worker` dead-letter records
- `.connect/relay-config.json` and `.connect/agent-relay`
- Codex session or transcript files

If a Discord token is exposed, rotate it immediately in the Discord Developer Portal and restart the connector.

## Local Durable State

Direct mode persists full Discord request content under `.connect/discord-queue` and worker payloads, progress, approvals, questions, and results under `.connect/worker`. This is required to reconnect after a gateway restart, so prompts are not redacted and are not encrypted by the connector.

The stores enforce `0700` directories and `0600` files on POSIX systems. Invalid queue records are moved to a local `dead-letter` directory instead of being retried indefinitely. Completed Discord requests are removed after delivery, and pending requests default to these limits:

- 7-day TTL
- 1,000 requests
- 64 MiB total queue size
- 4 MiB per request

Incoming attachment bytes are stored separately under `.connect/incoming-attachments`; durable requests contain only attachment metadata and local paths. Large media files therefore do not consume the JSON request limit.

Configure or disable a limit with `CONNECT_DISCORD_QUEUE_TTL_MS`, `CONNECT_DISCORD_QUEUE_MAX_REQUESTS`, `CONNECT_DISCORD_QUEUE_MAX_BYTES`, and `CONNECT_DISCORD_QUEUE_MAX_REQUEST_BYTES`. A value of `0` disables that limit.

Use operating-system full-disk encryption for data at rest. Keep the repository and `.connect` outside Dropbox, OneDrive, iCloud Drive, Google Drive, Syncthing, network shares, and automatic backup scopes unless those systems are explicitly trusted and encrypted. Do not send tokens, passwords, private keys, or other secrets in Discord prompts merely because the local files have restrictive permissions.

Agent Relay accepts bot-authored prompts only from explicitly configured Coordinator bot user IDs and only in agent session threads. Keep its control channel private, use a separate bot token, and do not broaden this exception to all bots or shell-admin channels. Relay state and result metadata may contain full agent answers.

Orca native chat input uses the gateway user's local Orca profile and authenticated runtime socket. The connector matches the current Codex session handle and checks runtime identity and ownership before sending authorized human input. Protect Orca's runtime metadata and session journal as private local state; never publish their credentials or conversation records. Native input uses Orca's existing permissions and queue. Approvals, structured questions, and attachments still require Orca, and ambiguous deliveries are not automatically retried.

## Shell Execution

Shell commands run with the local user's permissions. The connector includes role checks and dangerous-command confirmation, but it is not an operating-system sandbox.

Recommended controls:

- Use a dedicated Discord role for operators.
- Grant the bot only the Discord permissions it needs.
- Run the connector from a dedicated workspace root.
- Avoid running as an administrator/root user.
- Review command output before sharing logs.

On native Windows:

- Run the bot and worker Scheduled Tasks as the same non-administrator user that owns the Codex and Claude sessions.
- `ExecutionPolicy Bypass` in the launcher only allows that local script to run. It is not a sandbox or privilege boundary and does not bypass UAC or Windows ACLs.
- The connector binds its temporary Codex app-server WebSocket only to `127.0.0.1`. Do not change it to a public interface without authentication, firewalling, and a separate security review.
- Stopping the Worker task can terminate active agent child processes. Confirm that active jobs are zero first.

## npm Package Hygiene

Before publishing:

```bash
pnpm test
pnpm typecheck
npm pack --dry-run
```

Native Windows verification additionally runs `pnpm test:windows` and parses the PowerShell launch scripts in the Windows compatibility workflow.

Review the `npm pack --dry-run` file list and confirm that no local config, state, tokens, logs, databases, or session transcripts are included.
