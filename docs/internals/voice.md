# Voice call capabilities

Voice services are independent of agent providers. Selecting a speech service must not change a bot's engine, model, provider instance, runtime mode, tools, or approval policy.

## Transport decisions

ChatGPT subscription calls retain the existing subscription-authenticated WebRTC conversation. OpenAI API calls use the separate billed Realtime API and a server-held API key. The server exchanges the client's SDP offer for an answer. Neither path sends a long-lived credential to the client.

Speech composition uses explicitly selected file transcription, the existing bot turn pipeline, and explicitly selected synthesis. ElevenLabs, Cartesia, and Fish Audio synthesis endpoints are not complete realtime conversation providers. The initial composition waits for a completed bot reply and does not support interruption while the bot works or speech plays. No additional hosted conversation service is required.

The selected transcription service receives the microphone recording. The bot's existing agent provider receives the resulting normal chat turn. The selected synthesis service receives the completed reply. There is no automatic fallback to a different service or billing source.

Browser media belongs on the client, including when the environment is remote. Web and Electron use browser capture and playback. Native mobile has no implemented audio capture/playback adapter and must describe this limitation rather than infer support from shared contracts.

## Capabilities and failures

`VOICE_PROVIDER_CAPABILITIES` in `packages/contracts` types what each API service can do: OpenAI API has realtime, transcription, and synthesis; ElevenLabs and Cartesia have transcription and synthesis; Fish Audio has synthesis only. Settings derives its provider lists from this table, and `voiceMissingApiProviders` names the keys a mode still needs. The server refuses a call whose selected services lack a key rather than choosing another.

Provider HTTP failures map to typed `VoiceCallError` reasons without copying provider bodies: 401 and 403 become `provider-auth`, 402 and 429 become `provider-quota`, and failed fetches become `network`. Dictation reuses the same reasons for its messages.

## Web composed transport

`startVoiceCall` returns `transport: "webrtc"` or `"composed"`. The call manager pins the settings and keys for the call at start. If the client's settings disagree with the returned transport, for example because another client changed the mode during setup, the client ends the call and asks the user to start again.

A composed call runs `runComposedVoiceCall` from `client-runtime/voice` inside a per-call `VoiceCallScope`. Each capture, transcription, turn wait, and synthesis step takes the scope's abort signal. Hangup or a failed step cancels the scope. Navigating between bots or to Settings does not. Cancelling stops capture and playback and sends `cancelVoice` for the in-flight operation. The utterance is sent with a client-chosen message id, and `correlatedVoiceReply` only speaks the assistant message of the turn whose `requestMessageId` matches. A pending approval or question refuses the utterance instead of answering it.

## Official API evidence

The following official documentation was checked on September 7, 2026, and rechecked on September 25, 2026. Model availability and account entitlements still require real provider verification.

| Service    | Capability and documented endpoint                                                                                                                                                                                                                     | Relevant constraints                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI API | [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), `POST /v1/realtime/calls`                                                                                                                                            | Multipart SDP and session configuration; server bearer authentication. Separate from ChatGPT subscription access.                                                                                  |
| OpenAI API | [Audio API](https://developers.openai.com/api/reference/resources/audio), `POST /v1/audio/transcriptions` and `/v1/audio/speech`                                                                                                                       | File transcription and bounded text synthesis. Realtime and synthesis have different built-in voice catalogs.                                                                                      |
| ElevenLabs | [File transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [streaming synthesis](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [voices](https://elevenlabs.io/docs/api-reference/voices/search)         | `xi-api-key`; `scribe_v2` for batch transcription, Flash for low-latency synthesis, paginated `/v2/voices`. Streaming synthesis is not conversation orchestration.                                 |
| Cartesia   | [File transcription](https://docs.cartesia.ai/api-reference/stt/transcribe), [synthesis formats](https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts-output-audio-format), [voices](https://docs.cartesia.ai/api-reference/voices/list) | Versioned API. Batch transcription uses `ink-whisper`; live transcription uses other models. `/tts/bytes` accepts a bounded transcript and a voice ID.                                             |
| Fish Audio | [Synthesis](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech), [voice discovery](https://docs.fish.audio/api-reference/endpoint/model/list-models)                                                                             | Explicit inference-model header; `/model` lists voice assets whose `_id` becomes `reference_id`. An unknown model header can silently fall back upstream, so selections must be validated locally. |

Fish also documents [beta file transcription](https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text). This is not evidence of live transcription or full realtime conversation support. Akeru does not use it.

The September 25 recheck found:

- OpenAI still documents `POST /v1/realtime/calls`. `gpt-4o-mini-transcribe` remains available, though OpenAI now recommends newer transcription models. OpenAI returns 429 for both rate limits and exhausted billing.
- ElevenLabs returns 402 for insufficient credits and 429 for rate limits.
- Cartesia's current API version needs no voice mode field.
- Fish `/model` without `self=true` lists public voices as well as the account's own. Akeru keeps that behavior so users can pick public voices.
- ElevenLabs, Cartesia, and Fish all offer hosted conversation agents. Akeru does not use them, because they would replace the bot's own agent.

## Agent execution and approvals

Composed speech submits through the normal bot turn path and correlates the result to the accepted request message and completed turn. It must not synthesize an unrelated latest message. Normal turn persistence owns both messages; synthesis must not append another assistant transcript.

Realtime conversation retains its transcript and `send_to_chat` handoff. Adapter events require call-scoped identities to suppress duplicate transcription events and tool invocations. Deduplication is by identity, not text, because repeating a sentence can be intentional.

Codex, Claude, Grok, Kimi For Coding, and OpenCode Go retain Mastra controller routing. Standard OpenCode retains the legacy adapter bridge. Speech does not approve tool requests or answer pending structured questions implicitly. Hangup stops media and speech operations, not already accepted chat work.

## Privacy

Long-lived API credentials belong in `ServerSecretStore` under the selected environment's secrets directory, never ordinary settings or client storage. Status responses disclose connection state without returning credentials. Provider error bodies can contain private inputs and must not be copied into errors, telemetry, or logs.

Raw audio is transient media, not an orchestration event or persistent transcript attachment. Bound input size, output size, duration, concurrency, and request lifetime. Abort and discard stale work when its owner ends the call. Keep microphone recordings, generated audio, and private transcript text out of diagnostics.

Provider retention is separate from local retention. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data), [ElevenLabs zero-retention eligibility](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode), [Cartesia enterprise zero retention](https://docs.cartesia.ai/enterprise/zero-data-retention), and [Fish privacy](https://fish.audio/privacy/). Do not promise zero retention for ordinary accounts or apply OpenAI API terms to ChatGPT subscription calls.
