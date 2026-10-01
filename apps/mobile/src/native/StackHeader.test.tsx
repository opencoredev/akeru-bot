import type { AppNativeStackNavigationOptions } from "./StackHeader";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, cursor: 0 }));

const navigation = vi.hoisted(() => ({ setOptions: vi.fn(), addListener: vi.fn() }));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => navigation }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T,>(initial: T) => {
    const index = hooks.cursor++;
    hooks.refs[index] ??= { current: initial };

    return hooks.refs[index] as { current: T };
  },
  useMemo: <T,>(factory: () => T) => factory(),
  useLayoutEffect: (effect: () => void) => effect(),
  useEffect: () => {},
}));

import { NativeStackScreenOptions } from "./StackHeader";

function render(options: AppNativeStackNavigationOptions, optionsVersion?: string) {
  hooks.cursor = 0;
  NativeStackScreenOptions({ options, optionsVersion });
}

beforeEach(() => {
  hooks.refs = [];
  hooks.cursor = 0;
  vi.clearAllMocks();
});

interface CircularVersion {
  self?: CircularVersion;
}

describe("native screen options", () => {
  it("stabilizes equivalent factories while forwarding the latest closure", () => {
    const factory = (label: string) => () => label;
    render({ title: "Chat", headerRight: factory("First") });
    const applied = navigation.setOptions.mock.calls[0]![0] as AppNativeStackNavigationOptions;
    expect(applied.headerRight?.({ canGoBack: false })).toBe("First");

    render({ title: "Chat", headerRight: factory("Second") });
    expect(navigation.setOptions).toHaveBeenCalledTimes(1);
    expect(applied.headerRight?.({ canGoBack: false })).toBe("Second");
  });

  it("reapplies options when their values or explicit version change", () => {
    render({ title: "Chat" }, "1");
    render({ title: "Chat" }, "1");
    expect(navigation.setOptions).toHaveBeenCalledTimes(1);
    render({ title: "Renamed chat" }, "1");
    render({ title: "Renamed chat" }, "2");
    expect(navigation.setOptions).toHaveBeenCalledTimes(3);
  });

  it("preserves an explicit undefined tint so navigation can clear a previous color", () => {
    const options: AppNativeStackNavigationOptions = {};
    Object.defineProperty(options, "headerTintColor", { value: undefined, enumerable: true });
    render(options);
    expect(navigation.setOptions.mock.calls[0]![0]).toHaveProperty("headerTintColor", undefined);
    render({});
    expect(navigation.setOptions).toHaveBeenCalledTimes(2);
    expect(navigation.setOptions.mock.calls[1]![0]).not.toHaveProperty("headerTintColor");
  });

  it("preserves ref identity and tolerates circular option version values", () => {
    const ref = { current: { nativeView: 1 } };
    const version: CircularVersion = {};
    version.self = version;
    hooks.cursor = 0;
    NativeStackScreenOptions({
      options: { unstable_headerCenterItems: ref },
      optionsVersion: version,
    });
    const applied = navigation.setOptions.mock.calls[0]![0] as AppNativeStackNavigationOptions;
    expect(applied.unstable_headerCenterItems).toBe(ref);
    ref.current.nativeView = 2;
    hooks.cursor = 0;
    NativeStackScreenOptions({
      options: { unstable_headerCenterItems: ref },
      optionsVersion: version,
    });
    expect(navigation.setOptions).toHaveBeenCalledTimes(1);
  });
});
