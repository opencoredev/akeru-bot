import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import type Run from "./T3MarkdownTextRunNativeComponent";
import type Root from "./T3MarkdownTextNativeComponent";

const native = vi.hoisted(() => ({ runs: vi.fn(), roots: vi.fn() }));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Text: "span",
  StyleSheet: { create: () => ({}) },
}));

vi.mock("./util", () => ({ flattenStyles: () => ({}) }));

vi.mock("./T3MarkdownTextRunNativeComponent", () => ({
  default: (props: ComponentProps<typeof Run>) => {
    native.runs(props);

    return null;
  },
}));

vi.mock("./T3MarkdownTextNativeComponent", () => ({
  default: (props: ComponentProps<typeof Root>) => {
    native.roots(props);

    return props.children;
  },
}));

beforeEach(() => vi.clearAllMocks());

describe("native markdown text runs", () => {
  it.each(["t3-file:asset://typescript", "t3-skill:sf:cube"])(
    "forwards nested link callbacks and attachment metadata for %s",
    (nativeID) => {
      const onPress = vi.fn();
      const onLongPress = vi.fn();
      const onLayout = vi.fn();
      renderToStaticMarkup(
        <MarkdownTextPrimitive uiTextView selectable numberOfLines={3}>
          <MarkdownTextPrimitive
            nativeID={nativeID}
            onPress={onPress}
            onLongPress={onLongPress}
            onLayout={onLayout}
            testID="link-run"
            accessibilityLabel="Open attachment"
          >
            attachment
          </MarkdownTextPrimitive>
        </MarkdownTextPrimitive>,
      );
      expect(native.roots).toHaveBeenCalledTimes(1);
      expect(native.runs).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "attachment",
          nativeID,
          onPress,
          onLongPress,
          onLayout,
          testID: "link-run",
          accessibilityLabel: "Open attachment",
        }),
      );
      const run: ComponentProps<typeof Run> = native.runs.mock.calls[0]![0];
      expect(run.onPress).toBe(onPress);
      expect(run.onLongPress).toBe(onLongPress);
      expect(run).not.toHaveProperty("numberOfLines");
    },
  );
  it("keeps root-only props on the root and shared view props on both", () => {
    const onSelectionChange = vi.fn();
    const onPress = vi.fn();
    const onLayout = vi.fn();
    renderToStaticMarkup(
      <MarkdownTextPrimitive
        uiTextView
        selectable
        numberOfLines={2}
        onSelectionChange={onSelectionChange}
        onPress={onPress}
        onLayout={onLayout}
        nativeID="root-text"
        accessible
      >
        text
      </MarkdownTextPrimitive>,
    );
    expect(native.roots).toHaveBeenCalledWith(
      expect.objectContaining({
        numberOfLines: 2,
        onSelectionChange,
        onLayout,
        nativeID: "root-text",
        accessible: true,
      }),
    );
    expect(native.runs).toHaveBeenCalledWith(
      expect.objectContaining({
        onPress,
        onLayout,
        nativeID: "root-text",
        accessible: true,
      }),
    );
    const root: ComponentProps<typeof Root> = native.roots.mock.calls[0]![0];
    const run: ComponentProps<typeof Run> = native.runs.mock.calls[0]![0];
    expect(root).not.toHaveProperty("onPress");
    expect(run).not.toHaveProperty("onSelectionChange");
    expect(run).not.toHaveProperty("numberOfLines");
    expect(run).not.toHaveProperty("uiTextView");
  });
});
