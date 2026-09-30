import {
  createDictationSession,
  type DictationDependencies,
  type DictationDraft,
  type DictationIdentity,
} from "@t3tools/client-runtime/dictation";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (importOriginal) => {
  const slot = <T>(create: () => T): { value: T } => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { value: create() };
    return hooks.slots[index] as { value: T };
  };
  return {
    ...(await importOriginal<typeof import("react")>()),
    useRef: <T>(current: T) => slot(() => ({ current })).value,
    useMemo: <T>(factory: () => T) => slot(factory).value,
    useCallback: <T>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => void effect(),
    useState: <T>(initial: () => T) => {
      const state = slot(initial);
      return [state.value, (next: T) => (state.value = next)];
    },
  };
});
vi.mock("./expoDictationCapture", () => ({ startExpoDictationCapture: vi.fn() }));

import { useComposerDictation } from "./useComposerDictation";

const identity: DictationIdentity = {
  environmentId: "environment",
  threadId: "thread",
  draftId: "draft",
  generation: 1,
};

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
});

describe("useComposerDictation", () => {
  it("keeps typed text through a failed transcription and a retry", async () => {
    let current: DictationDraft = {
      identity,
      text: "Please check ",
      selection: { start: 13, end: 13 },
    };
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
              mediaType: "audio/mp4",
            }),
            dispose: () => undefined,
          }),
        }),
    };
    const render = () => {
      hooks.cursor = 0;
      return useComposerDictation(binding);
    };

    const first = render();
    await first.onStart();
    await first.onRelease();
    const failed = render();
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("Provider unavailable");
    expect(current.text).toBe("Please check ");

    await failed.onStart();
    await failed.onRelease();
    const retried = render();
    expect(retried.status).toBe("idle");
    expect(retried.errorMessage).toBeNull();
    expect(current.text).toBe("Please check the logs");

    render().onCancel();
    expect(render().status).toBe("canceled");
  });
});
