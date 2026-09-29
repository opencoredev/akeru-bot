import { describe, expect, it, vi } from "vite-plus/test";
import {
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import {
  correlatedVoiceReply,
  createRealtimeVoiceSession,
  createVoiceCallScope,
  handleVoiceChannelMessage,
  runComposedVoiceCall,
  runVoiceOperation,
  splitVoiceSynthesisText,
  synthesizeVoiceChunks,
  waitForVoiceReply,
  type VoiceAudio,
} from "./voice.ts";

describe("stored speech chunking", () => {
  it("splits at the synthesis input limit", () => {
    expect(splitVoiceSynthesisText("a".repeat(8_001)).map((chunk) => chunk.length)).toEqual([
      4_000, 4_000, 1,
    ]);
  });

  it("prefers sentence and whitespace boundaries", () => {
    expect(splitVoiceSynthesisText("a".repeat(3_995) + ". next")[0]).toBe("a".repeat(3_995) + ".");
    expect(splitVoiceSynthesisText("a".repeat(3_995) + " wordx")[0]).toBe("a".repeat(3_995) + " ");
  });

  it("does not split surrogate pairs and hard-cuts a single long word", () => {
    const emoji = "😀";
    const chunks = splitVoiceSynthesisText("a".repeat(3_999) + emoji + "b".repeat(10));
    expect(chunks[0]?.endsWith("\uD83D")).toBe(false);
    expect(chunks.join("")).toBe("a".repeat(3_999) + emoji + "b".repeat(10));
    expect(splitVoiceSynthesisText("x".repeat(4_500)).map((chunk) => chunk.length)).toEqual([
      4_000, 500,
    ]);
  });

  it("stops requesting chunks after cancellation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    await expect(
      synthesizeVoiceChunks("x".repeat(8_001), controller.signal, async (chunk) => {
        calls.push(chunk);
        controller.abort();
        return chunk;
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const identity = { botId: "bot-a", environmentId: "environment-a" };
const audio: VoiceAudio = { audioBase64: "YQ==", mimeType: "audio/webm" };
const makeHandlers = () => ({
  appendTranscript: vi.fn(),
  sendGoalMessage: vi.fn(() => Promise.resolve(true)),
  speechStarted: vi.fn(),
  speechFinished: vi.fn(),
  sessionFailed: vi.fn(),
});

function toolEvent(eventId: string, callId = "function-1") {
  return JSON.stringify({
    type: "response.function_call_arguments.done",
    event_id: eventId,
    name: "send_to_chat",
    call_id: callId,
    arguments: JSON.stringify({ message: "Run tests" }),
  });
}

describe("normalized realtime voice session", () => {
  it("deduplicates transcript event IDs and function call IDs across reconnect delivery", async () => {
    const handlers = makeHandlers();
    const session = createRealtimeVoiceSession(createVoiceCallScope(identity), handlers, vi.fn());
    const transcript = JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "transcript-1",
      transcript: "Hello",
    });
    session.receive(transcript);
    session.receive(transcript);
    session.receive(toolEvent("event-1"));
    session.receive(toolEvent("event-2"));
    session.receive(toolEvent("event-1"));
    await Promise.resolve();
    expect(handlers.appendTranscript).toHaveBeenCalledOnce();
    expect(handlers.sendGoalMessage).toHaveBeenCalledOnce();
  });

  it("remembers only recent event IDs during a long call", () => {
    const handlers = makeHandlers();
    const state = { eventIds: new Set<string>(), functionCallIds: new Set<string>() };
    for (let index = 0; index < 10_000; index++) {
      handleVoiceChannelMessage(
        JSON.stringify({ type: "session.updated", event_id: `event-${index}` }),
        handlers,
        () => {},
        state,
      );
    }
    expect(state.eventIds.size).toBe(4_096);
    expect(state.eventIds.has("event-9999")).toBe(true);
    expect(state.eventIds.has("event-0")).toBe(false);
  });

  it.each(["response.output_audio_transcript.done", "response.audio_transcript.done"])(
    "normalizes %s for both WebRTC providers",
    (type) => {
      const handlers = makeHandlers();
      const session = createRealtimeVoiceSession(createVoiceCallScope(identity), handlers, vi.fn());
      session.receive(JSON.stringify({ type, event_id: "assistant-1", transcript: " Hello. " }));
      expect(handlers.appendTranscript).toHaveBeenCalledWith("assistant", "Hello.");
    },
  );

  it("pins identity and handlers, suppressing pending replies and events after hangup", async () => {
    const source = { ...identity };
    const scope = createVoiceCallScope(source);
    source.botId = "bot-b";
    const delivery = deferred<boolean>();
    const handlers = makeHandlers();
    const originalSend = handlers.sendGoalMessage;
    originalSend.mockReturnValue(delivery.promise);
    const reply = vi.fn();
    const session = createRealtimeVoiceSession(scope, handlers, reply);
    handlers.sendGoalMessage = vi.fn(() => Promise.resolve(false));
    session.receive(toolEvent("event-1"));
    scope.cancel();
    delivery.resolve(true);
    await delivery.promise;
    await Promise.resolve();
    await Promise.resolve();
    session.receive(toolEvent("event-2", "function-2"));
    expect(scope.identity).toEqual(identity);
    expect(originalSend).toHaveBeenCalledOnce();
    expect(handlers.sendGoalMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("creates fresh dedup state only for a new call", () => {
    const handlers = makeHandlers();
    for (let index = 0; index < 2; index += 1) {
      createRealtimeVoiceSession(createVoiceCallScope(identity), handlers, vi.fn()).receive(
        toolEvent("same-event"),
      );
    }
    expect(handlers.sendGoalMessage).toHaveBeenCalledTimes(2);
  });

  it("does not show provider diagnostics from realtime error events", () => {
    const handlers = makeHandlers();
    const session = createRealtimeVoiceSession(createVoiceCallScope(identity), handlers, vi.fn());
    session.receive(
      JSON.stringify({ type: "error", error: { message: "secret token in upstream trace" } }),
    );
    expect(handlers.sessionFailed).toHaveBeenCalledWith(
      "The voice session failed. Start a new call to continue.",
    );
  });
});

describe("composed voice lifecycle", () => {
  it("sequences capture, transcription, normal bot turn, synthesis and drained playback without interruption", async () => {
    const scope = createVoiceCallScope(identity);
    const playing = deferred<void>();
    const playbackStarted = deferred<void>();
    const capture = vi.fn(async () => audio);
    const transcribe = vi.fn(async () => "Hello");
    const sendAndWait = vi.fn(async () => "Reply");
    const synthesize = vi.fn(async () => audio);
    const play = vi.fn(() => {
      playbackStarted.resolve();
      return playing.promise;
    });
    const running = runComposedVoiceCall(scope, {
      capture,
      transcribe,
      sendAndWait,
      synthesize,
      play,
    });
    const stopped = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await playbackStarted.promise;
    expect(capture).toHaveBeenCalledOnce();
    expect(sendAndWait).toHaveBeenCalledWith("Hello", scope.signal);
    expect(synthesize).toHaveBeenCalledWith("Reply", scope.signal);
    scope.cancel();
    playing.resolve();
    await stopped;
    expect(capture).toHaveBeenCalledOnce();
  });

  it("plays the first chunk of a long reply before the rest is synthesized", async () => {
    const scope = createVoiceCallScope(identity);
    const second = deferred<VoiceAudio>();
    const firstPlayed = deferred<void>();
    const synthesize = vi
      .fn<(text: string) => Promise<VoiceAudio>>()
      .mockResolvedValueOnce(audio)
      .mockReturnValueOnce(second.promise);
    const running = runComposedVoiceCall(scope, {
      capture: async () => audio,
      transcribe: async () => "Hello",
      sendAndWait: async () => "x".repeat(4_001),
      synthesize,
      play: async () => {
        firstPlayed.resolve();
        scope.cancel();
      },
    });
    const stopped = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await firstPlayed.promise;
    expect(synthesize).toHaveBeenCalledTimes(2);
    second.resolve(audio);
    await stopped;
  });

  it("never submits a transcript that arrives after cancellation", async () => {
    const scope = createVoiceCallScope(identity);
    const transcription = deferred<string>();
    const started = deferred<void>();
    const sendAndWait = vi.fn(async () => "Reply");
    const running = runComposedVoiceCall(scope, {
      capture: async () => audio,
      transcribe: () => {
        started.resolve();
        return transcription.promise;
      },
      sendAndWait,
      synthesize: async () => audio,
      play: async () => {},
    });
    const stopped = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    scope.cancel();
    transcription.resolve("Do dangerous work");
    await stopped;
    expect(sendAndWait).not.toHaveBeenCalled();
  });

  it("cancels exactly the in-flight audio operation and ignores its late result", async () => {
    const scope = createVoiceCallScope(identity);
    const result = deferred<string>();
    const execute = vi.fn<(operationId: string) => Promise<string>>(() => result.promise);
    const cancel = vi.fn(async () => ({}));
    const operation = runVoiceOperation(scope.signal, execute, cancel, "operation-1");
    const stopped = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    scope.cancel();
    expect(cancel).toHaveBeenCalledWith(execute.mock.calls[0]?.[0]);
    result.resolve("late");
    await stopped;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

const latestTurn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: "2026-09-07T00:00:00.000Z",
  startedAt: null,
  completedAt: "2026-09-07T00:00:01.000Z",
  requestMessageId: MessageId.make("request-1"),
  assistantMessageId: MessageId.make("assistant-1"),
};
const assistant: OrchestrationMessage = {
  id: MessageId.make("assistant-1"),
  role: "assistant",
  text: "Exact reply",
  streaming: false,
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-09-07T00:00:01.000Z",
  updatedAt: "2026-09-07T00:00:01.000Z",
  attachments: [],
};

describe("accepted bot turn correlation", () => {
  it("finds a completed voice reply after a newer chat turn replaces latestTurn", () => {
    const request: OrchestrationMessage = {
      ...assistant,
      id: MessageId.make("request-1"),
      role: "user",
      text: "Voice request",
      createdAt: "2026-09-07T00:00:00.000Z",
    };
    const newerTurn: OrchestrationLatestTurn = {
      ...latestTurn,
      turnId: TurnId.make("turn-2"),
      requestMessageId: MessageId.make("request-2"),
      requestedAt: "2026-09-07T00:00:02.000Z",
    };
    expect(correlatedVoiceReply("request-1", newerTurn, [request, assistant])).toBe("Exact reply");
    expect(() => correlatedVoiceReply("request-1", newerTurn, [request])).toThrow(
      "The bot turn did not complete",
    );
    // Once the voice turn was seen running, a replacement hides how it ended.
    expect(() => correlatedVoiceReply("request-1", newerTurn, [request, assistant], true)).toThrow(
      "The bot turn did not complete",
    );
  });

  it("requires both accepted requestMessageId and assistantMessageId, never the last message", () => {
    const unrelated = { ...assistant, id: MessageId.make("other"), text: "Unrelated" };
    expect(correlatedVoiceReply("request-1", latestTurn, [assistant, unrelated])).toBe(
      "Exact reply",
    );
    expect(correlatedVoiceReply("request-other", latestTurn, [assistant])).toBeNull();
    expect(correlatedVoiceReply("request-1", latestTurn, [unrelated])).toBeNull();
    expect(
      correlatedVoiceReply("request-1", { ...latestTurn, state: "running" }, [assistant]),
    ).toBeNull();
    expect(
      correlatedVoiceReply("request-1", latestTurn, [{ ...assistant, streaming: true }]),
    ).toBeNull();
  });

  it("settles a completed turn that has no assistant message with nothing to speak", () => {
    expect(correlatedVoiceReply("request-1", { ...latestTurn, assistantMessageId: null }, [])).toBe(
      "",
    );
    expect(
      correlatedVoiceReply(
        "request-1",
        { ...latestTurn, state: "running", assistantMessageId: null },
        [],
      ),
    ).toBeNull();
  });

  it("waits on state notifications and removes subscriptions on completion or abort", async () => {
    let value: string | null = null;
    let notify = () => {};
    const unsubscribe = vi.fn();
    const scope = createVoiceCallScope(identity);
    const waiting = waitForVoiceReply(
      scope.signal,
      () => value,
      (changed) => {
        notify = changed;
        return unsubscribe;
      },
    );
    notify();
    expect(unsubscribe).not.toHaveBeenCalled();
    value = "Exact reply";
    notify();
    await expect(waiting).resolves.toBe("Exact reply");
    expect(unsubscribe).toHaveBeenCalledOnce();
    const aborted = waitForVoiceReply(
      scope.signal,
      () => null,
      () => unsubscribe,
    );
    const stopped = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    scope.cancel();
    await stopped;
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
