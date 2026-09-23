import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ failed: false }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [hooks.failed ? true : initial, () => {}],
}));
vi.mock("expo-image", () => ({ Image: "Image" }));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Mask: "Mask",
  Path: "Path",
  Rect: "Rect",
}));

import { BotAvatarView } from "./BotAvatarView";

type ElementProps = {
  children?: ReactNode;
  source?: { uri?: string };
  style?: Record<string, unknown>;
};

/**
 * Flattens a returned element tree so a test can look for one node type.
 * Function components are invoked inline, which is safe here because the
 * only hook in this module is the mocked useState above.
 */
function nodes(node: ReactNode): Array<{ type: unknown; props: ElementProps }> {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<ElementProps>(child)) return [];
    if (typeof child.type === "function") {
      const render = child.type as (props: ElementProps) => ReactNode;
      return nodes(render(child.props));
    }
    return [{ type: child.type, props: child.props }, ...nodes(child.props.children)];
  });
}

function render(avatar: Parameters<typeof BotAvatarView>[0]["avatar"]) {
  return nodes(BotAvatarView({ avatar, size: 40 }));
}

const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("BotAvatarView", () => {
  it("renders a stored image avatar from its asset path", () => {
    hooks.failed = false;
    const image = render({ kind: "image", assetPath: dataUrl, dithered: false }).find(
      (node) => node.type === "Image",
    );

    expect(image).toBeDefined();
    expect(image?.props.source?.uri).toBe(dataUrl);
    expect(image?.props.style?.height).toBe(40);
  });

  it("keeps a blob underneath the image so the slot is never empty", () => {
    hooks.failed = false;
    const tree = render({ kind: "image", assetPath: dataUrl, dithered: false });

    expect(tree.some((node) => node.type === "Svg")).toBe(true);
  });

  it("falls back to the blob when the image cannot be decoded", () => {
    hooks.failed = true;
    const tree = render({ kind: "image", assetPath: dataUrl, dithered: false });

    expect(tree.some((node) => node.type === "Image")).toBe(false);
    expect(tree.some((node) => node.type === "Svg")).toBe(true);
  });

  it("falls back to the blob when an image avatar has no asset path", () => {
    hooks.failed = false;
    const tree = render({ kind: "image", assetPath: "", dithered: false });

    expect(tree.some((node) => node.type === "Image")).toBe(false);
    expect(tree.some((node) => node.type === "Svg")).toBe(true);
  });

  it("still renders blob avatars", () => {
    hooks.failed = false;
    const tree = render({ kind: "blob", shape: "hex", color: "#2E8EFF" });

    expect(tree.some((node) => node.type === "Image")).toBe(false);
    expect(tree.some((node) => node.type === "Svg")).toBe(true);
  });
});
