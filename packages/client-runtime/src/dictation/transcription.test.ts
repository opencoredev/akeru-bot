import { Cause } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DictationDraft } from "./draft.ts";
import { createDictationSession } from "./session.ts";
import {
  DICTATION_TRANSCRIPTION_UNAVAILABLE,
  createVoiceDictationTranscriber,
  dictationAudioMediaType,
  dictationTranscriptionCapability,
  encodeDictationAudioBase64,
} from "./transcription.ts";

const identity = { environmentId: "env-1", threadId: "thread", draftId: "draft", generation: 0 };
const audio = {
  bytes: new Uint8Array([104, 105]),
  durationMs: 900,
  mediaType: "audio/webm;codecs=opus",
};

describe("dictationTranscriptionCapability", () => {
  it("needs voice turned on and the transcription provider connected", () => {
    expect(
      dictationTranscriptionCapability({
        voice: { enabled: false },
        providers: [{ provider: "openai", connected: true }],
      }),
    ).toEqual({ available: false, reason: DICTATION_TRANSCRIPTION_UNAVAILABLE.disabled });
    expect(
      dictationTranscriptionCapability({
        voice: { enabled: true, transcriptionProvider: "groq" },
        providers: [{ provider: "openai", connected: true }],
      }),
    ).toEqual({ available: false, reason: DICTATION_TRANSCRIPTION_UNAVAILABLE.noProvider });
    expect(
      dictationTranscriptionCapability({
        voice: { enabled: true },
        providers: [{ provider: "openai", connected: true }],
      }),
    ).toEqual({ available: true, provider: "openai" });
  });
});

describe("dictationAudioMediaType", () => {
  it("normalizes recorder media types to the RPC schema", () => {
    expect(dictationAudioMediaType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(dictationAudioMediaType("audio/x-m4a")).toBe("audio/mp4");
    expect(dictationAudioMediaType("audio/flac")).toBeNull();
  });
});

describe("encodeDictationAudioBase64", () => {
  it("matches the platform encoder, including padding", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 257]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
      expect(encodeDictationAudioBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
    }
  });
});

describe("createVoiceDictationTranscriber", () => {
  it("sends normalized audio to the chat's environment", async () => {
    const transcribe = vi.fn(async () => ({ _tag: "Success" as const, value: { text: "hello" } }));
    const transcriber = createVoiceDictationTranscriber({
      transcribe,
      cancel: vi.fn(async () => undefined),
      nextOperationId: () => "op-1",
    });
    await expect(
      transcriber({ audio, signal: new AbortController().signal, identity }),
    ).resolves.toBe("hello");
    expect(transcribe).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { operationId: "op-1", audioBase64: "aGk=", mimeType: "audio/webm" },
    });
  });

  it("cancels the server operation when dictation is aborted", async () => {
    const cancel = vi.fn(async () => undefined);
    const controller = new AbortController();
    const transcriber = createVoiceDictationTranscriber({
      transcribe: async () => {
        controller.abort();
        return { _tag: "Success" as const, value: { text: "late" } };
      },
      cancel,
      nextOperationId: () => "op-2",
    });
    await expect(transcriber({ audio, signal: controller.signal, identity })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledWith({ environmentId: "env-1", input: { operationId: "op-2" } });
  });

  it("explains a voice failure with one next step", async () => {
    const transcriber = createVoiceDictationTranscriber({
      transcribe: async () => ({
        _tag: "Failure" as const,
        cause: Cause.fail({ _tag: "VoiceCallError", reason: "voice-disabled" }),
      }),
      cancel: async () => undefined,
      nextOperationId: () => "op-3",
    });
    await expect(
      transcriber({ audio, signal: new AbortController().signal, identity }),
    ).rejects.toThrow(DICTATION_TRANSCRIPTION_UNAVAILABLE.disabled);
  });
});

describe("switching chats mid-transcription", () => {
  it("cancels the server operation and never writes the late transcript into the new chat", async () => {
    const chatA = { ...identity, threadId: "chat-a", draftId: "chat-a" };
    const chatB = { ...identity, threadId: "chat-b", draftId: "chat-b" };
    let draft: DictationDraft = { identity: chatA, text: "", selection: { start: 0, end: 0 } };
    let finishTranscription!: (text: string) => void;
    let transcribeRequest!: () => void;
    const requested = new Promise<void>((markRequested) => {
      transcribeRequest = markRequested;
    });
    const cancel = vi.fn(async () => undefined);
    const session = createDictationSession({
      capture: async () => ({ stop: async () => audio, dispose: () => undefined }),
      transcribe: createVoiceDictationTranscriber({
        transcribe: () => {
          transcribeRequest();
          return new Promise((resolve) => {
            finishTranscription = (text) => resolve({ _tag: "Success", value: { text } });
          });
        },
        cancel,
        nextOperationId: () => "op-late",
      }),
      updateDraft: (update) => {
        draft = update(draft);
      },
      schedule: (callback, milliseconds) => globalThis["setTimeout"](callback, milliseconds),
      cancelSchedule: (timer) => globalThis["clearTimeout"](timer as number),
    });

    await session.start(draft);
    const finishing = session.finish();
    await requested;
    expect(session.status).toBe("transcribing");

    draft = { identity: chatB, text: "typed in chat b", selection: { start: 15, end: 15 } };
    session.updateContext(chatB, true);
    finishTranscription("meant for chat a");
    await finishing;

    expect(session.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { operationId: "op-late" },
    });
    expect(draft.text).toBe("typed in chat b");
  });
});
