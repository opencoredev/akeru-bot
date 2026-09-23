import type { ImageGenerationSettings, ImageProviderStatus } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityLabel,
    children,
  }: {
    readonly accessibilityLabel?: string;
    readonly children?: ReactNode;
  }) => createElement("button", { "aria-label": accessibilityLabel }, children),
  Text: "span",
  View: "div",
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({
    title,
    children,
  }: {
    readonly title: string;
    readonly children: ReactNode;
  }) => createElement("section", { title }, children),
}));

import {
  ImageGenerationSummaryView,
  type ImageProvidersQueryView,
} from "./ImageGenerationSummaryView";

const settings: ImageGenerationSettings = {
  chatgptEnabled: true,
  grokEnabled: true,
  defaultProvider: "grok",
  fallbackOrder: ["grok", "chatgpt"],
};

function status(
  provider: ImageProviderStatus["provider"],
  overrides: Partial<ImageProviderStatus> = {},
): ImageProviderStatus {
  return {
    provider,
    label: provider === "chatgpt" ? "ChatGPT" : "Grok",
    connected: true,
    enabled: true,
    health: "detected",
    operations: ["generate"],
    ...overrides,
  };
}

function render(query: ImageProvidersQueryView, value = settings): string {
  return renderToStaticMarkup(
    createElement(ImageGenerationSummaryView, { settings: value, query, onRetry: () => {} }),
  );
}

describe("mobile image generation summary", () => {
  it("shows loading rows without claiming an empty history", () => {
    const markup = render({ data: null, error: null, isPending: true });
    expect(markup).toContain("Checking");
    expect(markup).toContain("Loading provider status…");
    expect(markup).not.toContain("No images generated yet");
    expect(markup).not.toContain("Try again");
  });

  it("shows the load error with a retry action", () => {
    const markup = render({ data: null, error: "Connection lost", isPending: false });
    expect(markup).toContain("Could not load image providers: Connection lost");
    expect(markup).toContain('aria-label="Retry loading image providers"');
    expect(markup).toContain("Try again");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("No images generated yet");
  });

  it("shows the same provider details as desktop once loaded", () => {
    const markup = render({
      data: {
        providers: [
          status("chatgpt"),
          status("grok", {
            health: "revoked",
            lastFailure: { at: new Date().toISOString(), message: "Token was revoked" },
            repairAction: "Reconnect Grok subscription",
            healthTest: { status: "failed", checkedAt: new Date().toISOString() },
          }),
        ],
      },
      error: null,
      isPending: false,
    });
    expect(markup).toContain("ChatGPT subscription detected");
    expect(markup).toContain("Supports image generation");
    expect(markup).toContain("No images generated yet");
    expect(markup).toContain("Health test not run");
    expect(markup).toContain("Health test failed &lt;1m ago");
    expect(markup).toContain("Token was revoked");
    expect(markup).toContain("Next step: Reconnect Grok subscription");
    expect(markup).toContain("Grok, then ChatGPT");
  });

  it("states a disabled provider once, without an On/Off label", () => {
    const markup = render(
      { data: { providers: [status("chatgpt"), status("grok")] }, error: null, isPending: false },
      { ...settings, chatgptEnabled: false },
    );
    expect(markup).toContain("Disabled");
    expect(markup).not.toMatch(/>(On|Off) ·/);
  });
});
