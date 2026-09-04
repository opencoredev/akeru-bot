# Privacy and outbound data

Akeru stores environment data under `~/.akeru` by default. This includes projects, chats, bot
profiles, settings, secrets, logs, local memory, and cached provider data. A worktree development
server uses that worktree's `.akeru` directory instead.

## Data that can leave the environment

- Provider requests send the prompt, selected files, tool results, and conversation context to the
  provider that you select. That provider controls its processing and retention.
- Product feedback sends the text and an optional safe interface descriptor to
  `feedback.akeru.bot`. The service can retain accepted feedback for up to 90 days.
- Voice calls send microphone audio and call state to the ChatGPT Realtime service while a call is
  active.
- Provider update checks contact the release source for configured providers. Signed desktop builds
  contact the configured Akeru release host.
- Anonymous analytics send fixed aggregate counters and app, platform, architecture, and client
  dimensions when analytics is on.

## Subscription credentials

The environment server stores subscription credentials in its private secrets directory. OAuth
tokens do not pass through the WebSocket contract and do not enter projects, checkpoints, sandboxes,
or client storage. A run receives only the short-lived access that it needs.

## Privacy controls

Open **Settings > Privacy** to control anonymous analytics, product feedback, voice calls, and
provider update checks. Mobile exposes the same controls for the connected environment.

Turning a control off stops new transfers for that feature. Provider requests still leave the
environment when you run a connected online model.
