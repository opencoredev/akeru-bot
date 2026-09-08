import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createReplyPlaybackController,
  createReplyReadoutPreference,
  type ReplyPlaybackRequest,
} from "@t3tools/client-runtime/reply-playback";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("react-native", () => ({ View: "View", Pressable: "Pressable" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../components/ThemedSwitch", () => ({ ThemedSwitch: "ThemedSwitch" }));

import { ReplyPlaybackControls } from "./ReplyPlaybackControls";
import { ReplyReadoutPreference } from "./ReplyReadoutPreference";

type ElementProps = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { checked?: boolean; disabled?: boolean; busy?: boolean };
  accessibilityHint?: string;
  disabled?: boolean;
  value?: boolean;
  onPress?: () => void;
  onValueChange?: (value: boolean) => void;
};
function elements(node: ReactNode): ElementProps[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<ElementProps>(child) ? [child.props, ...elements(child.props.children)] : [],
  );
}
function named(node: ReactNode, label: string) {
  const found = elements(node).find((props) => props.accessibilityLabel === label);
  expect(found, label).toBeDefined();
  return found!;
}
const request: ReplyPlaybackRequest = {
  identity: {
    environmentId: "remote",
    threadId: "chat",
    messageId: "reply",
    contentVersion: "v1",
    provider: "speech",
    voice: "voice",
  },
  text: "A completed reply",
  automatic: false,
};
function setup() {
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), dispose: vi.fn() };
  const prepare = vi.fn(async () => audio);
  const controller = createReplyPlaybackController(prepare);
  controller.setContext({ ...request.identity, connected: true, mediaBlocked: false });
  return {
    controller,
    audio,
    prepare,
    render: () => ReplyPlaybackControls({ controller, request }),
  };
}

describe("native reply playback controls", () => {
  it("exposes named buttons, pauses, resumes, and stops through the shared controller", async () => {
    const { controller, render, audio } = setup();
    expect(named(render(), "Read aloud").accessibilityRole).toBe("button");
    await controller.start(request);
    named(render(), "Pause readout").onPress?.();
    expect(controller.getSnapshot().status).toBe("paused");
    expect(audio.pause).toHaveBeenCalledOnce();
    const resume = vi.spyOn(controller, "resume");
    named(render(), "Resume readout").onPress?.();
    await resume.mock.results[0]!.value;
    expect(controller.getSnapshot().status).toBe("playing");
    named(render(), "Stop readout").onPress?.();
    expect(controller.getSnapshot().status).toBe("idle");
    expect(audio.dispose).toHaveBeenCalledOnce();
  });

  it("marks loading as busy while retaining a usable Stop button", async () => {
    const { controller, render } = setup();
    const starting = controller.start(request);
    expect(named(render(), "Preparing audio").accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    named(render(), "Stop readout").onPress?.();
    await starting;
    expect(controller.getSnapshot().status).toBe("idle");
  });

  it("starts manual readout and does not pause a different reply", async () => {
    const { controller } = setup();
    await controller.start({ ...request, identity: { ...request.identity, messageId: "other" } });
    const start = vi.spyOn(controller, "start");
    const tree = ReplyPlaybackControls({ controller, request: { ...request, automatic: true } });
    named(tree, "Read aloud").onPress?.();
    expect(start).toHaveBeenCalledWith({ ...request, automatic: false });
    await start.mock.results[0]!.value;
    controller.dispose();
  });

  it("exposes unavailable reasons and service disclosure without starting playback", () => {
    const { controller, prepare } = setup();
    const tree = ReplyPlaybackControls({
      controller,
      request,
      unavailableReason: "Connect to this environment",
      disclosure: "Your speech service may charge for audio.",
    });
    const button = named(tree, "Read aloud");
    expect(button.disabled).toBe(true);
    expect(button.accessibilityHint).toBe("Connect to this environment");
    button.onPress?.();
    expect(prepare).not.toHaveBeenCalled();
    expect(
      elements(tree).some(
        (props) => props.children === "Your speech service may charge for audio.",
      ),
    ).toBe(true);
  });

  it("announces a playback error and retries through the controller", async () => {
    const { controller, render, audio } = setup();
    audio.play.mockRejectedValueOnce(new Error("decoder"));
    await controller.start(request);
    expect(elements(render()).some((props) => props.accessibilityRole === "alert")).toBe(true);
    const retry = vi.spyOn(controller, "retry");
    named(render(), "Retry readout").onPress?.();
    await retry.mock.results[0]!.value;
    expect(controller.getSnapshot().status).toBe("playing");
    controller.dispose();
  });
});

describe("native reply readout preference", () => {
  it("defaults off and exposes an accessible switch for both opt-in and opt-out", async () => {
    const storage = { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) };
    const disabled = vi.fn();
    const preference = createReplyReadoutPreference(storage, disabled);
    const render = () => ReplyReadoutPreference({ preference });
    const label = "Automatically read new replies in this chat on this device";
    const toggle = named(render(), label);
    expect(toggle.accessibilityRole).toBe("switch");
    expect(toggle.accessibilityState).toEqual({ checked: false });
    const setEnabled = vi.spyOn(preference, "setEnabled");
    toggle.onValueChange?.(true);
    await setEnabled.mock.results[0]!.value;
    expect(named(render(), label).value).toBe(true);
    named(render(), label).onValueChange?.(false);
    await setEnabled.mock.results[1]!.value;
    expect(named(render(), label).value).toBe(false);
    expect(disabled).toHaveBeenCalledOnce();
  });

  it("announces failed persistence without hiding the current local choice", async () => {
    const preference = createReplyReadoutPreference(
      {
        getItem: async () => null,
        setItem: async () => {
          throw new Error("storage");
        },
      },
      () => {},
    );
    await preference.setEnabled(true);
    const tree = ReplyReadoutPreference({ preference });
    expect(elements(tree).some((props) => props.accessibilityRole === "alert")).toBe(true);
    expect(named(tree, "Automatically read new replies in this chat on this device").value).toBe(
      true,
    );
  });
});
