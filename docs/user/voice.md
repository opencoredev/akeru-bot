# Voice calls

Call a bot from its chat using the microphone and speaker on your current client. Calls work in web and desktop. Native mobile audio calls are not supported. Mobile's voice privacy switch controls whether the connected environment permits web and desktop calls.

## Choose how the call works

Open **Settings > Voice**, enable voice, and pick a mode under **Voice provider**. Enable **Voice calls** for the bot, then use its phone button.

| Call mode                | What it does                                                                                                              | Access and billing                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ChatGPT subscription     | Direct realtime conversation. Requests needing files, tools, workspace access, or permissions continue in the bot's chat. | Uses the ChatGPT subscription connected to the environment.                                                   |
| OpenAI API realtime      | Direct realtime conversation with chat handoff for workspace work.                                                        | Requires an OpenAI API key and uses separate API billing. Your ChatGPT subscription does not cover this path. |
| Transcribe, reply, speak | Records an utterance, transcribes it, runs the bot's normal chat turn, then speaks the completed reply.                   | Uses the explicitly selected transcription and synthesis services, plus the bot's existing agent access.      |

Selecting a voice service never changes the bot's agent provider, model, or permissions. A failed service does not silently switch to another service or billing source.

In **Transcribe, reply, speak** calls, the microphone pauses while the bot works and while its reply plays. These calls do not support interruption. Approvals and questions requiring explicit input remain in chat. If the bot is waiting for an answer, the call ends and the chat shows "Answer the bot's question in chat, then keep talking." Answer in chat, then start a new call. A long agent turn takes longer to speak than a direct realtime answer.

## Connect API services

In **Settings > Voice > API connections**:

1. Paste the service's API key and select **Connect**. For an existing connection, select **Replace key**, paste the new key, and select **Save key**. Keys are stored on the selected environment server and are not returned to clients.
2. Select **Test**. This checks API access, not whether every paid audio capability works for your account.
3. For **Transcribe, reply, speak**, choose a **Transcription provider** and a **Speech provider**, then choose a **Speech voice** from that service's list. Select **More voices** to load the next page.

| Service    | Supported by Akeru                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| OpenAI API | Realtime conversation, file transcription, speech synthesis.                     |
| ElevenLabs | File transcription and speech synthesis.                                         |
| Cartesia   | File transcription and speech synthesis.                                         |
| Fish Audio | Speech synthesis. Select another supported service explicitly for transcription. |

Speech synthesis alone is not a complete realtime conversation service. ElevenLabs, Cartesia, and Fish Audio calls use the composed mode rather than replacing the bot with a separate hosted conversation agent.

To remove a key, select **Disconnect** next to the service. This does not remove the ChatGPT subscription or select a fallback. Existing ChatGPT settings and voice choices remain separate from API settings.

Settings changes apply to new calls. An active call keeps the services, voices, and credentials it started with. Hang up before replacing or disconnecting a credential used by that call.

## Navigation and recovery

Only one call can run in an environment at a time. The call bar remains visible when you navigate to another bot or Settings. Select it to return to the call, or use **Hang up**. Cancel a pending call with the call bar's cancel control.

Hangup stops microphone capture, playback, and pending speech operations. Work already accepted in chat continues under the normal chat controls and approval rules.

If microphone access is denied, allow it in the browser or operating-system settings and try again. If the device disconnects, reconnect it and start a new call. For a remote browser, use a secure HTTPS connection or an established local secure connection; plain HTTP on another machine does not provide browser microphone access.

Provider errors name the problem without switching services:

- "The voice provider rejected the API key" means the key is wrong, revoked, or lacks access. Replace the key and test it.
- "The voice provider reported a quota, billing, or rate limit" means the service refused the request for quota, billing, or rate limits. Check that service's account.
- "Could not reach the voice provider" means a network failure. Restore the connection and start a new call.

If the environment disconnects, reconnect and start a new call. Akeru does not resume a disconnected call by billing a different provider.

## Audio and transcript privacy

Direct realtime calls send microphone audio to ChatGPT or OpenAI's Realtime service. Composed calls send recorded audio through the environment server to the selected transcription service. The bot's existing agent receives the resulting chat turn, and the synthesis service receives the completed reply text.

Akeru does not persist raw call recordings or generated audio. Call transcripts and normal bot messages remain in chat history. Audio is processed in bounded temporary buffers. Credentials, raw audio, and private transcript text must not appear in diagnostics or telemetry.

Each service controls its own processing and retention. API access does not imply zero retention. See [Privacy and outbound data](privacy.md) and your provider's current terms. Calls do not enable composer dictation or automatic playback of other chat replies.
