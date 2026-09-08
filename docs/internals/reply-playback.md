# Stored-reply playback

LEO-402 owns reading an existing assistant message on the current client.
LEO-401 owns speech-provider credentials, synthesis operations, and live-call
audio. This client must not add a second key store or generate a new bot turn
to produce speech.

## Playback identity

One playback owner exists per client. Identity is environment, thread,
message, content version (`updatedAt`), provider, and voice. Replacing the
identity, changing content, navigating, disconnecting, logging out, or
starting a live call cancels in-flight generation and releases the media
handle. At most one in-memory audio resource is retained.

## Spoken text

`replyMarkdownToSpokenText` converts stored Markdown to speech text. It keeps
prose, link labels, labeled table rows, and inline code. Fenced or indented
code and images are skipped with a disclosure. Empty, code-only, and oversized
replies are not speakable. Limits are 100,000 source characters and 20,000
spoken UTF-16 code units, with no silent truncation.

## Automatic readout

The preference is client-local, off by default, and stored as a boolean only.
The tracker hydrates the current chat's already-loaded assistant messages,
then accepts later completions in that chat. History loads, reconnects, and
message edits do not replay.

## Synthesis boundary

Until LEO-401 exposes a stored-text synthesis operation, the client reports
that stored-reply speech is unavailable. ChatGPT realtime remains a live call
and must not be used as a TTS fallback. Platform adapters
(`createBrowserReplyAudio`, `createExpoReplyAudio`) accept already-decoded
audio bytes and own temporary object URLs or cache files.

## Privacy

Do not log spoken text, audio bytes, or provider error payloads. Errors shown
in the UI are generic recovery copy.
