# Silence watchdog

A running turn is watched at the orchestration ingestion layer, after provider events have been normalized. This covers Codex and Kimi through the Mastra AgentController and Claude, Grok, and OpenCode through the legacy adapter bridge.

The scoped watchdog records the latest runtime event. After 60 seconds without activity it appends a `status.beat` activity with the label “Still working”. After 120 seconds it appends an error activity, interrupts the provider turn, and calls `BotInboxService.ensureOpen` with the `silence-watchdog-failure` kind. The incident key includes the chat and turn, so repeated failure signals remain one open inbox item. A later completed turn resolves that key.

Automatic hidden self-wakes can mark their raw runtime event as hidden or self-wake. The first 60-second beat is suppressed for that turn, while the failure threshold remains active. The watchdog fiber is scoped to ingestion and is stopped on completion, interruption, abort, session exit, or restart.
