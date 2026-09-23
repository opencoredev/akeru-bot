import type {
  ImageGenerationSettings,
  ImageProviderHealth,
  ImageProviderStatus,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: vi.fn(),
  useUpdateEnvironmentSettings: () => vi.fn(),
}));
vi.mock("../../settingsDialogStore", () => ({
  openSettings: vi.fn(),
  useSettingsEnvironmentId: () => "environment-1",
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));

import { ImageGenerationRoutingSection, ImageProviderRow } from "./ImageGenerationSettings";

function status(
  health: ImageProviderHealth,
  overrides: Partial<ImageProviderStatus> = {},
): ImageProviderStatus {
  return {
    provider: "grok",
    label: "Grok",
    connected: true,
    enabled: true,
    health,
    operations: ["generate"],
    ...overrides,
  };
}

function renderRow(
  row: ImageProviderStatus | undefined,
  enabled = true,
  loadFailed = false,
): string {
  return renderToStaticMarkup(
    <ImageProviderRow
      provider="grok"
      status={row}
      enabled={enabled}
      loadFailed={loadFailed}
      busyAction={null}
      disabled={false}
      onToggle={() => {}}
      onTest={() => {}}
      onDisconnect={() => {}}
      onConnect={() => {}}
    />,
  );
}

describe("image provider row", () => {
  it("stays Not tested until a health request passed", () => {
    const markup = renderRow(status("detected", { repairAction: "Run health test" }));
    expect(markup).toContain("Not tested");
    expect(markup).toContain("Grok subscription detected");
    expect(markup).toContain("Supports image generation");
    expect(markup).toContain("No images generated yet");
    expect(markup).toContain("Health test not run");
    expect(markup).toContain("Next step: Run health test");
    expect(markup).toContain("Run Grok image health test");
    expect(markup).toContain("Disconnect Grok subscription");
  });

  it("shows Healthy after a passed health test", () => {
    const markup = renderRow(
      status("healthy", {
        healthTest: { status: "passed", checkedAt: "2026-09-01T00:00:00.000Z" },
      }),
    );
    expect(markup).toContain("Healthy");
    expect(markup).toContain("Health test passed");
  });

  it("shows the real failure and a reconnect action for revoked access", () => {
    const markup = renderRow(
      status("revoked", {
        lastFailure: { at: "2026-09-01T00:00:00.000Z", message: "Token was revoked" },
        repairAction: "Reconnect Grok subscription",
      }),
    );
    expect(markup).toContain("Revoked");
    expect(markup).toContain("Token was revoked");
    expect(markup).toContain("Reconnect Grok subscription");
  });

  it("offers Connect and blocks enabling when no subscription is connected", () => {
    const markup = renderRow(status("missing", { connected: false }), false);
    expect(markup).toContain("Not connected");
    expect(markup).toContain("No Grok subscription connected");
    expect(markup).toContain("Connect Grok subscription");
    expect(markup).not.toContain("Disconnect Grok subscription");
    expect(markup).toMatch(
      /aria-label="Use Grok for image generation"[^>]*data-disabled|data-disabled[^>]*aria-label="Use Grok for image generation"/,
    );
  });

  it("shows loading instead of an empty history while status loads", () => {
    const markup = renderRow(undefined);
    expect(markup).toContain("Checking");
    expect(markup).toContain("Loading provider status");
    expect(markup).not.toContain("No images generated yet");
  });

  it("shows an unavailable state when status failed to load", () => {
    const markup = renderRow(undefined, true, true);
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Could not load provider status.");
    expect(markup).not.toContain("No images generated yet");
  });

  it("shows a failed health test with its time", () => {
    const markup = renderRow(
      status("failed", {
        healthTest: { status: "failed", checkedAt: "2026-09-01T00:00:00.000Z" },
      }),
    );
    expect(markup).toContain("Health test failed");
  });

  it("shows Disabled when the provider is off", () => {
    expect(renderRow(status("detected"), false)).toContain("Disabled");
  });
});

describe("image routing section", () => {
  const both: ImageGenerationSettings = {
    chatgptEnabled: true,
    grokEnabled: true,
    defaultProvider: "grok",
    fallbackOrder: ["grok", "chatgpt"],
  };

  it("shows the default and the fallback order when both providers are on", () => {
    const markup = renderToStaticMarkup(
      <ImageGenerationRoutingSection settings={both} onChange={() => {}} />,
    );
    expect(markup).toContain("Default provider");
    expect(markup).toContain("Fallback order");
    expect(markup).toContain("Grok, then ChatGPT");
  });

  it("hides the fallback order with one provider and disables the default with none", () => {
    const one = renderToStaticMarkup(
      <ImageGenerationRoutingSection
        settings={{ ...both, chatgptEnabled: false }}
        onChange={() => {}}
      />,
    );
    expect(one).not.toContain("Fallback order");
    const none = renderToStaticMarkup(
      <ImageGenerationRoutingSection
        settings={{ ...both, chatgptEnabled: false, grokEnabled: false }}
        onChange={() => {}}
      />,
    );
    expect(none).toContain("None enabled");
    expect(none).toContain("Turn on a provider above");
  });
});
