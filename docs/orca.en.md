# Reply to an existing Orca terminal from Discord

[한국어](orca.ko.md) | English

The Direct-mode gateway can send your Discord replies to an existing Codex or Claude Code terminal in Orca. The CLI keeps owning the session, so the connector does not open a competing Codex app-server writer. This is an optional feature for every installation; no account, SSH alias, or personal path is built into the code.

## Use it

1. Update the connector source, install dependencies, and restart the **gateway**. It registers `/orca` on startup. The independent Worker need not restart for this feature.
2. Keep Orca and the intended Codex/Claude terminal running. In a managed Discord channel or thread, run `/orca` and select the terminal. Check the host and terminal name. You can also use `/orca action:connect terminal:term_...` with an exact handle.
3. Press **Read screen** or run `/orca action:read` to see the current terminal screen. Send an ordinary text message to answer. It is typed into that terminal with Enter.
4. Run `/orca action:disconnect` to return the channel to normal connector behavior.

`/orca action:status` checks the binding. `/orca action:send text:...` sends literal input, including CLI slash commands such as `/compact`. Text commands `/orca read`, `/orca send ...`, and `/orca disconnect` work too. Other connector slash commands are blocked while bound; disconnect to use them. Connector styles and skills do not get injected into these replies, because Orca owns the running CLI's configuration.

Use the Discord thread already synced to the same agent session if you want its existing transcript notifications. Orca binding does **not** discover/relink the underlying Codex/Claude session ID, create a chat, or continuously mirror terminal output. **Read screen** works even without transcript sync. Keyboard-only dialogs, arrow-key selection, authentication, and file uploads still require Orca. Do not type in the local composer at the same time as sending from Discord.

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
- Bindings pin the runtime, terminal handle, process incarnation, host, and agent identity. They survive a gateway restart, but a changed Orca runtime/process requires an explicit new selection. One terminal can bind to only one channel in a gateway. Unavailable targets never fall back to another terminal or a new agent writer.
- A menu expires after five minutes and only its requesting user can select it in that channel. Binding is refused while connector jobs are active/queued there.
- Input acceptance is reported separately from observed turn start; neither means the work completed. After a transport timeout, inspect the screen before sending a new message. The gateway never automatically retries input.
- `.connect/orca-bindings.json` stores private bindings and seven days of delivery IDs/statuses, **not prompts or terminal output**. `CONNECT_ORCA_STATE_PATH` overrides its location; managed launches keep it under the installation's `.connect` directory. Preserve this file during updates. A pending receipt after a crash prevents resubmitting the same Discord message. Messages older than seven days and restored connector jobs are not forwarded.
- Multiple gateways must not share a state file. If it becomes invalid, repair/restore it before continuing; routing fails closed. Do not delete receipts merely to retry a request whose outcome is uncertain.
- A screen read is a bounded current frame (up to 40 rows), not a full transcript. Older Orca builds without the guide, stable identity metadata, or rendered-screen API must be updated. If a local draft is reported, forwarding pauses until it is cleared/submitted locally. Orca's metadata checks cannot eliminate a race with a human changing the terminal after the check.
