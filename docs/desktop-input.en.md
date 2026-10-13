# Continue a Desktop conversation from Discord

[한국어](desktop-input.ko.md) | English

For Codex work started in the ChatGPT/Codex desktop app, **reply with an ordinary message in its already-synced Discord thread**. The message goes to the original app conversation, without `/fork` or a terminal picker.

- During an active turn, input steers that turn. Only an explicit inactive-turn rejection allows starting the next turn in the same conversation.
- The app retains its model, permissions, workspace, and style settings. The connector neither opens another writer nor prepends connector guidance.
- Existing transcript sync delivers answer notifications. Connector commands such as `/fork` keep their usual behavior. Explicit Orca bindings take priority.

## Progress and returning to the app

Realtime sync (the default) shows a `Thinking / working` card and public intermediate updates from the **same Codex session** in Desktop or Orca. The card changes on completion or interruption. Pending public updates are delivered before the final answer, and long updates are split for Discord. Private reasoning and tool bodies are excluded from this feed.

Internal conversation compaction immediately after an answer does not reopen the thinking card. New input or evidence of actual agent work starts the next card, while the previous card retains its terminal status even when both turns are observed in one poll.

After replying from Discord, continue typing in the original ChatGPT/Codex app or Orca terminal. The session, context, workspace, and app/CLI settings remain in place, and later turns keep reporting to the same Discord thread. The connector does not stop the original process or replace its writer.

The feed reads session records at a default interval of 3–5 seconds; high system load or connection errors can delay it. Very short tasks may finish before a thinking card appears. After 30 minutes without a new status record, the card asks you to check the app rather than claiming the task has stopped. Persisted message IDs and cursors survive Gateway restarts. Selecting `on-chat` sync mode disables automatic progress updates too.

## Requirements

The Direct gateway and app must run on the **same computer, as the same user, with the same Codex home**. This implementation supports macOS/Linux user sockets, not Windows named pipes. The app must own the conversation. If the socket or owner is absent, existing connector routing continues. A stale socket that refuses the initial connection is also treated as unavailable, so a closed Desktop app cannot block ordinary Connector sessions. Failures after connecting or sending input still stop without falling through to another writer.

Update the source, install dependencies, and restart only the **gateway**. Forwarding is enabled by default; the worker and app need not restart. Set `CONNECT_DESKTOP_INPUT_ENABLED=false` in the gateway environment to disable it.

The app router may take 10 seconds to confirm that no app client owns a conversation. The connector allows this discovery window plus the forwarded request budget before timing out. An explicit `no-client-found` result during initial discovery continues through the existing worker; an unanswered discovery or unconfirmed input still stops without retrying.

This supports local Codex work sessions in the app, not ordinary ChatGPT web chats. It uses the app's same-user IPC owner-discovery/follower protocol, which is not a publicly stable API. Owner discovery for an existing conversation was verified with ChatGPT app `26.928.20755` and bundled Codex `0.159.0`. App updates may require connector compatibility updates.

## Delivery and recovery

- Existing channel-role checks apply. Bot/relay messages and restored queued requests are never automatically forwarded to the app.
- Only text is supported. Use the app for files, approval controls, and dedicated multiple-choice buttons. This is conversation input, not automatic approval selection.
- Preserve `.connect/desktop-deliveries.json` during updates. It records seven days of message IDs and delivery states, not prompts or transcripts.
- If transport fails or acknowledgement is unknown, there is no retry through another conversation or writer. Check the app before sending a new message. Repair damaged delivery records before continuing.
- The discovered owner is pinned through delivery. If it closes or changes, sending stops. Acknowledgement confirms input delivery, not completion of the work.

[Official App Server documentation](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn) describes `turn/steer` for adding input during an active turn. This connector asks the existing app owner to perform that action through its follower connection instead of starting another app-server.
