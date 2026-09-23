import { isValidElement, type ComponentProps, type ReactNode } from "react";
import type { Pressable, View } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DictationControls, type DictationControlsProps } from "./DictationControls";

const state = vi.hoisted(() => ({
  announce: vi.fn(),
  platform: { OS: "ios" },
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: (initialValue: unknown) => {
    const index = state.cursor++;
    if (!state.refs[index]) state.refs[index] = { current: initialValue };
    return state.refs[index];
  },
  useEffect: (effect: () => void | (() => void)) => effect(),
}));
vi.mock("react-native", () => ({
  View: "View",
  Pressable: "Pressable",
  Text: "Text",
  AccessibilityInfo: { announceForAccessibility: state.announce },
  Platform: state.platform,
}));
vi.mock("./AppText", () => ({ AppText: "Text" }));
vi.mock("./AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../lib/useThemeColor", () => ({ useThemeColor: () => "#000" }));

function find(node: ReactNode, key: string, value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = find(child, key, value);
      if (result) return result;
    }
  }
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (node.props[key] === value) return node.props;
  return find(node.props.children as ReactNode, key, value);
}
const HINT =
  "Hold to dictate and release to finish, or activate to start and activate again to stop.";
function render(props: DictationControlsProps) {
  state.cursor = 0;
  const tree = DictationControls(props);
  return {
    button: find(tree, "accessibilityHint", HINT) as ComponentProps<typeof View>,
    cancel: find(tree, "accessibilityLabel", "Cancel dictation") as
      | ComponentProps<typeof Pressable>
      | undefined,
    status: find(tree, "accessibilityLiveRegion", "polite")!,
  };
}
const callbacks = () => ({ onStart: vi.fn(), onRelease: vi.fn(), onCancel: vi.fn() });
const event = {} as Parameters<NonNullable<ComponentProps<typeof View>["onResponderGrant"]>>[0];

beforeEach(() => {
  state.platform.OS = "ios";
  state.cursor = 0;
  state.refs = [];
  vi.clearAllMocks();
});

describe("native DictationControls interaction handlers", () => {
  it("starts on touch grant and releases once while permission is pending", () => {
    const handlers = callbacks();
    render({ status: "idle", ...handlers }).button.onResponderGrant!(event);
    const view = render({ status: "requesting", ...handlers });
    view.button.onResponderRelease!(event);
    view.button.onResponderRelease!(event);
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).toHaveBeenCalledTimes(1);
  });

  it("cancels an interrupted touch without releasing", () => {
    const handlers = callbacks();
    const view = render({ status: "idle", ...handlers });
    view.button.onResponderGrant!(event);
    view.button.onResponderTerminate!(event);
    view.button.onResponderRelease!(event);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it("toggles through accessibility activation without a physical hold", () => {
    const handlers = callbacks();
    render({ status: "idle", ...handlers }).button.onAccessibilityTap!();
    const view = render({ status: "recording", ...handlers });
    view.button.onAccessibilityAction!({ nativeEvent: { actionName: "activate" } } as Parameters<
      NonNullable<ComponentProps<typeof View>["onAccessibilityAction"]>
    >[0]);
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).toHaveBeenCalledTimes(1);
    expect(view.button.accessibilityLabel).toBe("Stop dictation");
  });

  it("does not activate twice during a physical hold", () => {
    const handlers = callbacks();
    const view = render({ status: "idle", ...handlers });
    view.button.onResponderGrant!(event);
    view.button.onAccessibilityTap!();
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
  });

  it("blocks unavailable starts and keeps transcription cancelable", () => {
    const handlers = callbacks();
    const unavailable = render({ status: "idle", unavailableReason: "No microphone", ...handlers });
    unavailable.button.onAccessibilityTap!();
    unavailable.button.onResponderGrant!(event);
    expect(unavailable.button.onStartShouldSetResponder!(event)).toBe(false);
    expect(unavailable.status.children).toBe("Dictation unavailable: No microphone");
    const busy = render({ status: "transcribing", ...handlers });
    busy.button.onAccessibilityTap!();
    busy.cancel!.onPress!(event);
    expect(handlers.onStart).not.toHaveBeenCalled();
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it.each(["idle", "requesting", "recording", "transcribing", "canceled", "failed"] as const)(
    "announces %s on iOS and exposes an Android live region",
    (status) => {
      const view = render({ status, ...callbacks() });
      expect(state.announce).toHaveBeenCalledWith(view.status.children);
      state.announce.mockClear();
      state.platform.OS = "android";
      render({ status, ...callbacks() });
      expect(state.announce).not.toHaveBeenCalled();
    },
  );

  it("shows a visible cancel beside the send-slot mic while recording", () => {
    const handlers = callbacks();
    expect(render({ status: "idle", appearance: "send-slot", ...handlers }).cancel).toBeUndefined();
    const view = render({ status: "recording", appearance: "send-slot", ...handlers });
    view.cancel!.onPress!(event);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it("offers retry and dismiss after a send-slot failure", () => {
    const handlers = callbacks();
    state.cursor = 0;
    const tree = DictationControls({ status: "failed", appearance: "send-slot", ...handlers });
    const retry = find(tree, "accessibilityHint", HINT) as ComponentProps<typeof View>;
    expect(retry.accessibilityLabel).toBe("Retry dictation");
    retry.onAccessibilityTap!();
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    const dismiss = find(tree, "accessibilityLabel", "Dismiss dictation error") as ComponentProps<
      typeof Pressable
    >;
    dismiss.onPress!(event);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("explains a blocked send-slot mic instead of starting", () => {
    const handlers = callbacks();
    const onBlockedPress = vi.fn();
    const view = render({
      status: "idle",
      appearance: "send-slot",
      unavailableReason: "Reconnect to dictate.",
      onBlockedPress,
      ...handlers,
    });
    view.button.onAccessibilityTap!();
    view.button.onResponderGrant!(event);
    expect(onBlockedPress).toHaveBeenCalledTimes(2);
    expect(onBlockedPress).toHaveBeenCalledWith("Reconnect to dictate.");
    expect(handlers.onStart).not.toHaveBeenCalled();
  });
});
