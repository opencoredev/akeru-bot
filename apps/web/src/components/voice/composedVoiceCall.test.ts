import { createVoiceCallScope, runComposedVoiceCall } from "@t3tools/client-runtime/voice";
import {
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { composedVoiceAdapters, type ComposedVoiceTurnState } from "./composedVoiceCall";

const fakeAudio = { audioBase64: "AAAA", mimeType: "audio/webm" } as const;
const fakeSpeech = { audioBase64: "BBBB", mimeType: "audio/mpeg" } as const;

function completedTurn(requestMessageId: string, reply: string): ComposedVoiceTurnState {
  const latestTurn: OrchestrationLatestTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed",
    requestedAt: "2026-09-25T00:00:00.000Z",
    startedAt: null,
    completedAt: "2026-09-25T00:00:01.000Z",
    requestMessageId: MessageId.make(requestMessageId),
    assistantMessageId: MessageId.make("assistant-1"),
  };
  const message: OrchestrationMessage = {
    id: MessageId.make("assistant-1"),
    role: "assistant",
    text: reply,
    streaming: false,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-09-25T00:00:01.000Z",
    updatedAt: "2026-09-25T00:00:01.000Z",
    attachments: [],
  };
  return { latestTurn, messages: [message] };
}

/** A fake chat whose turn state changes only when the test publishes it. */
function fakeChat() {
  let state: ComposedVoiceTurnState = { latestTurn: null, messages: [] };
  const listeners = new Set<() => void>();
  return {
    readTurn: () => state,
    subscribeTurn: (changed: () => void) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    publish(next: ComposedVoiceTurnState) {
      state = next;
      for (const changed of [...listeners]) changed();
    },
    listenerCount: () => listeners.size,
  };
}

describe("composed voice call adapters", () => {
  it("transcribes, sends one chat turn, speaks the correlated reply, and stops on hangup", async () => {
    const scope = createVoiceCallScope({ botId: "bot-1", environmentId: "env-1" });
    const chat = fakeChat();
    let operation = 0;
    const transcribe = vi.fn(async () => AsyncResult.success({ text: "  hello bot  " }));
    const synthesize = vi.fn(async () => AsyncResult.success(fakeSpeech));
    const sent: string[] = [];
    let captures = 0;
    let markListeningAgain = () => {};
    const listeningAgain = new Promise<void>((resolve) => {
      markListeningAgain = resolve;
    });
    const played: string[] = [];
    const adapters = composedVoiceAdapters({
      callId: "call-1",
      newOperationId: () => `op-${++operation}`,
      capture: async (signal) => {
        captures += 1;
        if (captures === 1) return fakeAudio;
        // The second listen waits until hangup, like a silent microphone.
        markListeningAgain();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
      play: async (audio) => {
        played.push(audio.audioBase64);
      },
      transcribe,
      synthesize,
      cancel: async () => ({ cancelled: true }),
      sendMessage: async (text) => {
        sent.push(text);
        queueMicrotask(() => chat.publish(completedTurn("request-1", "Hi there")));
        return "request-1";
      },
      readTurn: chat.readTurn,
      subscribeTurn: chat.subscribeTurn,
    });

    const loop = runComposedVoiceCall(scope, adapters);
    await listeningAgain;
    scope.cancel();
    await expect(loop).rejects.toBeDefined();

    expect(transcribe).toHaveBeenCalledWith({
      operationId: "op-1",
      callId: "call-1",
      audioBase64: "AAAA",
      mimeType: "audio/webm",
    });
    expect(sent).toEqual(["hello bot"]);
    expect(synthesize).toHaveBeenCalledWith({
      operationId: "op-2",
      callId: "call-1",
      text: "Hi there",
    });
    expect(played).toEqual(["BBBB"]);
    expect(chat.listenerCount()).toBe(0);
  });

  it("surfaces the server's provider error instead of falling back", async () => {
    const adapters = composedVoiceAdapters({
      callId: "call-1",
      capture: async () => fakeAudio,
      play: async () => {},
      transcribe: async () =>
        AsyncResult.failure(Cause.fail(new Error("ElevenLabs is out of credits or rate limited."))),
      synthesize: async () => AsyncResult.success(fakeSpeech),
      cancel: async () => undefined,
      sendMessage: async () => "request-1",
      readTurn: () => ({ latestTurn: null, messages: [] }),
      subscribeTurn: () => () => {},
    });
    await expect(adapters.transcribe(fakeAudio, new AbortController().signal)).rejects.toThrow(
      "ElevenLabs is out of credits or rate limited.",
    );
  });

  it("cancels the in-flight provider operation when the call is hung up", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => ({ cancelled: true }));
    let release: (() => void) | undefined;
    const adapters = composedVoiceAdapters({
      callId: "call-1",
      newOperationId: () => "op-slow",
      capture: async () => fakeAudio,
      play: async () => {},
      transcribe: async () => AsyncResult.success({ text: "x" }),
      synthesize: () =>
        new Promise((resolve) => {
          release = () => resolve(AsyncResult.success(fakeSpeech));
        }),
      cancel,
      sendMessage: async () => "request-1",
      readTurn: () => ({ latestTurn: null, messages: [] }),
      subscribeTurn: () => () => {},
    });
    const speaking = adapters.synthesize("Long reply", controller.signal);
    controller.abort();
    release?.();
    await expect(speaking).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalledWith("op-slow");
  });

  it("stops when the chat refuses the utterance or the bot turn fails", async () => {
    const chat = fakeChat();
    const refused = composedVoiceAdapters({
      callId: "call-1",
      capture: async () => fakeAudio,
      play: async () => {},
      transcribe: async () => AsyncResult.success({ text: "x" }),
      synthesize: async () => AsyncResult.success(fakeSpeech),
      cancel: async () => undefined,
      sendMessage: async () => null,
      readTurn: chat.readTurn,
      subscribeTurn: chat.subscribeTurn,
    });
    await expect(refused.sendAndWait("hello", new AbortController().signal)).rejects.toThrow(
      "The chat did not accept the message. Continue in chat.",
    );

    const failing = composedVoiceAdapters({
      callId: "call-1",
      capture: async () => fakeAudio,
      play: async () => {},
      transcribe: async () => AsyncResult.success({ text: "x" }),
      synthesize: async () => AsyncResult.success(fakeSpeech),
      cancel: async () => undefined,
      sendMessage: async () => "request-1",
      readTurn: chat.readTurn,
      subscribeTurn: chat.subscribeTurn,
    });
    const waiting = failing.sendAndWait("hello", new AbortController().signal);
    const failed = completedTurn("request-1", "");
    chat.publish({ ...failed, latestTurn: { ...failed.latestTurn!, state: "error" } });
    await expect(waiting).rejects.toThrow("The bot turn did not complete. Continue in chat.");
    expect(chat.listenerCount()).toBe(0);
  });

  it("speaks the finished voice reply after a newer chat turn replaces it", async () => {
    const chat = fakeChat();
    let markSubscribed!: () => void;
    const subscribed = new Promise<void>((resolve) => {
      markSubscribed = resolve;
    });
    const adapters = composedVoiceAdapters({
      callId: "call-1",
      capture: async () => fakeAudio,
      play: async () => {},
      transcribe: async () => AsyncResult.success({ text: "x" }),
      synthesize: async () => AsyncResult.success(fakeSpeech),
      cancel: async () => undefined,
      sendMessage: async () => "request-1",
      readTurn: chat.readTurn,
      subscribeTurn: (changed) => {
        markSubscribed();
        return chat.subscribeTurn(changed);
      },
    });
    const waiting = adapters.sendAndWait("hello", new AbortController().signal);
    const voiceTurn = completedTurn("request-1", "Done.");
    const reply = voiceTurn.messages[0]!;
    const request: OrchestrationMessage = {
      ...reply,
      id: MessageId.make("request-1"),
      role: "user",
      text: "hello",
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    const newerTurn: OrchestrationLatestTurn = {
      ...voiceTurn.latestTurn!,
      turnId: TurnId.make("turn-2"),
      requestMessageId: MessageId.make("request-2"),
      requestedAt: "2026-09-25T00:00:02.000Z",
      state: "running",
      completedAt: null,
    };
    await subscribed;
    chat.publish({
      latestTurn: { ...voiceTurn.latestTurn!, state: "running", completedAt: null },
      messages: [request, { ...reply, streaming: true }],
    });
    chat.publish({ latestTurn: newerTurn, messages: [request, { ...reply, streaming: true }] });
    expect(chat.listenerCount()).toBe(1);
    chat.publish({ latestTurn: newerTurn, messages: [request, reply] });
    await expect(waiting).resolves.toBe("Done.");
    expect(chat.listenerCount()).toBe(0);
  });
});
