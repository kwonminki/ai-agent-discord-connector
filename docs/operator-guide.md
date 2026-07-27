# Operator Guide

## Deployment Modes

Use Direct mode as the default deployment. Direct mode runs the Discord bot on the same computer it controls:

```text
Discord Bot -> Local Computer
```

This is the main supported path. It has the smallest runtime surface, keeps state in the local `.connect/` directory, and is the recommended setup for personal, single-workstation, and small trusted-team use.

Hub mode is the experimental multi-computer path:

```text
Discord Bot -> Control API -> Local Agent -> Local Computer
```

Use Hub mode only when one Discord server must reach more than one computer. It is still a testing-oriented secondary feature and has higher security risk than Direct mode because it adds a network API, websocket agent connections, and more places where credentials, command output, and workspace metadata can be exposed. Do not expose the Control API directly to the public internet. Prefer VPN, firewall rules, localhost-only testing, or another access-control layer, and start with non-sensitive machines.

## Channel Modes

`help` renders shortcut buttons for the common operations in each channel mode. Buttons use the same command router and role checks as typed commands; shell buttons use an internal prefix so they still work inside session-linked Codex chat channels.

The bot also registers Discord-native slash commands on startup. Discord shows them globally, but the bridge enforces channel boundaries at runtime: admin/main channels are for operations, and session-linked channels are for Codex conversation.

Admin/main commands:

- `/where` shows the current channel mode, computer, workspace, cwd, timeout, and linked Codex session.
- `/status` shows the same status card with the effective model, effort, and whether each value comes from the main default, a thread override, or the CLI default.
- `/settings` shows the Codex defaults owned by this main channel.
- `/model model:<name>` and `/effort level:<level>` persist this computer's Codex defaults. Codex maps `max` to its highest supported value, `xhigh`.
- `/browse` opens the current directory browser UI.
- `/shell command:<명령>` runs a shell command through the existing safety policy.
- `/diff` runs `git diff --stat` in the current channel cwd.
- `/sync limit:<숫자>` opens a multi-select picker so only chosen active sessions are synced.
- `/sync-select limit:<숫자>` does the same thing as `/sync` for operators who prefer the explicit name.
- `/sync-all limit:<숫자>` immediately syncs active sessions without opening the picker.
- `/sync-status` summarizes workspace category mappings, synced session channels, archived sessions, and posted context previews.
- `/sync-mode mode:on-chat 또는 realtime` chooses transcript freshness for synced session channels.
- `/sync-delete mode:preview/all/channels/session session_id:<id> confirm:<true/false>` previews or confirms deletion of synced Discord resources without deleting local Codex session files. Preview cards include a dropdown for selecting one synced channel to delete.
- `/sync-archive session_id:<id> confirm:<true/false>` archives a Codex session in bridge state so future sync runs skip it.
- `/schedule action:create mode:once/every/daily/weekly command:<명령> at:<시간> every:<주기> weekdays:<요일>` persists a scheduled command in bridge state.
- `/schedule action:list` lists scheduled commands.
- `/schedule action:delete id:<id>` deletes a scheduled command.
- `/chat-new location:general/current/path name:<이름> cwd:<경로> category:<true/false> prompt:<요청>` creates a new pending Codex chat channel. `general` uses a separate general-chat folder, `current` uses the invoking channel cwd, and `path` uses the provided `cwd`.
- `/reload mode:commands` re-registers Discord slash commands without disconnecting the bot.
- `/reload mode:restart confirm:true` asks the bot process to restart after replying in Discord.

Session-linked commands:

- `/codex prompt:<요청>` sends a normal Codex prompt.
- `/review prompt:<관점>` runs `codex exec review` for the current repository changes.
- `/fix-tests` asks Codex to run tests, diagnose failures, fix them, and verify again.
- `/summarize target:<대상>` asks Codex to summarize a channel or project context.
- `/compact prompt:<요청>` is agent-aware: Claude Code receives its native `/compact [instructions]` command in the persistent session, while Codex receives the existing compact working-context summary request. If an agent turn is already active, the command waits as the next turn instead of steering the active work.
- `/skill name:<skill> prompt:<요청>` sends an exec-compatible prompt asking Codex to apply the named skill perspective.
- `/model model:<모델>` stores a persistent per-thread model override for Codex or Claude Code. Use `default` to inherit the owning main channel again.
- `/effort level:low/medium/high/xhigh/max/default` stores a persistent per-thread reasoning override. Codex supports through `xhigh`; Claude Code supports through `max`.
- `/settings` shows the effective model and effort together with their source.
- `/archive` opens a confirmation card for the current generated session channel; use `archive confirm` to archive.
- `/fork` opens a name modal in Codex/Claude Code session threads and creates a sibling Discord thread backed by a distinct forked agent session. Failed forks, source-session ID reuse, and duplicate Discord links are rejected; unlinked temporary threads are cleaned up. Codex uses app-server `thread/fork`; Claude Code uses `claude --resume <session> --fork-session`.
- `/steer prompt:<instruction>` explicitly appends an instruction to the active Codex app-server or Claude Code stream-json turn, matching the automatic behavior of ordinary follow-up messages.
- `/interrupt` requests interruption of the active Codex or Claude Code turn.
- `/queue prompt:<instruction>` explicitly keeps an instruction out of the active turn and appends it to the per-channel FIFO queue. With no prompt, `/queue` shows the active and pending requests.
- `/queue-clear` removes pending requests while leaving the active request running.
- `/where` and `/status` show bridge channel status, including channel mode, computer, workspace, cwd, linked session, effective model and effort, and their setting sources.
- `/browse` opens the current directory browser UI.
- `/shell command:<명령>` runs a shell command through the existing safety policy; typed shell commands in session channels use the `!` prefix.
- `/diff` runs `git diff --stat` in the current channel cwd.
- `/codex-command command:<name> prompt:<args>` maps supported shortcuts such as `model`, `diff`, `review`, `compact`, and `mcp` to working bridge or CLI actions.
- `/schedule action:create mode:once/every/daily/weekly command:<명령> at:<시간> every:<주기> weekdays:<요일>` schedules an existing typed command in this session channel.

These native commands are only shortcuts into the same router. Role checks, command confirmation rules, working-directory state, Codex session linkage, and channel boundaries are unchanged. Main defaults and thread overrides are stored in `.connect/state.json`, survive bot restarts, and are copied when a session thread is forked.

Scheduled commands reuse the same router too. The scheduled `command:` value should be a supported typed command such as `shell pwd`, `codex README 요약`, `review 보안 위험 위주`, `sync status`, or `browse`. Schedules are stored in `.connect/state.json`, survive bot restarts, and are checked every 30 seconds by default. Set `CONNECT_SCHEDULE_POLL_INTERVAL_MS` to tune the polling interval.

### shell-admin

Bare messages are treated as shell commands after Discord role checks. Examples:

- `ls`
- `git status`
- `pnpm test`
- Button: `새 일반 채팅`
- Button: `현재 폴더 채팅`
- Button: `세션 선택 동기화`
- Button: `파일 탐색`
- Button: `전체 동기화`
- Button: `삭제 미리보기`
- Button: `명령어 재등록`
- Button: `유지보수`
- Maintenance button: `봇 개발 채팅` creates a current-workspace Codex session with a self-maintenance prompt.
- Maintenance button: `타입체크` runs `pnpm typecheck`; `테스트 실행` runs `pnpm test`.
- Dropdown: `작업 선택`
- Dropdown action: `Git 충돌 점검` runs `git diff --check` to catch conflict markers and whitespace errors before Codex edits continue.
- `ls` result button: `상위 폴더`
- `ls` result button: `새로고침`
- `ls` result button: `이전 페이지` / `다음 페이지`
- `ls` result dropdown: `하위 항목으로 이동`
- `ls` result dropdown: `파일 보기`
- `git status --short` result button: `Diff 보기`
- `pnpm test` result button: `테스트 다시 실행`

Admin/main does not call Codex directly. `codex ...`, `/codex`, `/review`, `/fix-tests`, `/compact`, `/skill`, `/model`, and `/archive` are blocked with guidance to create or use a session channel.

### session-linked

Session-linked channels attach/import native Codex session identity. Normal text is sent to Codex, while operational shell commands use the `!` prefix. Examples:

- `이 세션에서 지금까지 한 일 요약해줘`
- `다음 단계 구현해줘`
- `!ls`
- `!cat README.md`
- `summarize 이번 채널`
- `diff`
- `browse`
- `shell pwd`
- `codex-command mcp list`
- `schedule every 10m command:shell pwd`
- `schedule daily at 09:30 command:codex 오늘 계획 정리`
- `schedule list`
- `archive confirm`
- Button: `이 세션 보관`
- Button: `Codex에게 요청`
- Button: `파일 보기`
- Button: `Git 상태`
- Button: `테스트 실행`
- Button: `Codex 리뷰`
- Button: `테스트 수정`
- Button: `충돌 점검`
- Button: `유지보수`
- Dropdown: `작업 선택`
- `!ls` result dropdown: `하위 항목으로 이동`
- `!ls` result dropdown: `파일 보기`
- `git status --short` result button: `Codex 리뷰`
- failed `pnpm test` result button: `Codex에게 수정 요청`

Session channels do not manage global bridge state. `/sync`, `/sync-all`, `/sync-status`, `/sync-mode`, `/chat-new`, and `/reload` are blocked with guidance to use the admin/main channel.

Component-generated shell commands are routed internally, so file/Git/Test buttons work in session-linked channels even though manually typed shell commands still use the `!` prefix. New-chat buttons open a modal for channel name and initial prompt; `현재 폴더 채팅` and `여기서 새 채팅` use the channel's current cwd. In Codex/Claude Code threads, `/fork` opens a thread-name modal, creates a sibling Discord thread, and links it to the forked agent session ID.

Direct mode can run the same Discord bot token on multiple machines when every instance owns a different admin/session channel set. Message and interaction handling is channel-scoped: unmanaged channels are ignored before slash commands are deferred or buttons/modals are acknowledged.

For a private Discord server, create dedicated admin and Codex/Claude Code session channels and set their notification policy to **Only @mentions**. Intermediate progress is intentionally unmentioned, while approval requests, Codex user questions, and final completion/failure notices mention the configured operator role. This keeps long-running progress visible without generating a notification for every update. A dedicated category is useful when many session channels should share the same organization and notification policy.

Codex progress updates are shown as plain Korean text rather than raw JSON event names. Typical statuses are `요청 접수됨`, `세션 연결됨`, `파일 탐색 중`, `이미지 생성 중`, `컨텍스트 압축 중`, `답변 작성 중`, and `응답 정리 중`. If Codex references a local generated image in the final message, the bot attaches that image file after the answer; remote image URLs remain in message content so Discord can preview them. For explicit file, video, or audio uploads, Codex or Claude Code can include a `codex-discord-send` fenced JSON block with `message` and `files`; the bot hides the block and uploads existing local files up to 10MiB each. Large file sets are split automatically across file-only Discord messages. Larger individual files need to be split or compressed/resized/re-encoded before upload. Run `/howtouse` in a session channel to inject this format into the Codex or Claude Code session linked to that channel.

In Direct mode, files attached by a Discord user are downloaded from Discord's HTTPS CDN into `.connect/incoming-attachments/<message-id>/` before the request is queued. The prompt receives the original filename, MIME type, byte size, and local absolute path. Images, video, audio, and ordinary files use the same path-based flow; an attachment-only message gets a default inspection prompt. The default safety limits are 10 files, 100MiB per file, 250MiB total per message, and a 7-day local TTL. Configure them with `CONNECT_INCOMING_ATTACHMENT_ROOT`, `CONNECT_INCOMING_ATTACHMENT_MAX_FILES`, `CONNECT_INCOMING_ATTACHMENT_MAX_BYTES`, `CONNECT_INCOMING_ATTACHMENT_TOTAL_MAX_BYTES`, and `CONNECT_INCOMING_ATTACHMENT_TTL_MS`. Hub mode rejects incoming attachments because the gateway-local path is not guaranteed to exist on a remote agent.

Direct-mode request metadata is persisted separately under `.connect/discord-queue` so a restarted gateway can reconnect to the worker. Its defaults are a 7-day TTL, 1,000 pending requests, 64MiB total JSON, and 4MiB per request JSON. Attachment bytes are not copied into this JSON; only their metadata and local paths are recorded, so the incoming attachment limits above remain independent. Tune these limits with `CONNECT_DISCORD_QUEUE_TTL_MS`, `CONNECT_DISCORD_QUEUE_MAX_REQUESTS`, `CONNECT_DISCORD_QUEUE_MAX_BYTES`, and `CONNECT_DISCORD_QUEUE_MAX_REQUEST_BYTES`. Set an individual value to `0` to disable that limit.

In Codex and Claude Code threads, only agent-authored intermediate commentary is posted as new messages without role mentions. Command, file, search, reasoning-state, answer-state, and raw lifecycle events are hidden. The final agent message is reserved for the final answer, duplicate commentary is filtered, and each task is capped at 40 live progress messages. Approval requests and final completion/failure notices retain the operator role mention. The pre-turn transcript sync advances its baseline without reposting prior conversation content.

Final answers from Discord-initiated Codex and Claude Code turns are posted as new messages after the live progress feed instead of being hidden in an edit to the original progress card. The progress card is closed with a terminal status, then long answers are split at paragraph, newline, or word boundaries and posted in order instead of being replaced by a text attachment. Fenced code blocks are balanced across message boundaries. Files are posted afterward in separate file-only messages and are automatically batched when there are many. If the runner omits `finalMessage`, the last public agent message is used as the final-answer fallback. Answer chunks do not mention the operator role; the completion/failure notice is sent after all chunks and carries the mention. When a final answer contains an agent survey, the survey message itself carries the operator mention and the separate completion mention is suppressed. Final answer messages also receive a durable `답변 복사` button: answers up to 4,000 characters open in a selectable modal, while longer answers are returned privately as `answer.txt`.

Ordinary messages received while a Codex app-server or Claude Code stream-json turn is active are sent to that turn as implicit steering. Use `/queue prompt:<instruction>` when the instruction must wait for a separate next turn. The bot retries the short interval before a newly started turn becomes steerable. If the same Codex request remains active and steering still fails or is unsupported, the bot reports the failure instead of silently converting the message into a FIFO request. If the original turn finished during the retry, the message can begin as the next normal turn. At the Claude Code response boundary, a follow-up that cannot be accepted by the closing stdin stream is retained as a FIFO request so it is not lost. Bot-authored progress and result messages are rejected before either path. When another agent request is pending, successful intermediate queue turns do not emit a completion mention; the role is mentioned once after the final queued turn. Codex goal turns are handled differently: while the persisted goal status is not `complete`, each turn result is labeled as an intermediate answer and mentions the Operator role. The true final turn is labeled completed and mentions the Operator again. Failures and approval requests still notify immediately. In Direct mode, routed agent requests are persisted under `.connect/discord-queue` and execution state under `.connect/worker`; restarting only the Discord gateway reconnects to the same running or completed worker job instead of starting a duplicate turn.

Agent Relay publishes the currently active participant to every Connector through the trusted private control channel. In an active Codex or Claude Code relay thread, an authorized ordinary user message retains the same implicit-steering behavior. In the waiting peer thread, an agent request is suppressed and the Connector links the active thread instead. `/agent-chat-stop` sends an exact request-ID cancellation marker: a queued relay job is removed, while a matching running Codex or Claude Code job receives an interrupt. Late cancellation markers cannot interrupt a newer unrelated turn.

`/status` and `where` bypass the per-channel FIFO queue. The status card reports `running`, `waiting-for-approval`, `waiting-for-user-input`, or `idle`, along with the active request summary, start time, elapsed time, latest activity, and pending request count. This makes it possible to inspect a long-running turn without waiting for that turn to finish.

When Codex app-server emits `item/tool/requestUserInput`, the bot mentions the operator role and posts each question in the same Discord thread. The next ordinary authorized user message is returned to that exact tool request instead of becoming steering or a queued turn. Numeric replies select numbered options; option labels and free-form answers are also accepted. `/status`, `/interrupt`, and explicit `/queue prompt:<instruction>` remain controls while a question is pending. Timed questions select the first recommended option when their `autoResolutionMs` expires. These question events and answers are stored in the Direct Worker job directory, so a restarted Discord gateway can reconnect and ask again without terminating the Codex worker. This flow requires `CODEX_DISCORD_CODEX_RUNNER=app-server` and is not available for the current Claude Code headless runner.

Codex prompt runs use `CONNECT_CODEX_PROMPT_TIMEOUT_MS`, defaulting to 5 hours. Set it to a millisecond value such as `7200000` for 2 hours, or `0` to disable the overall Codex prompt timeout. Shell commands still use the shorter channel timeout.

When `sync` creates or revisits a Codex session channel, the bot posts a compact `이전 Codex 대화 맥락` message once if native transcript context is available. This preview includes recent user requests and Codex final answers, skips injected environment/instruction blocks, and records `contextPostedAt` in `.connect/state.json` to avoid duplicate posting.

Sync and bulk-delete operations send Discord channel mutations with bounded concurrency, so multiple channel creates/deletes can happen at once while still avoiding an unbounded burst against Discord rate limits. To remove just one synced Discord session channel without archiving the Codex session, run `sync delete session <session-id>` to preview and `sync delete session <session-id> confirm` to delete its Discord channel mapping. Use `sync archive <session-id> confirm` only when the session should also stay excluded from future syncs.

Run `/sync`, `sync`, or `sync select 25` in the admin channel to open the session picker. The resulting dropdown shows up to 25 active sessions and sends only the selected session ids through the sync pipeline. Use `/sync-all` or `sync all 25` only when you intentionally want to import every active session immediately.

Use `/sync-mode`, `sync mode on-chat`, or `sync mode realtime` to choose transcript freshness for synced session channels. `on-chat` refreshes a channel right before the next Discord chat resumes the Codex session. `realtime` additionally polls already-synced session channels about every 5 seconds and posts new desktop/IDE-side transcript updates without waiting for a new Discord message. It never creates new Discord channels by itself; newly opened desktop sessions are imported only after an explicit admin `sync` or `/sync`. Each desktop-side user prompt and public assistant commentary event is posted as a separate message without an operator mention. Internal status/tool events are skipped, and `final_answer` events are left to the existing completion notification so the final answer and operator mention appear only once. Sessions currently being streamed directly by Discord are marker-updated without duplicate reposting. Tune this interval with `CONNECT_TRANSCRIPT_SYNC_INTERVAL_MS`. Background transcript and completion polling backs off when no changes are found, up to `CONNECT_BACKGROUND_POLL_MAX_INTERVAL_MS` by default, and skips expensive scans when normalized 1-minute system load is above `CONNECT_BACKGROUND_MAX_LOAD`.

For orientation, run `/where` in any managed channel before executing commands. In an admin channel, run `/sync-status` or `sync status` to check whether state cleanup or selective sync is needed. In a session channel, run `/status` to confirm the linked agent session, effective model and effort, and whether the values are inherited or overridden.

To update the bot from Discord, run `reload` for a slash-command refresh. Run `reload restart` for the confirmation card or `reload restart confirm` to request a draining restart. A draining restart rejects new work, keeps approval/status/queue/interrupt controls available, and restarts automatically after active work and queued requests finish. Use `reload restart force confirm` to restart the gateway immediately. In Direct mode the independent worker keeps active jobs alive and the restarted gateway reconnects to them. Run production Direct deployments as two services with `pnpm connect start --direct --component bot` and `pnpm connect start --direct --component worker`. Restarting the bot service is job-safe; terminating the worker with `SIGKILL` or rebooting the host interrupts active jobs. A worker receiving `SIGTERM` stops accepting new jobs, continues processing steering/interrupt controls for active turns, and exits after those jobs drain. A bot launched directly with `pnpm dev:bot` will exit and must be started again from the terminal.

For Discord-only bot maintenance, use the admin `유지보수` panel: open `봇 개발 채팅`, ask Codex to make the change in the created session channel, run `타입체크`, run `테스트 실행`, then use `명령어 재등록` for slash-command-only changes or `봇 재시작` for code changes.

## Release Announcements

Release announcements are event-driven and do not run inside any connector process. The GitHub Actions workflow at `.github/workflows/release-announcement.yml` runs only when an annotated `v*` tag is pushed, peels that tag to its exact commit, and sends one notice to Discord through a webhook. Ordinary `master` commits are ignored. This avoids polling, leader election, and duplicate commit/tag announcements when the same bot application runs on multiple computers.

This is an optional, once-per-GitHub-repository setup, not a per-computer connector setting. A user who only clones the upstream repository does not need to configure it. For a fork or independently maintained repository, create a Discord webhook for the announcement channel and store its URL as the GitHub Actions repository secret `DISCORD_RELEASE_WEBHOOK_URL`. An installation agent can perform both operations when the existing bot has `Manage Webhooks` in the target channel and the agent has authenticated write access to the GitHub repository. Otherwise, create the webhook in Discord and add the repository secret in GitHub Settings manually. Never put the webhook URL in a connector `.env` file.

A release commit should start with the same version as its annotated tag:

```text
v1.2.0: Media survey improvements

- Add image and video choices
- Keep completion notifications quiet until the final result
```

The subject becomes the announcement title and the remaining commit body becomes the feature description. Create an annotated tag such as `git tag -a v1.3.0 -m "v1.3.0 Automatic server updates"`, verify `git rev-list -n 1 v1.3.0`, then push the tag. Supported tags include `v1.0`, `v1.2.3`, and `v2.0-beta.1`. Never commit the Discord webhook URL.

When the optional Coordinator is configured with `releaseChannelId`, it recognizes the release marker in the webhook embed and replies with a localized fleet-update button. A click sends a short-lived discovery marker through the private relay control channel. Every online Connector finds or creates one localized managed update thread under its selected agent parent channel and reports that thread. The Coordinator deduplicates by `computerId` and sends one hidden maintenance prompt to that dedicated thread, never to an active user session. Codex is the default; set `direct.maintenanceAgent` or `CONNECT_MAINTENANCE_AGENT=claude` when Claude Code should maintain that installation.

Discovery is live and does not use a static channel list or periodic polling. Offline Connectors are omitted and can be updated later. Keep every Connector `computerId` unique, give the Coordinator access to both the release and private control channels, and load the trusted Coordinator ID on every Connector gateway. Update prompts require a clean fast-forward, exact release commit verification, frozen lockfile installation, separate gateway/worker handling, and graceful worker drain when jobs are active.

## Safety Rules

- Only users with an approved Discord role can run operator actions.
- Each channel starts with a working directory inside the workspace root, and `cd` updates only that channel working directory.
- The Local Agent is not an OS sandbox or chroot; shell execution still runs as the local user.
- Direct mode is the default and recommended deployment.
- Hub mode is experimental, intended for multi-computer testing, and carries higher security risk.
- Commands that reference absolute paths, parent traversal tokens, or shell escape patterns require confirmation.
- Confirmed commands should be treated as full local-user shell access.
- Dangerous commands require confirmation.
- Offline computers block execution.
- Missing Codex session links block session-dependent actions.
- `archive confirm` archives only the bridge mapping and does not move or delete local Codex files.

## Native Codex Import

The Local Agent reads `CODEX_HOME`, usually `$HOME/.codex`, then loads active sessions from `session_index.jsonl`, session transcript files under `sessions/`, and Codex thread state from `state_*.sqlite` when available.

Archived Codex sessions, sub-agent sessions, one-off `codex exec`/CLI sessions, and index entries that cannot be verified in Codex thread state are excluded from default sync. Bridge-archived session ids in `.connect/state.json` are also excluded.

Import is read-only. The agent does not modify native Codex files.
