import type { OrchestrationLatestTurn, OrchestrationMessage } from "@t3tools/contracts";

export interface VoiceAudio {
  readonly audioBase64: string;
  readonly mimeType: "audio/webm" | "audio/wav" | "audio/mpeg" | "audio/mp4" | "audio/ogg";
}

export const VOICE_SYNTHESIS_MAX_CHARS = 4_000;

/** Splits stored speech at the server's synthesis input limit. MP3 segments are concatenated by clients. */
export function splitVoiceSynthesisText(text: string): ReadonlyArray<string> {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const limit = Math.min(offset + VOICE_SYNTHESIS_MAX_CHARS, text.length);
    if (limit === text.length) {
      chunks.push(text.slice(offset));
      break;
    }
    const candidate = text.slice(offset, limit);
    const sentence = [...candidate.matchAll(/[.!?。！？](?=\s|$)/g)].at(-1)?.index;
    const whitespace = [...candidate.matchAll(/\s/g)].at(-1)?.index;
    let end =
      sentence !== undefined
        ? offset + sentence + 1
        : whitespace !== undefined
          ? offset + whitespace + 1
          : limit;
    if (end <= offset) end = limit;
    if (end > offset && /[\uD800-\uDBFF]$/.test(text.slice(offset, end))) end -= 1;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export async function synthesizeVoiceChunks<T>(
  text: string,
  signal: AbortSignal,
  synthesize: (chunk: string) => Promise<T>,
): Promise<ReadonlyArray<T>> {
  const results: T[] = [];
  for (const chunk of splitVoiceSynthesisText(text)) {
    signal.throwIfAborted();
    results.push(await synthesize(chunk));
    signal.throwIfAborted();
  }
  return results;
}

/** Shared by call-bound audio and standalone dictation/read-aloud adapters. */
export async function runVoiceOperation<T>(
  signal: AbortSignal,
  execute: (operationId: string) => Promise<T>,
  cancel: (operationId: string) => Promise<unknown>,
  operationId: string,
): Promise<T> {
  signal.throwIfAborted();
  const onAbort = () => {
    void cancel(operationId).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await execute(operationId);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Finds the reply to speak for the voice turn started by `requestMessageId`.
 * If a newer chat turn has already replaced it as the latest turn, the voice
 * turn's final reply is still spoken, once none of its messages are streaming.
 */
export function correlatedVoiceReply(
  requestMessageId: string,
  latestTurn: OrchestrationLatestTurn | null,
  messages: readonly OrchestrationMessage[],
): string | null {
  if (latestTurn?.requestMessageId === requestMessageId) {
    if (latestTurn.state === "error" || latestTurn.state === "interrupted") {
      throw new Error("The bot turn did not complete. Continue in chat.");
    }
    if (latestTurn.state !== "completed") return null;
    // A completed turn without an assistant message has nothing to speak.
    if (latestTurn.assistantMessageId === null) return "";
    const message = messages.find((item) => item.id === latestTurn.assistantMessageId);
    return message?.role === "assistant" && !message.streaming ? message.text : null;
  }
  const request = messages.find((item) => item.id === requestMessageId && item.role === "user");
  if (!request?.turnId) return null;
  const replies = messages.filter(
    (item) => item.turnId === request.turnId && item.role === "assistant",
  );
  if (replies.some((item) => item.streaming)) return null;
  const reply = replies.at(-1);
  if (reply) return reply.text;
  if (latestTurn && latestTurn.requestedAt > request.createdAt) {
    throw new Error("The bot turn did not complete. Continue in chat.");
  }
  return null;
}

export function waitForVoiceReply(
  signal: AbortSignal,
  read: () => string | null,
  subscribe: (changed: () => void) => () => void,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (text: string | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve(text ?? "");
    };
    const aborted = () => finish(null, signal.reason);
    const changed = () => {
      try {
        const text = read();
        if (text !== null) finish(text);
      } catch (error) {
        finish(null, error);
      }
    };
    signal.addEventListener("abort", aborted, { once: true });
    unsubscribe = subscribe(changed);
    if (settled) unsubscribe();
    else changed();
  });
}

export interface ComposedVoiceAdapters {
  readonly capture: (signal: AbortSignal) => Promise<VoiceAudio>;
  readonly transcribe: (audio: VoiceAudio, signal: AbortSignal) => Promise<string>;
  readonly sendAndWait: (text: string, signal: AbortSignal) => Promise<string>;
  readonly synthesize: (text: string, signal: AbortSignal) => Promise<VoiceAudio>;
  readonly play: (audio: VoiceAudio, signal: AbortSignal) => Promise<void>;
}

/** Capture resumes only after the accepted bot turn and all playback have finished. */
export async function runComposedVoiceCall(scope: VoiceCallScope, adapters: ComposedVoiceAdapters) {
  const pinned = { ...adapters };
  const { signal } = scope;
  while (!signal.aborted) {
    const audio = await pinned.capture(signal);
    signal.throwIfAborted();
    const text = (await pinned.transcribe(audio, signal)).trim();
    signal.throwIfAborted();
    if (!text) continue;
    const response = await pinned.sendAndWait(text, signal);
    signal.throwIfAborted();
    // Provider requests are bounded; play long responses sequentially, never concurrently.
    // The next chunk is synthesized while the current one plays so speech starts early.
    const chunks = splitVoiceSynthesisText(response);
    let next = chunks[0] === undefined ? undefined : pinned.synthesize(chunks[0], signal);
    for (let index = 0; next; index += 1) {
      const speech = await next;
      signal.throwIfAborted();
      const following = chunks[index + 1];
      next = following === undefined ? undefined : pinned.synthesize(following, signal);
      // Playback failure must not leave the prefetched request unhandled.
      next?.catch(() => undefined);
      await pinned.play(speech, signal);
      signal.throwIfAborted();
    }
  }
}

export interface VoiceCallIdentity {
  readonly botId: string;
  readonly environmentId: string;
}

export function createVoiceCallScope(identity: VoiceCallIdentity) {
  const controller = new AbortController();
  return {
    identity: Object.freeze({ ...identity }),
    signal: controller.signal,
    cancel: () => controller.abort(),
  };
}

export type VoiceCallScope = ReturnType<typeof createVoiceCallScope>;

export function createRealtimeVoiceSession(
  scope: VoiceCallScope,
  handlers: VoiceCallChatHandlers,
  reply: (payload: string) => void,
) {
  const state = { eventIds: new Set<string>(), functionCallIds: new Set<string>() };
  const snapshot = { ...handlers };
  const pinnedHandlers: VoiceCallChatHandlers = {
    appendTranscript: (role, text) => {
      if (!scope.signal.aborted) return snapshot.appendTranscript(role, text);
    },
    sendGoalMessage: (text) => (scope.signal.aborted ? false : snapshot.sendGoalMessage(text)),
    speechStarted: () => {
      if (!scope.signal.aborted) snapshot.speechStarted();
    },
    speechFinished: () => {
      if (!scope.signal.aborted) snapshot.speechFinished();
    },
    sessionFailed: (message) => {
      if (!scope.signal.aborted) snapshot.sessionFailed(message);
    },
  };
  return {
    receive(raw: string) {
      if (scope.signal.aborted) return;
      handleVoiceChannelMessage(
        raw,
        pinnedHandlers,
        (payload) => {
          if (!scope.signal.aborted) reply(payload);
        },
        state,
      );
    },
  };
}

export interface VoiceCallChatHandlers {
  readonly appendTranscript: (role: "user" | "assistant", text: string) => void | Promise<void>;
  readonly sendGoalMessage: (text: string) => boolean | Promise<boolean>;
  readonly speechStarted: () => void;
  readonly speechFinished: () => void;
  readonly sessionFailed: (message: string) => void;
}

function invokeVoiceHandler<T>(execute: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(execute());
  } catch (error) {
    return Promise.reject(error);
  }
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

const VOICE_EVENT_ID_MEMORY = 4_096;

export function handleVoiceChannelMessage(
  raw: string,
  handlers: VoiceCallChatHandlers,
  reply: (payload: string) => void = () => {},
  state = { eventIds: new Set<string>(), functionCallIds: new Set<string>() },
): void {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  const eventId = stringField(event, "event_id");
  if (eventId !== null) {
    if (state.eventIds.has(eventId)) return;
    state.eventIds.add(eventId);
    // Replays arrive close to the original, so only recent ids need remembering.
    if (state.eventIds.size > VOICE_EVENT_ID_MEMORY) {
      state.eventIds.delete(state.eventIds.values().next().value!);
    }
  }
  const type = stringField(event, "type");
  const transcript = stringField(event, "transcript")?.trim() ?? "";
  if (type === "conversation.item.input_audio_transcription.completed" && transcript.length > 0) {
    void invokeVoiceHandler(() => handlers.appendTranscript("user", transcript)).catch(() =>
      handlers.sessionFailed("Could not save the voice transcript."),
    );
    return;
  }
  if (
    (type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done") &&
    transcript.length > 0
  ) {
    void invokeVoiceHandler(() => handlers.appendTranscript("assistant", transcript)).catch(() =>
      handlers.sessionFailed("Could not save the voice transcript."),
    );
    return;
  }
  if (type === "output_audio_buffer.started") {
    handlers.speechStarted();
    return;
  }
  if (type === "output_audio_buffer.stopped") {
    handlers.speechFinished();
    return;
  }
  if (type === "response.done") {
    const response =
      typeof event === "object" && event !== null
        ? (event as Record<string, unknown>).response
        : null;
    const status = stringField(response, "status");
    if (status !== "completed" && status !== "cancelled" && status !== "incomplete") {
      handlers.sessionFailed("The voice response failed.");
    }
    return;
  }
  if (
    type === "response.function_call_arguments.done" &&
    stringField(event, "name") === "send_to_chat"
  ) {
    const callId = stringField(event, "call_id");
    if (callId === null || state.functionCallIds.has(callId)) return;
    state.functionCallIds.add(callId);
    const finish = (output: Record<string, unknown>) => {
      if (callId === null) return;
      reply(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(output),
          },
        }),
      );
      reply(JSON.stringify({ type: "response.create" }));
    };
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(stringField(event, "arguments") ?? "");
    } catch {
      finish({ ok: false, error: "Could not parse the tool arguments." });
      return;
    }
    const message = stringField(parsedArguments, "message")?.trim() ?? "";
    if (message.length === 0) {
      finish({ ok: false, error: "The message was empty." });
      return;
    }
    void invokeVoiceHandler(() => handlers.sendGoalMessage(message))
      .catch(() => false)
      .then((delivered) =>
        finish(
          delivered
            ? { ok: true, delivered: "chat" }
            : { ok: false, error: "The chat did not accept the message." },
        ),
      );
    return;
  }
  if (type === "error") {
    handlers.sessionFailed("The voice session failed. Start a new call to continue.");
  }
}
