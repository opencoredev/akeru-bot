import {
  createDictationSession,
  DICTATION_UNAVAILABLE,
  type DictationDependencies,
  type DictationDraft,
  type DictationIdentity,
} from "@t3tools/client-runtime/dictation";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDictation } from "./useComposerDictation";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

import { reactHookHarness as hooks } from "../test/reactHookHarness";

afterEach(() => {
  hooks.reset();
  vi.restoreAllMocks();
});

const identity: DictationIdentity = {
  environmentId: "environment",
  threadId: "thread",
  draftId: "draft",
  generation: 1,
};

function draft(text = "Keep this"): DictationDraft {
  return { identity, text, selection: { start: text.length, end: text.length } };
}

describe("useComposerDictation", () => {
  it("holds, transcribes into the current draft, and never sends", async () => {
    let current = draft();
    const transcribe = vi.fn(async () => "spoken words");
    const send = vi.fn();
    const audio = { bytes: new Uint8Array([1]), durationMs: 10, mediaType: "audio/webm" };
    hooks.beginRender();
    const controls = useComposerDictation({
      identity,
      connected: true,
      callActive: false,
      transcribe,
      getDraft: () => current,
      applyDraft: (next) => {
        current = next;
      },
      createSession: (dependencies) =>
        createDictationSession({
          ...dependencies,
          capture: async () => ({
            stop: async () => audio,
            dispose: () => undefined,
          }),
        }),
    });
    expect(controls.unavailableReason).toBeNull();
    await controls.onStart();
    current = { ...current, text: "Keep this concurrent" };
    await controls.onRelease();
    expect(current.text).toBe("Keep this concurrent spoken words");
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a late result after the chat identity changes", async () => {
    let current = draft();
    const transcribe = vi.fn(async () => "late");
    hooks.beginRender();
    const controls = useComposerDictation({
      identity,
      connected: true,
      callActive: false,
      transcribe,
      getDraft: () => current,
      applyDraft: (next) => {
        current = next;
      },
      createSession: (dependencies) =>
        createDictationSession({
          ...dependencies,
          capture: async () => ({
            stop: async () => ({
              bytes: new Uint8Array([1]),
              durationMs: 10,
              mediaType: "audio/webm",
            }),
            dispose: () => undefined,
          }),
        }),
    });
    await controls.onStart();
    current = {
      ...current,
      identity: { ...identity, threadId: "other", generation: 2 },
      text: "other chat",
    };
    await controls.onRelease();
    expect(current.text).toBe("other chat");
  });

  it("keeps typed text through a failed transcription and a retry", async () => {
    let current = draft("Please check ");
    const transcribe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValueOnce("the logs");
    const binding = {
      identity,
      connected: true,
      callActive: false,
      transcribe,
      getDraft: () => current,
      applyDraft: (next: DictationDraft) => {
        current = next;
      },
      createSession: (dependencies: Omit<DictationDependencies, "capture">) =>
        createDictationSession({
          ...dependencies,
          capture: async () => ({
            stop: async () => ({
              bytes: new Uint8Array([1]),
              durationMs: 10,
              mediaType: "audio/webm",
            }),
            dispose: () => undefined,
          }),
        }),
    };
    hooks.beginRender();
    const first = useComposerDictation(binding);
    await first.onStart();
    await first.onRelease();
    hooks.beginRender();
    const failed = useComposerDictation(binding);
    expect(failed.status).toBe("failed");
    expect(current.text).toBe("Please check ");

    await failed.onStart();
    await failed.onRelease();
    hooks.beginRender();
    const retried = useComposerDictation(binding);
    expect(retried.status).toBe("idle");
    expect(current.text).toBe("Please check the logs");
  });

  it("blocks an active call without treating missing transcription as a dead button", () => {
    hooks.beginRender();
    const call = useComposerDictation({
      identity,
      connected: true,
      callActive: true,
      transcribe: async () => "no",
      getDraft: () => draft(),
      applyDraft: () => undefined,
    });
    expect(call.unavailableReason).toBe(DICTATION_UNAVAILABLE.callActive);
    call.onStart();
    hooks.reset();
    hooks.beginRender();
    const missing = useComposerDictation({
      identity,
      connected: true,
      callActive: false,
      getDraft: () => draft(),
      applyDraft: () => undefined,
    });
    expect(missing.unavailableReason).toBeNull();
  });

  it("names the next step when capture or transcription is unavailable", () => {
    hooks.beginRender();
    const insecure = useComposerDictation({
      identity,
      connected: true,
      callActive: false,
      captureAvailable: false,
      captureReason: "Open this page over HTTPS.",
      getDraft: () => draft(),
      applyDraft: () => undefined,
    });
    expect(insecure.unavailableReason).toBe("Open this page over HTTPS.");
    hooks.reset();
    hooks.beginRender();
    const voiceOff = useComposerDictation({
      identity,
      connected: true,
      callActive: false,
      transcription: { available: false, reason: "Voice is turned off." },
      getDraft: () => draft(),
      applyDraft: () => undefined,
    });
    expect(voiceOff.unavailableReason).toBe("Voice is turned off.");
  });
});
