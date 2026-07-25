# Mac Direct Mode Setup

This repo is intended to be run from source while customizing the connector.

## Discord setup

1. Create a private Discord server for AI agent operations.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Enable the bot's `Message Content Intent`.
4. Invite the bot to the private server with scopes:
   - `bot`
   - `applications.commands`
5. Grant only the needed permissions:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Embed Links
   - Create Public Threads
   - Manage Threads
   - Manage Channels
   - Attach Files
   - Manage Messages, optional for `/clear`
6. Create a dedicated operator role, preferably `AI Agent Operator`. An existing `Codex Operator` role may be reused.
7. Choose Codex only, Claude Code only, or both. Create a dedicated AI agent/admin channel, for example `#mac-agent-admin`, and create a separate Claude Code channel such as `#mac-claude-code` when Claude Code is enabled.
8. Gather the setup values:
   - Bot token: open the [Discord Developer Portal](https://discord.com/developers/applications), select the application, then use `Bot > Reset Token/Copy`. The Public Key and OAuth2 Client ID are not connector inputs.
   - Guild/server ID: enable `User Settings > Advanced > Developer Mode`, right-click the server icon, and select `Copy Server ID`.
   - Operator role ID: open `Server Settings > Roles`, open the role menu, and select `Copy Role ID`. Assign this role to every connector operator.
   - AI agent/admin channel ID: right-click the dedicated agent admin channel and select `Copy Channel ID`.
   - Claude Code channel ID when enabled: right-click the dedicated Claude Code channel and select `Copy Channel ID`.

When Claude Code is enabled, the AI agent/admin and Claude Code channel IDs must be different. The connector has no fixed primary agent; each configured parent channel routes to its own agent. See Discord's [official ID guide](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID) if the copy-ID actions are not visible.

## Install from this source checkout

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Configure this Mac

Use the current source checkout so local code changes apply immediately.

Running `pnpm connect install --direct` without flags prints the same lookup guide and prompts for the applicable channel IDs. Leave the Claude Code channel blank for a Codex-only installation; provide it for Claude-only or dual-agent use.

```bash
pnpm connect install --direct \
  --token "DISCORD_BOT_TOKEN" \
  --guild-id "DISCORD_GUILD_ID" \
  --role-ids "OPERATOR_ROLE_ID" \
  --channel-id "MAC_ADMIN_CHANNEL_ID" \
  --claude-channel-id "MAC_CLAUDE_CHANNEL_ID" \
  --workspace-root "/Users/me/Documents/Codex" \
  --initial-cwd "/Users/me/Documents/AI/ai-agent-discord-connector" \
  --workspace-name "My Mac Workspace" \
  --computer-name "My Mac" \
  --codex-home "$HOME/.codex"
```

This writes `.connect/config.json` and `.env`. Do not commit those files. In direct mode, `--channel-id` is always the AI agent/admin channel and also serves as the Codex parent when Codex is enabled. `--claude-channel-id` is the Claude Code parent when Claude Code is enabled. A Claude-only installation keeps the admin channel for operations and sends agent work through the Claude Code parent.

When `--claude-channel-id` is configured, the bot treats that channel as a Claude Code channel. `/chat-new` or `chat new` creates a Claude Code thread under that channel, and messages inside the thread continue the same Claude Code session. Inside a linked Codex or Claude Code thread, `/fork` asks for a new thread name and creates a sibling Discord thread. Claude Code forks use `claude --resume <session> --fork-session`; Codex forks use Codex app-server `thread/fork`.

The bot also watches recent Claude Code session logs under `~/.claude/projects`. Sessions started by IDE surfaces such as VS Code or Antigravity are detected from their Claude entrypoint and automatically mapped to new Discord threads under `--claude-channel-id`. Connector-started Claude sessions are skipped so they do not create duplicate threads.

## Incoming Discord attachments

In Direct mode, attach an image, video, audio file, or ordinary file to a message in a managed Codex/Claude Code channel. The gateway downloads it into `.connect/incoming-attachments/<message-id>/` and adds its absolute local path to the agent prompt. An attachment-only message receives a default inspection prompt. In the admin channel, attached files default to Codex; start the caption with `claude ` to send them to Claude Code instead.

Defaults are 10 files per message, 100MiB per file, 250MiB total, and a 7-day local TTL. Override them with `CONNECT_INCOMING_ATTACHMENT_ROOT`, `CONNECT_INCOMING_ATTACHMENT_MAX_FILES`, `CONNECT_INCOMING_ATTACHMENT_MAX_BYTES`, `CONNECT_INCOMING_ATTACHMENT_TOTAL_MAX_BYTES`, and `CONNECT_INCOMING_ATTACHMENT_TTL_MS`. The bot and worker services must run as users that can access the same attachment directory.

After the first baseline scan, new assistant answers from those external Claude Code sessions are posted back to the mapped Discord thread as `Claude Code 작업 완료` notifications with the final answer. Connector-started Claude sessions are not completion-notified separately because their result is already shown in the Discord request message.

Claude Code completion notifications wait until the latest session activity is an assistant text message and the session has been idle for `CONNECT_CLAUDE_COMPLETION_IDLE_MS`, so intermediate messages followed by tool calls are not treated as final answers.

Claude Code session scanning uses an in-memory `mtime`/file-size cache. Unchanged `~/.claude/projects/**/*.jsonl` files are not reparsed, and appended session logs are read from the new byte range only. The thread auto-linker and completion notifier share the same discovered session list during each poll.

## Start the bot and worker

```bash
pnpm connect start --direct
```

The combined command is convenient for foreground development. For an always-on setup, run the two Direct components independently so restarting Discord does not terminate an active Codex or Claude Code process:

```bash
pnpm connect start --direct --component worker
pnpm connect start --direct --component bot
```

Direct requests are persisted under `.connect/discord-queue`, and worker jobs, progress, approvals, Codex user questions, and results under `.connect/worker`. A restarted bot reconnects to the same request ID. A worker that receives `SIGTERM` stops accepting new jobs and waits for active jobs to finish before exiting; queued jobs stay on disk.

In Discord, run:

```text
help
where
chat new current name:mac-test
sync
```

## Auto-start on Mac login

Use two user LaunchAgents:

```text
~/Library/LaunchAgents/com.USER.codex-discord-connector.bot.plist
~/Library/LaunchAgents/com.USER.codex-discord-connector.worker.plist
```

Both LaunchAgents can call a machine-local wrapper outside `Documents` so macOS privacy checks do not block the script. Pass `bot` or `worker` as the final argument:

```text
~/Library/Application Support/CodexDiscordConnector/start-mac-direct.sh
```

The repo wrapper `scripts/start-mac-direct.sh` accepts `all`, `bot`, or `worker`. It derives the repo root from its own source-checkout location. If you copy it elsewhere, set `CODEX_DISCORD_REPO_ROOT` to the absolute checkout path. `CODEX_DISCORD_NODE_COMMAND`, `CODEX_DISCORD_CODEX_COMMAND`, and `CODEX_DISCORD_CLAUDE_COMMAND` can override executable discovery. For the worker LaunchAgent, set `ExitTimeOut` to at least the maximum expected Codex run time, for example `21600` seconds, so launchd does not force-kill a draining worker after its short default timeout.

Logs:

```text
~/Library/Logs/codex-discord-connector/bot.out.log
~/Library/Logs/codex-discord-connector/bot.err.log
~/Library/Logs/codex-discord-connector/worker.out.log
~/Library/Logs/codex-discord-connector/worker.err.log
```

Useful commands:

```bash
launchctl print "gui/$(id -u)/com.USER.codex-discord-connector.bot"
launchctl print "gui/$(id -u)/com.USER.codex-discord-connector.worker"
launchctl kickstart -k "gui/$(id -u)/com.USER.codex-discord-connector.bot"
tail -f "$HOME/Library/Logs/codex-discord-connector/bot.out.log"
```

Restarting only the bot LaunchAgent is safe for active worker jobs. Stopping the worker LaunchAgent drains active jobs when launchd honors `ExitTimeOut`; a host reboot or forced kill still interrupts them. While draining, the worker stops accepting new jobs but continues processing steering and interrupt controls for active turns.

If `worker.out.log` shows a new `direct-worker ready with PID ...` line every few seconds, check for an old one-off refresh job with `launchctl list | grep codex-discord-connector.worker-refresh`. A submitted `worker-refresh-*` job is not part of the normal installation and can race with a newly started turn. Remove it with `launchctl remove <full-label>` while leaving the regular worker LaunchAgent loaded.

## Task completion notifications

The Mac direct bot watches non-archived Codex sessions from the configured `CODEX_HOME` and posts to the configured admin channel when a Codex transcript records `task_complete`.

This includes Codex sessions started from IDE surfaces such as VS Code or Antigravity as long as they write native Codex session data under the same `CODEX_HOME`. CLI/exec sessions are included too; sub-agent and archived sessions are skipped.

The first scan for the current notification scope only records a baseline, so old completed work does not flood Discord after a bot restart or scope change. Future completions are remembered in `.connect/state.json` and are only posted once.

Completion notifications include the latest assistant answer when that answer was not already delivered by a Discord-started turn. Long final answers are split into ordered Discord messages, and the Operator role is mentioned only after all answer chunks have been posted. Obsolete thought/process and Codex-app-open buttons are intentionally not shown.

Set `CODEX_DISCORD_CODEX_RUNNER=app-server` before starting both services. Discord prompts then use Codex's app-server WebSocket protocol with `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, approvals, and `request_user_input`. The created, resumed, or forked thread is recorded in Codex's native session store, but a currently visible Desktop, VS Code, or Antigravity panel is not forcibly refreshed or navigated by the connector. While one surface is generating an answer, do not send another request to the same session ID from an IDE and Discord; overlapping turns can reorder messages or place the final answer on an unexpected surface. Continuing from another surface is safe after the active answer has fully completed. Use `/fork` when work must proceed concurrently.

Completion polling defaults to 3 seconds, transcript polling defaults to 5 seconds, and both can be changed with:

```bash
CONNECT_TASK_NOTIFICATION_INTERVAL_MS=3000
CONNECT_TRANSCRIPT_SYNC_INTERVAL_MS=5000
CONNECT_CLAUDE_SESSION_SYNC_INTERVAL_MS=5000
CONNECT_CLAUDE_SESSION_SYNC_LOOKBACK_MS=86400000
CONNECT_CLAUDE_SESSION_SYNC_LIMIT=10
CONNECT_CLAUDE_COMPLETION_IDLE_MS=120000
CONNECT_BACKGROUND_POLL_MAX_INTERVAL_MS=20000
CONNECT_BACKGROUND_MAX_LOAD=0.7
CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS=5000
```

Background polling backs off when there are no new Codex events, and it skips expensive Codex log scans while normalized system load is above `CONNECT_BACKGROUND_MAX_LOAD`. Set `CONNECT_BACKGROUND_MAX_LOAD=0` to disable load-based skipping.

The Direct Worker wakes immediately through a filesystem signal for new jobs, steering, approvals, and agent questions. `CONNECT_DIRECT_WORKER_POLL_INTERVAL_MS` is only the fallback interval when file watching is unavailable, so raising it reduces idle scans without slowing normal interaction.

Codex turns run with the widest local permissions by default:

```bash
CODEX_DISCORD_CODEX_COMMAND=/Applications/ChatGPT.app/Contents/Resources/codex
CODEX_DISCORD_CODEX_APPROVAL_POLICY=never
CODEX_DISCORD_CODEX_SANDBOX=danger-full-access
```

When Codex is enabled on macOS LaunchAgent services, set `CODEX_DISCORD_CODEX_COMMAND` to the absolute Codex CLI path because login services do not inherit the same `PATH` as an interactive terminal. Do the same with `CODEX_DISCORD_CLAUDE_COMMAND` when Claude Code is enabled.

Discord Codex prompts use `xhigh` reasoning by default, and Claude Code prompts use `max` effort by default. Set persistent computer defaults with `/model`, `/effort`, and `/settings` in each agent parent channel. A session thread can override both values and use `default` to inherit the parent setting again. `fast` remains a Codex-only alias for a quick low-reasoning pass; `task` uses `xhigh`.

Claude Code can be launched from a session channel in direct mode:

```text
claude README 요약해줘
claude 이어서 테스트 계획도 잡아줘
```

If `--claude-channel-id` is configured, that Discord channel becomes Claude Code-only: bare natural-language messages go to Claude Code, while shell commands still use the `!` prefix. Running `/chat-new` or `chat new` there creates a Discord thread under the Claude Code channel, and messages inside that thread continue to use Claude Code. The connector runs Claude Code headless with stream JSON output and remembers the returned Claude session ID per Discord channel for later resumes. Set `CODEX_DISCORD_CLAUDE_COMMAND` if `claude` is not on the service `PATH`, and set `CODEX_DISCORD_CLAUDE_PERMISSION_MODE` to override the default `bypassPermissions` mode. Permission approval buttons and Claude hook-based notifications for externally started Claude sessions are not included in the MVP direct integration.

### Persistent Claude Code sessions

By default the direct worker keeps one idle Claude Code process per Discord channel between turns instead of restarting the CLI on every message. This is what makes in-session state survive across Discord messages:

- `run_in_background` shell tasks keep running between turns.
- In-session schedules (CronCreate one-shots/recurring jobs, ScheduleWakeup) actually fire while the channel is quiet. Their results are posted back to the channel as a "Claude Code 세션 알림" message by the bot's idle-notification poller.
- Follow-up turns reuse the warm process, so there is no `--resume` restart cost per message.

Environment knobs (worker process):

- `CODEX_DISCORD_CLAUDE_PERSISTENT` — set to `0`/`false` to restore the old process-per-prompt behavior.
- `CODEX_DISCORD_CLAUDE_SESSION_TTL_MS` — idle time after which a pooled process is shut down (default `0` = keep alive indefinitely). Note that shutting the process down also discards its in-session schedules.
- `CODEX_DISCORD_CLAUDE_MAX_SESSIONS` — maximum number of pooled processes across channels (default `4`, least-recently-used channel is evicted first).
- `CODEX_DISCORD_CLAUDE_SETTINGS` — path to a settings JSON file (or an inline JSON string) passed to Claude Code via `--settings`, e.g. to pre-allow sandbox network domains so headless commands do not stall on domain approval prompts:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["github.com", "*.githubusercontent.com", "registry.npmjs.org"]
    },
    "filesystem": {
      "allowWrite": ["~/Downloads/agent-work"]
    }
  }
}
```

Caveats: interrupting a turn or restarting the worker kills the pooled process; the next message transparently resumes the same conversation with `--resume`, but in-session schedules do not survive the restart (they are in-memory by design, and recurring jobs also auto-expire after 7 days). Model/effort changes for a channel take effect by respawning the pooled process with `--resume`. In relay (hub) mode the persistent pool still works, but idle-turn notifications are only delivered in direct mode. Do not try to outlive the session with `setsid`/`nohup`/`tmux` from inside Claude — the Claude Code sandbox blocks detached processes; the persistent session is the supported way to keep work running.

### Persistent Codex app-server

The worker also keeps one `codex app-server` process per (codex command, `CODEX_HOME`) and reuses it for every prompt instead of booting and killing a server per Discord message. The server multiplexes conversation threads, so concurrent channels share the same process. If the pooled server dies between prompts, the next prompt spawns a replacement and retries once automatically; the worker shuts pooled servers down on stop. Set `CODEX_DISCORD_CODEX_APP_SERVER_PERSISTENT=0` to restore the old server-per-prompt behavior. Prompts that specify an external `appServerUrl`/`appServerSocketPath` bypass the pool entirely.

### Directory picker for new chats

`/chat-new location:browse` opens an interactive folder picker (direct mode only): a select menu moves into subfolders, `⬆️ 상위 폴더`/`🏠 홈` buttons move up or jump to the home directory, pagination handles folders with many children, and `✅ 이 폴더로 새 채팅` creates the session channel at the browsed path. `name`/`prompt` options given to `/chat-new` are carried through the picker and applied on confirm (a very long prompt is dropped with a notice). The picker edits its own message in place and keeps its state in the message content, so it keeps working across bot restarts. Hidden folders are not listed. Renaming session channels or threads in Discord is safe — the connector routes everything by channel id and never renames them back.

### Automatic context compaction

Both agents condense their conversation automatically once context usage crosses a threshold (default 60% of the model context window), so long-running threads do not stall near the limit:

- **Claude Code**: after a turn ends above the threshold, the persistent session runs `/compact` on itself and posts a `🧹 컨텍스트 자동 압축 완료` notification to the thread. Configure with `CODEX_DISCORD_CLAUDE_AUTO_COMPACT_PCT` (default `60`, `0` disables) and `CODEX_DISCORD_CLAUDE_CONTEXT_WINDOW` (defaults to 1M tokens for `[1m]` models, otherwise 200k).
- **Codex**: token usage arrives from the app-server (`thread/tokenUsage/updated`, including the model context window). When a turn crosses the threshold the thread shows a `컨텍스트 자동 압축 예정` progress line and the worker asks the persistent app-server to compact the thread natively (`thread/compact/start`). Configure with `CODEX_DISCORD_CODEX_AUTO_COMPACT_PCT` (default `60`, `0` disables) and `CODEX_DISCORD_CODEX_CONTEXT_WINDOW` (fallback when the server does not report a window).

Compaction attempts are rate-limited to one per five minutes per session.

### Reopening deleted session threads

`/chat-resume` (main channel, direct mode) lists the most recent Claude Code sessions — including connector-started ones — in a select menu. Picking one recreates a thread under the Claude Code channel linked to that session, so the conversation continues where it left off even if the original thread was deleted in Discord. If a live thread already exists for the session, the command points to it instead of duplicating; stale links to deleted threads are cleaned up automatically. Session history lives in `~/.claude`, so deleting a Discord thread never deletes the conversation itself.

### Live progress text in Discord

Intermediate agent output is posted as standalone channel messages while a turn runs, for plain channels as well as threads:

- Claude Code thinking blocks are forwarded as `Claude Code 생각` messages, and intermediate assistant text as `Claude Code 진행` messages (Codex uses the same format with its own label).
- Long texts are split into multiple messages (~1,800 chars each, marked `(계속)`) instead of being truncated.
- A per-task cap guards against flooding: `CONNECT_LIVE_PROGRESS_MAX_MESSAGES` (default `60` messages). When the cap is hit the bot posts one notice and keeps only the final answer delivery.

Use this only on trusted machines and private Discord servers. To narrow permissions, set `CODEX_DISCORD_CODEX_APPROVAL_POLICY=on-request` and `CODEX_DISCORD_CODEX_SANDBOX=workspace-write`. For GPU work, the machine running the connector must already see the GPU outside Codex first. Check `nvidia-smi`, `/dev/nvidia*`, and any container runtime GPU settings before changing Codex sandbox settings.

## Development loop

After changing code:

```bash
pnpm typecheck
pnpm test
git status
git add .
git commit -m "..."
git push
```
