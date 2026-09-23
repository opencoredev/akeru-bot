# Voice call capabilities

Voice services are independent of agent providers. Selecting a speech service must not change a bot's engine, model, provider instance, runtime mode, tools, or approval policy.

## Transport decisions

ChatGPT subscription calls retain the existing subscription-authenticated WebRTC conversation. OpenAI API calls use the separate billed Realtime API and a server-held API key. The server exchanges the client's SDP offer for an answer. Neither path sends a long-lived credential to the client.

Speech composition uses explicitly selected file transcription, the existing bot turn pipeline, and explicitly selected synthesis. ElevenLabs, Cartesia, and Fish Audio synthesis endpoints are not complete realtime conversation providers. The initial composition waits for a completed bot reply and does not support interruption while the bot works or speech plays. No additional hosted conversation service is required.

The selected transcription service receives the microphone recording. The bot's existing agent provider receives the resulting normal chat turn. The selected synthesis service receives the completed reply. There is no automatic fallback to a different service or billing source.

Browser media belongs on the client, including when the environment is remote. Web and Electron use browser capture and playback. Native mobile has no implemented audio capture/playback adapter and must describe this limitation rather than infer support from shared contracts.

## Official API evidence

The following official documentation was checked on September 7, 2026. Model availability and account entitlements still require real provider verification.

| Service    | Capability and documented endpoint                                                                                                                                                                                                                     | Relevant constraints                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI API | [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), `POST /v1/realtime/calls`                                                                                                                                            | Multipart SDP and session configuration; server bearer authentication. Separate from ChatGPT subscription access.                                                                                  |
| OpenAI API | [Audio API](https://developers.openai.com/api/reference/resources/audio), `POST /v1/audio/transcriptions` and `/v1/audio/speech`                                                                                                                       | File transcription and bounded text synthesis. Realtime and synthesis have different built-in voice catalogs.                                                                                      |
| ElevenLabs | [File transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [streaming synthesis](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [voices](https://elevenlabs.io/docs/api-reference/voices/search)         | `xi-api-key`; `scribe_v2` for batch transcription, Flash for low-latency synthesis, paginated `/v2/voices`. Streaming synthesis is not conversation orchestration.                                 |
| Cartesia   | [File transcription](https://docs.cartesia.ai/api-reference/stt/transcribe), [synthesis formats](https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts-output-audio-format), [voices](https://docs.cartesia.ai/api-reference/voices/list) | Versioned API. Batch transcription uses `ink-whisper`; live transcription uses other models. `/tts/bytes` accepts a bounded transcript and a voice ID.                                             |
| Fish Audio | [Synthesis](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech), [voice discovery](https://docs.fish.audio/api-reference/endpoint/model/list-models)                                                                             | Explicit inference-model header; `/model` lists voice assets whose `_id` becomes `reference_id`. An unknown model header can silently fall back upstream, so selections must be validated locally. |

Fish also documents [beta file transcription](https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text). This is not evidence of live transcription or full realtime conversation support. OpenAI's current live-transcription guide and model-routing page differ on the new live model's handshake; file transcription avoids relying on that unresolved route.

## Agent execution and approvals

Composed speech submits through the normal bot turn path and correlates the result to the accepted request message and completed turn. It must not synthesize an unrelated latest message. Normal turn persistence owns both messages; synthesis must not append another assistant transcript.

Realtime conversation retains its transcript and `send_to_chat` handoff. Adapter events require call-scoped identities to suppress duplicate transcription events and tool invocations. Deduplication is by identity, not text, because repeating a sentence can be intentional.

Codex and Kimi For Coding retain Mastra controller routing. Claude, Grok, and OpenCode retain the legacy adapter bridge. The existing OpenCode Go registration must also remain intact. Speech does not approve tool requests or answer pending structured questions implicitly. Hangup stops media and speech operations, not already accepted chat work.

## Privacy

Long-lived API credentials belong in `ServerSecretStore` under the selected environment's secrets directory, never ordinary settings or client storage. Status responses disclose connection state without returning credentials. Provider error bodies can contain private inputs and must not be copied into errors, telemetry, or logs.

Raw audio is transient media, not an orchestration event or persistent transcript attachment. Bound input size, output size, duration, concurrency, and request lifetime. Abort and discard stale work when its owner ends the call. Keep microphone recordings, generated audio, and private transcript text out of diagnostics.

Provider retention is separate from local retention. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data), [ElevenLabs zero-retention eligibility](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode), [Cartesia enterprise zero retention](https://docs.cartesia.ai/enterprise/zero-data-retention), and [Fish privacy](https://fish.audio/privacy/). Do not promise zero retention for ordinary accounts or apply OpenAI API terms to ChatGPT subscription calls.
