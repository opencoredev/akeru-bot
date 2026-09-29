import type { ComponentProps, MouseEvent, PointerEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { DictationControls, type DictationControlsProps } from "./DictationControls";

const effects = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { deps: readonly unknown[]; cleanup: void | (() => void) }[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useId: () => "dictation-description",
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = effects.cursor++;
      const previous = effects.slots[index];
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      previous?.cleanup?.();
      effects.slots[index] = { deps, cleanup: effect() };
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

const callbacks = () => ({ onStart: vi.fn(), onRelease: vi.fn(), onCancel: vi.fn() });
function render(props: DictationControlsProps) {
  hooks.beginRender();
  effects.cursor = 0;
  const tree = DictationControls(props);
  const button = visitElements(tree, (element) => element.type === "button")!;
  const cancel = visitElements(tree, (element) => element.props.children === "Cancel dictation");
  const status = visitElements(tree, (element) => element.props.role === "status")!;
  return {
    button: button.props as ComponentProps<"button">,
    cancel: cancel?.props as ComponentProps<"button"> | undefined,
    status: status.props,
  };
}
const pointerEvent = (pointerId = 1) =>
  ({
    pointerId,
    button: 0,
    isPrimary: true,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() },
  }) as unknown as PointerEvent<HTMLButtonElement>;
const click = (detail: number) => ({ detail }) as MouseEvent<HTMLButtonElement>;

beforeEach(() => {
  hooks.reset();
  effects.slots = [];
  effects.cursor = 0;
});

function unmount() {
  for (const effect of effects.slots) effect.cleanup?.();
}

describe("DictationControls", () => {
  it("releases a hold once, even before permission resolves, and ignores its click", () => {
    const handlers = callbacks();
    const view = render({ status: "idle", ...handlers });
    view.button.onPointerDown!(pointerEvent());
    view.button.onPointerUp!(pointerEvent(2));
    expect(handlers.onRelease).not.toHaveBeenCalled();
    view.button.onPointerUp!(pointerEvent());
    view.button.onLostPointerCapture!(pointerEvent());
    view.button.onClick!(click(1));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it.each(["onPointerCancel", "onLostPointerCapture"] as const)(
    "%s cancels rather than releases",
    (event) => {
      const handlers = callbacks();
      const view = render({ status: "idle", ...handlers });
      view.button.onPointerDown!(pointerEvent());
      view.button[event]!(pointerEvent());
      view.button.onPointerUp!(pointerEvent());
      view.button.onClick!(click(1));
      expect(handlers.onCancel).toHaveBeenCalledTimes(1);
      expect(handlers.onRelease).not.toHaveBeenCalled();
      expect(handlers.onStart).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the hold across status updates and ignores release after explicit cancel", () => {
    const handlers = callbacks();
    render({ status: "idle", ...handlers }).button.onPointerDown!(pointerEvent());
    const view = render({ status: "recording", ...handlers });
    view.cancel!.onClick!(click(0));
    view.button.onPointerUp!(pointerEvent());
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it("ignores secondary buttons and non-primary pointers", () => {
    const handlers = callbacks();
    const view = render({ status: "idle", ...handlers });
    view.button.onPointerDown!({ ...pointerEvent(), button: 2 });
    view.button.onPointerDown!({ ...pointerEvent(), isPrimary: false });
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it("supports keyboard and screen-reader clicks across controlled renders", () => {
    const handlers = callbacks();
    render({ status: "idle", ...handlers }).button.onClick!(click(0));
    const recording = render({ status: "recording", ...handlers });
    recording.button.onClick!(click(0));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).toHaveBeenCalledTimes(1);
    expect(recording.button["aria-pressed"]).toBe(true);
    expect(recording.button.type).toBe("button");
    expect(recording.cancel?.type).toBe("button");
  });

  it("keeps cancellation available during transcription and suppresses restart", () => {
    const handlers = callbacks();
    const view = render({ status: "transcribing", ...handlers });
    view.button.onClick!(click(0));
    view.cancel!.onClick!(click(0));
    expect(view.button.disabled).toBe(true);
    expect(handlers.onStart).not.toHaveBeenCalled();
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight operation on unmount without starting a send", () => {
    const handlers = callbacks();
    render({ status: "recording", ...handlers });
    unmount();
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onStart).not.toHaveBeenCalled();
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it("treats a send-slot tap as start, not an immediate release", () => {
    const handlers = callbacks();
    const view = render({ status: "idle", appearance: "send-slot", ...handlers });
    view.button.onPointerDown!(pointerEvent());
    view.button.onPointerUp!(pointerEvent());
    view.button.onClick!(click(1));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).not.toHaveBeenCalled();
    const recording = render({ status: "recording", appearance: "send-slot", ...handlers });
    recording.button.onPointerDown!(pointerEvent());
    recording.button.onPointerUp!(pointerEvent());
    expect(handlers.onRelease).toHaveBeenCalledTimes(1);
  });

  it("renders a send-slot microphone without a labeled caption", () => {
    const view = render({ status: "idle", appearance: "send-slot", ...callbacks() });
    expect(view.button["aria-label"]).toBe("Start dictation");
    expect(view.cancel).toBeUndefined();
    expect(view.status.className).toContain("sr-only");
  });

  it("explains unavailability and blocks new starts", () => {
    const handlers = callbacks();
    const view = render({
      status: "idle",
      unavailableReason: "Microphone unavailable",
      ...handlers,
    });
    view.button.onPointerDown!(pointerEvent());
    view.button.onClick!(click(0));
    expect(handlers.onStart).not.toHaveBeenCalled();
    expect(view.status.children).toBe("Dictation unavailable: Microphone unavailable");
    const recording = render({ status: "recording", unavailableReason: "Offline", ...handlers });
    expect(recording.button.disabled).toBe(true);
    expect(handlers.onCancel).toHaveBeenCalled();
  });

  it("settles a failed dictation when voice becomes unavailable", () => {
    const handlers = callbacks();
    render({ status: "failed", appearance: "send-slot", ...handlers });
    expect(handlers.onCancel).not.toHaveBeenCalled();
    render({
      status: "failed",
      appearance: "send-slot",
      unavailableReason: "Voice is offline",
      ...handlers,
    });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a visible cancel while a send-slot recording runs", () => {
    const handlers = callbacks();
    hooks.beginRender();
    effects.cursor = 0;
    const tree = DictationControls({ status: "recording", appearance: "send-slot", ...handlers });
    const cancel = visitElements(
      tree,
      (element) => element.type === "button" && element.props["aria-label"] === "Cancel dictation",
    )!;
    (cancel.props as ComponentProps<"button">).onClick!(click(1));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it("offers retry and dismiss after a send-slot failure", () => {
    const handlers = callbacks();
    hooks.beginRender();
    effects.cursor = 0;
    const tree = DictationControls({ status: "failed", appearance: "send-slot", ...handlers });
    const retry = visitElements(tree, (element) => element.type === "button")!
      .props as ComponentProps<"button">;
    expect(retry["aria-label"]).toBe("Retry dictation");
    retry.onClick!(click(0));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    const dismiss = visitElements(
      tree,
      (element) =>
        element.type === "button" && element.props["aria-label"] === "Dismiss dictation error",
    )!;
    (dismiss.props as ComponentProps<"button">).onClick!(click(1));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("lets a blocked send-slot mic explain itself instead of starting", () => {
    const handlers = callbacks();
    const onBlockedPress = vi.fn();
    const view = render({
      status: "idle",
      appearance: "send-slot",
      unavailableReason: "Voice is turned off.",
      onBlockedPress,
      ...handlers,
    });
    expect(view.button.disabled).toBe(false);
    expect(view.button["aria-disabled"]).toBe(true);
    view.button.onPointerDown!(pointerEvent());
    view.button.onClick!(click(1));
    expect(onBlockedPress).toHaveBeenCalledWith("Voice is turned off.");
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it.each(["idle", "requesting", "recording", "transcribing", "canceled", "failed"] as const)(
    "announces %s",
    (status) => {
      const view = render({ status, ...callbacks() });
      expect(view.status["aria-live"]).toBe("polite");
      expect(view.status["aria-atomic"]).toBe("true");
      expect(view.status.children).toBeTruthy();
    },
  );
});
