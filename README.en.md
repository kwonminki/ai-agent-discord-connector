# AI Agent Discord Connector

[![Version](https://img.shields.io/github/v/tag/kwonminki/ai-agent-discord-connector?sort=semver&label=version)](https://github.com/kwonminki/ai-agent-discord-connector/tags)
[![Windows compatibility](https://github.com/kwonminki/ai-agent-discord-connector/actions/workflows/windows-compatibility.yml/badge.svg)](https://github.com/kwonminki/ai-agent-discord-connector/actions/workflows/windows-compatibility.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%5E20.19%20%7C%7C%20%3E%3D22.12-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Ubuntu-555555)](#multiple-computers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[한국어](README.md) | English

A personal bridge for using **AI agents such as Codex and Claude Code running on macOS, Windows, or Ubuntu through Discord threads and letting those agents converse with one another**.

## v2.0 Release

> ### NEW · Build Harnesses through conversation
> **Create reusable agent workflows by answering a few natural-language questions—without knowing any file format—then run them with Codex or Claude Code in a separate execution thread.**
>
> Enter only a goal in `/harness create`, then optionally continue from the current work session or start fresh. The Builder moves through discovery, detailed design, full-design review, and explicit user confirmation. It structures the goal, real usage examples, inputs, steps and decisions, outputs, success criteria, permissions and prohibitions, failure behavior, resources, and useful roles. After the user approves the reviewed design, `/harness publish-run` publishes an immutable version and creates an execution session separate from the Builder.
>
> Published snapshots are pinned by exact version and digest. The Worker revalidates their path, file set, symlinks, manifest, and digest before every execution. Codex receives an official app-server skill item; Claude Code receives an isolated local plugin. Builder output cannot add hooks, MCP configuration, background agents, or executable scripts. Existing `/fork` preserves either Builder state or the exact execution snapshot in a distinct agent session.

## v1.5 Release

> ### NEW · Agent-aware context control
> **Discord `/compact` now detects the agent linked to the current thread and uses the correct compaction path.**
>
> Claude Code threads invoke the persistent session's native `/compact`, while Codex threads request a condensed summary of the current work context. Optional instructions are preserved, and when an agent is already busy the command waits safely for the next turn instead of steering the active one. Command descriptions and guidance are available consistently in Korean, English, Chinese, and Japanese.
>
> **Long-running Codex work now reports its state more accurately as well.** A turn whose goal is still running is announced as an Operator-mentioned **intermediate answer**; only the final turn that actually completes the goal is announced as **Task completed**. If automatic continuation changes the active turn ID, Discord steering finds the latest turn and retries once safely.

## v1.4 Release

> ### v1.4.2 patch · Reliable steering during long-running Codex work
> **Discord follow-ups now find the current active turn even after a Codex goal advances through automatic continuation turns.**
>
> Previously, a long-running goal could move to a new turn while Discord still held the original turn ID, causing intermittent steering failures. The connector now detects that mismatch, reads the latest `inProgress` turn in the same thread, and retries once safely. Ordinary work and Claude Code's stdin-based steering behavior remain unchanged.
>
> Answers from turns whose goal is still `active`, `paused`, `blocked`, `usageLimited`, or `budgetLimited` are shown as **intermediate answers** and mention the Operator. The final turn whose goal status is actually `complete` is clearly announced again as **Task completed**.

> ### NEW · Persistent agent sessions — schedules and background work actually run
> **Claude Code sessions now stay alive between messages, so in-session schedules (cron) and background tasks keep running after the chat goes quiet, and their results arrive back in Discord.**
>
> Previously every message spawned a fresh agent process, so anything scheduled inside a session died the moment the turn ended. Now one Claude Code process stays idle per thread, and results produced while nobody is chatting are posted to the thread as a **Claude Code session notification** — "remind me in 30 seconds" simply works. Codex keeps one persistent app-server as well, removing the per-message server restart cost.
>
> Also included: Claude thinking and intermediate progress are delivered as split messages instead of being dropped or truncated, `/chat-new location:browse` opens a clickable folder picker, `/chat-resume` reopens sessions whose threads were deleted, `/howtouse prompt:` forwards a request together with the usage guide, main channels now only host threads (and Discord system messages such as channel renames never leak into agents), and every queued completion mentions the operator. v1.3 one-click fleet updates and [Agent Relay](docs/agent-relay.en.md) remain included.

> **v1.4.1 patch · Automatic context compaction:** when a long conversation crosses 60% (configurable) of the model context window, it is condensed automatically. Claude Code runs `/compact` on its own persistent session and leaves a 🧹 notice in the thread; Codex watches the app-server token-usage feed and triggers native compaction (`thread/compact/start`) in the background. The conversation continues seamlessly, rate-limited to once per five minutes per session. Tune with `CODEX_DISCORD_{CLAUDE,CODEX}_AUTO_COMPACT_PCT`, or set `0` to disable.

> **v1.3 recap:** pushing an annotated tag posts a release notice with an **Update registered servers** button that updates connected computers one click at a time, preserving running Workers through graceful drain and never touching user threads.

Send an ordinary Discord message and the agent works on the connected computer, then returns important progress and the final answer to Discord. Images, video, audio, and general files can move in both directions.

Connect Codex only, Claude Code only, or both. The connector does not assume either one is the fixed primary agent; when both are enabled, the parent channel receiving the message determines which agent handles it.

> This bot can modify files and execute commands on connected computers. Use it only in a trusted private Discord server and on machines you control.

## Get started

You do not need to follow an installation procedure yourself. Send this repository and request to an AI coding agent such as Codex or Claude Code:

```text
https://github.com/kwonminki/ai-agent-discord-connector

Read this repository's AI Agent Guide first, then install and configure it on my computer.
Ask me only for required account actions, one step at a time, and configure and verify everything else yourself.
```

The agent detects the conversation language and operating system, asks whether to connect Codex, Claude Code, or both, then configures only the required Discord channels and local services. After the first computer is ready, it will ask whether you want to connect any additional macOS, Windows, or Ubuntu machines and whether to enable Agent Relay conversations.

### Current deployment model

The current deployment model is self-hosted in a trusted personal environment. The host running each Discord Gateway and the optional Coordinator needs the corresponding bot token. After the user creates a private Discord server and invites the bot applications, the installation agent can configure the roles, channels, permissions, slash commands, local worker, and services.

End users would not need bot tokens if the project operator centrally hosted both bots and users only invited them. That model still requires production multi-guild tenant isolation and one-time Local Agent pairing, which are not a completed v1 deployment path. Do not expose the current Control API or Agent WebSocket to the public internet without authentication.

## Supported languages

The Connector and Agent Relay Coordinator UI support:

- Korean
- English
- Simplified Chinese
- Japanese

The installation agent selects the language automatically from the conversation and applies it to both Connector and Coordinator. Buttons, modals, status text, slash command descriptions, and `/howtouse` use that language. User messages and agent-authored answers remain unchanged.

## Using Discord

### New chat

Run `/chat-new` in a Codex or Claude Code parent channel to create a Discord thread and agent session.

When both are enabled, a thread created under the Codex parent continues with Codex, while one created under the Claude Code parent continues with Claude Code. There is no global primary agent.

```text
/chat-new name:Fix login bug
```

Send natural-language requests in the new thread:

```text
Inspect the current code and fix the login error.
Run the tests and report the result.
Find the broken segment in this video.
```

### Live guidance and queue

An ordinary message sent while Codex is working steers the current task immediately. Use `/queue prompt:` when the request must run as a separate turn after the current task.

```text
/queue prompt:Run the full test suite after the current change
```

While Codex or Claude Code is working, an ordinary message in the same thread steers the active turn immediately. Use `/queue prompt:<request>` when the instruction must wait for a separate next turn.

### Fork a session

Use `/fork` inside a session thread to copy its conversation context into a new thread. The source and fork remain connected to separate agent sessions.

### Build and run a Harness

Start from a Codex or Claude Code thread:

```text
/harness create goal:I want a repeatable PR review workflow for this project source:Continue current session (recommended)
```

`source:current` copies the current conversation context; `source:fresh` starts empty. In the new **Harness Builder** thread, answer questions naturally—the Builder runs read-only and handles the internal skill and agent files. It progressively clarifies real usage examples, inputs and context, detailed steps and branches, outputs and success criteria, permissions and prohibitions, resources and roles, failure behavior, and validation cases.

The Builder link appears as soon as its Discord thread exists; that same status message is updated while the agent session connects and the first question is prepared. The bot explains the four stages and how to answer, then shows a compact phase, response-count, section-coverage, and next-action update after each exchange. Buttons provide recommend-and-continue, approve-this-design, publish-and-run, publish-only, and status actions, leaving only substantive answers to type. If the Builder emits malformed hidden JSON, the bot asks the same agent session to correct it up to three times, and reserved internal JSON blocks never appear in Discord output even if a channel binding changes. The Builder must spend at least three responses discovering and designing the workflow, then show all nine design areas as a human-readable review and ask for confirmation. It can generate a candidate only after the user approves that exact design in the next reply. The bot persists the interview phase and reviewed-design digest, rejecting first-turn candidates, incomplete designs, and designs silently changed after confirmation. `/harness status` shows the same state on demand.

```text
/harness publish-run first_request:Review the current changes
```

This publishes an immutable exact version and digest, then opens a separate execution thread. Every later request in that thread receives the same snapshot. Use `/harness list`, `/harness status`, or `/harness run` to inspect and select published Harnesses. `/harness-help` displays the complete quick guide even in a channel without a linked agent session. Forking a Builder or execution thread preserves its Builder state or exact execution version in a separate agent session.

Unless an explicit name is supplied, Builder and execution thread names are derived from the original Discord thread, for example `Original task · 🧩 Harness Builder` and `Original task · 🧰 safe-review v1.0.0`. The requester is added to the execution thread automatically. A persistent progress card shows the roles of the **Codex/Claude Code coordinator**, **isolated Worker**, and **Discord Gateway**, together with the active owner, stage, latest report, and command/edit/check counters. In addition, Builder and Run timelines preserve every Agent report, analysis update, command start/completion, file edit, validation step, and lifecycle event with its full visible detail; long events are split across Discord messages without dropping content. If the Gateway restarts during a run, it reconnects to the same work using the persisted Discord request ID, Worker job ID, execution thread, and progress message ID instead of creating a duplicate run.

### Common commands

| Command | Purpose |
| --- | --- |
| `/chat-new` | Create a Discord thread and agent session. Use `location:browse` to pick the folder interactively |
| `/status` | Show activity, last progress, queue, and model settings |
| `/settings` | Show the effective model and effort |
| `/model` | Choose a parent default or thread model from channel-aware suggestions; custom input remains supported |
| `/effort` | Change a parent default or current thread effort |
| `/steer` | Explicitly steer an active Codex or Claude Code task |
| `/queue` | Reserve the next turn or inspect the queue |
| `/queue-clear` | Remove requests that have not started |
| `/interrupt` | Interrupt the active Codex or Claude Code turn |
| `/fork` | Copy the current context into a new thread |
| `/harness` | Select a Builder, publish, exact-version run, or status action from native subcommands |
| `/harness-help` | Show Harness help without a linked agent session |
| `/chat-resume` | Reopen a Claude Code session as a thread after its thread was deleted |
| `/howtouse` | Teach the current agent Discord file and survey output. Add `prompt:` to forward a request with it |
| `/where` | Show the computer, working directory, and session ID |
| `/agent-chat` | Start an automatic conversation with another agent thread |
| `/agent-chat-status` | Show Agent Relay round-trip, turn, and state |
| `/agent-chat-stop` | Stop the current Agent Relay conversation |

When a separate Coordinator Bot is enabled, `/agent-chat` links the current thread to another agent thread. The default limit is 20 round trips, where one A answer plus one B answer counts as one round trip. It alternates final public answers and Discord attachments. When an agent returns `extend`, an Operator can grant one more round trip or reject the extension and stop the conversation from the final notice. The Operator role is mentioned when both agents agree to finish or a configured round/time limit is reached. During a relay, an ordinary message in the active Codex or Claude Code thread steers the current turn, while the waiting thread points you to the active one. `/agent-chat-stop` ends the relay and interrupts the current Codex or Claude Code turn.

### One-click server updates

With the Coordinator and GitHub release announcements enabled, pushing an annotated `v*` tag automatically posts a version notice with an **Update registered servers** button. On discovery, every online Connector finds or creates one localized dedicated update thread (`Discord Bot Updates` in English) under its selected agent parent channel. The Coordinator applies the exact tagged commit only through that thread for each `computerId`, leaving active user sessions untouched. A server configured for both Codex and Claude Code still receives only one update request.

## Files and media

Attach an image, video, audio file, document, or archive to a normal Discord message and describe the task. The bot stores it temporarily on the connected machine and gives the local path to the agent.

Run `/howtouse` once in a session so the agent knows how to return result files and media surveys. Then ask naturally:

```text
Attach the result video and log file to Discord.
Send both result videos and ask me which one is better.
```

- Default input limit: 10 files per message, 100 MiB per file, 250 MiB total
- Default output safety limit: 10 MiB per file
- A lower Discord server upload limit takes precedence.
- Ask the agent to compress, resize, re-encode, or split larger files.

## Notifications

On a dedicated private Discord server, the installation agent sets the server-wide default notification level to **Only @mentions**. It asks first on a shared server because that default can affect other channels and members.

- Useful progress explanations accumulate quietly without a mention.
- Questions, permission requests, completion, and failure mention the Operator role.
- Long final answers and IDE/background completion notices are delivered as ordered messages without truncation.
- A bot cannot change a user's per-channel notification override. Only channels that a user previously customized need to be reset manually to **Only @mentions**.

## Multiple computers

One private Discord server can connect several macOS, Windows, and Ubuntu machines. After the first installation, tell the agent:

```text
Connect another Windows computer to this Discord connector.
```

The agent asks for the machine type, connection method, workspace, and agent combination: Codex only, Claude Code only, or both. It then reuses the existing Discord setup while creating the required channels and services for that machine.

Ask the installation agent to enable the Coordinator Bot when agents on different computers should discuss work with one another. Discord carries the relay traffic, so the computers do not need direct network access to each other.

## Important notes

### Do not message the same session from another surface while it is answering

While Codex Desktop, VS Code, Antigravity, another IDE, or Discord is generating an answer, sending a new message to the same session ID from another surface can overlap two turns. Messages may arrive out of order, and progress or the final answer may appear on an unexpected surface.

After the current answer has **fully completed**, it is safe to continue the same session from Desktop, an IDE, or Discord. If another request must start before that answer finishes, use `/fork` or `/chat-new` to create a separate session.

### Service shutdown scope differs

- Restarting only the Discord bot leaves active work running in the independent worker.
- Force-stopping the worker or rebooting the computer may terminate active agents and their child processes.

### Permissions are powerful

The default automation setup can access files and commands broadly on the connected machine. Never connect it to a public Discord server or an untrusted role, and never send tokens or passwords in Discord messages.

## Documentation

- [English AI Agent Guide](docs/AI_AGENT_GUIDE.en.md): agent-only installation, updates, service operations, and troubleshooting
- [Korean AI Agent Guide](docs/AI_AGENT_GUIDE.md)
- [Localization Guide](docs/localization.md)
- [Agent Relay Guide](docs/agent-relay.en.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT

This project began with the idea and early foundation of [joungminsung/codex-discord-connector](https://github.com/joungminsung/codex-discord-connector), and I am grateful to its original author for sharing that starting point. The current version extensively redesigns and expands most of the codebase and workflow, including multi-agent support, independent workers, multi-machine operation, file and media round trips, localized UI, and cross-platform deployment.
