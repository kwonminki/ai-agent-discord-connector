# Subagent threads

The Direct Gateway groups native Codex children using parent/spawn metadata and Orca Codex workers using authoritative dispatch records plus verified local CLI ownership. Ordinary forks stay independent.

Each parent gets an `agents` index thread. Existing parent-thread members with an allowed Operator role are invited and personally mentioned once; no mention is sent if no eligible members are found. Index and child threads never mention the Operator role. New children are announced there without further mentions. The index and migration redirects cannot execute agent input or commands.

Individual children live in a separate `<computer-channel>-subagents` text channel with the original parent channel's permission overwrites. Child threads do not auto-invite users or mention them for progress, questions, or completion. Names use the native agent path/name or Orca task title. Existing flat threads keep their history and receive an archived redirect.

Reply in a child thread to continue. Orca workers use their existing CLI owner. Native Codex child input requests that the parent forward the user's text to that exact existing child ID. Acceptance by the bot is not proof of delivery to the child; the parent must perform the handoff. Closed children are not silently replaced. Commands and attachments belong in the parent thread. Parent input must already work through Desktop, Orca, or a Connector-owned session; this feature does not add live input to an otherwise unconnected CLI.

Discord does not support nested threads. The index collects links; public child threads may still appear in thread lists or in the sidebar after joining. The bot cannot override a user's notification settings. Use mentions-only notifications and `/realtime on` for mirrored public progress.

Native children work without Orca. Node 22+ uses built-in SQLite; Node 20 needs the `sqlite3` executable. Ambiguous or historical Orca terminals without verifiable ownership are not guessed. Proven relationships survive terminal exit. Preserve `.connect/state.json`. Only restart the Gateway, not active Workers. This feature covers Codex children and Orca's Codex workers.
