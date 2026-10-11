# Reply to an existing Orca terminal from Discord

[한국어](orca.ko.md) | English

The Direct-mode gateway can send your Discord replies to an existing Codex or Claude Code terminal in Orca. The CLI keeps owning the session, so the connector does not open a competing Codex app-server writer. This is an optional feature for every installation; no account, SSH alias, or personal path is built into the code.

## Use it

1. Update the connector source, install dependencies, and restart the **gateway**. It registers `/orca` on startup. The independent Worker need not restart for this feature.
2. With Codex running in Orca, **reply in the Discord thread already synced to that session**. No terminal picker is required: the reply is typed into that session's terminal with Enter.
3. Run `/orca` to check the current connection. Press **Read screen** or run `/orca action:read` to see the current question.
4. `/orca action:disconnect` also disables automatic routing for this thread. `/orca action:auto` enables it again.

Automatic routing supports Codex CLI processes running under the gateway's user on the same macOS/Linux machine. It matches the thread's session ID against the CLI's primary session metadata and Orca-issued terminal handle. It never guesses from a title or directory, and excludes subagent sessions. If no Orca CLI owns the session, existing connector routing continues. If an owner is found but its Orca connection cannot be verified, delivery stops with an error.

For Claude Code, channels without session sync, or terminals on a different machine, select a terminal with `/orca action:list`. Check its name and host, or specify an exact handle with `/orca action:connect terminal:term_...`. Manual bindings block other connector commands until disconnected; automatic routing leaves commands such as `/fork` available.

`/orca action:send text:...` sends literal CLI commands such as `/compact`. Text commands `/orca read`, `/orca send ...`, `/orca disconnect`, `/orca auto`, and `/orca list` also work. Styles and skills follow the running Orca CLI's configuration.

Answer notifications use existing session transcript sync. Orca routing does not create a new chat or continuously mirror the screen. **Read screen** also works without transcript sync. Keyboard-only dialogs, authentication, and file uploads still require Orca. Avoid typing in the local composer while sending from Discord.

## Gateway configuration

Orca must be reachable **from the gateway's service account/environment**, not just an interactive login shell. The gateway selects one executable, without fallback:

1. `CONNECT_ORCA_COMMAND`
2. `.connect/config.json` → `direct.orca.command`
3. `ORCA_CLI_COMMAND`
4. `orca-dev` when `ORCA_DEV_REPO_ROOT` is set
5. `orca-ide` on Linux, `orca` elsewhere

Bare `orca` is deliberately avoided as the Linux default because it can launch the GNOME screen reader. For a remote Orca relay, use the executable reported by `which orca` **inside that server's Orca terminal**. Set an absolute executable path, not a shell command or SSH command string. The process must retain the relay's normal environment and credentials. Never copy another person's path, tokens, or channel bindings.

Merge this fragment into the existing `direct` object in `.connect/config.json`, preserving the rest of your config:

```json
"orca": { "command": "/absolute/path/to/your/orca-cli", "enabled": true }
```

For a new installation, the existing setup command also accepts `--orca-command /absolute/path/to/your/orca-cli`. Environment values must be set in the gateway service environment; merely editing an unused `.env` does not load it. Restart the gateway after changing configuration.

Validate with the **same executable and account** as the gateway:

```text
<executable> skills get orca-cli --json
<executable> terminal list --json
```

`CONNECT_ORCA_ENABLED=false` or `direct.orca.enabled=false` disables forwarding. An explicit environment value takes precedence. Bound channels stay blocked until disconnected, so disabling the feature cannot silently create a second writer. Hub mode does not forward Orca input.

## Recovery and permissions

- Channel operator-role checks apply to listing, binding, reading, and sending. The channel's allowed users share input and screen access; use a private thread/channel. Ordinary shells and terminals not identified by Orca as Codex/Claude are excluded.
- Automatic routing resolves the current owner of the same session for each reply and rechecks its process before delivery. Manual bindings pin the runtime, terminal handle, process incarnation, host, and agent identity; a changed runtime/process requires a new selection. One terminal can be manually bound to only one channel. Verification failures never fall back to another terminal or a new writer.
- A menu expires after five minutes and only its requesting user can select it in that channel. Binding is refused while connector jobs are active/queued there.
- Input acceptance is reported separately from observed turn start; neither means the work completed. After a transport timeout, inspect the screen before sending a new message. The gateway never automatically retries input.
- `.connect/orca-bindings.json` stores manual bindings, per-thread automatic-routing opt-outs, and seven days of delivery IDs/statuses, **not prompts or terminal output**. `CONNECT_ORCA_STATE_PATH` overrides its location; managed launches keep it under the installation's `.connect` directory. Preserve this file during updates. A pending receipt after a crash prevents resubmitting the same Discord message. Messages older than seven days and restored connector jobs are not forwarded.
- Multiple gateways must not share a state file. If it becomes invalid, repair/restore it before continuing; routing fails closed. Do not delete receipts merely to retry a request whose outcome is uncertain.
- A screen read is a bounded current frame (up to 40 rows), not a full transcript. Older Orca builds without the guide, stable identity metadata, or rendered-screen API must be updated. If a local draft is reported, forwarding pauses until it is cleared/submitted locally. Orca's metadata checks cannot eliminate a race with a human changing the terminal after the check.
