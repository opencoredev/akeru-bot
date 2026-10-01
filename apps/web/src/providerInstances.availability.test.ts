import { ProviderDriverKind } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  isProviderInstancePickerSelectable,
  isProviderInstancePickerVisible,
  providerInstancePickerBlockReason,
  providerInstanceUnavailableReason,
} from "./providerInstances";
import { provider, model } from "./providerInstances.test-support";

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
});

describe("isProviderInstancePickerSelectable", () => {
  it("keeps installed provider models selectable while the probe is limited", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("grok"),
        instanceId: "grok",
        status: "warning",
        models: [model("grok-build")],
      }),
    ]);

    expect(entry && isProviderInstancePickerSelectable(entry)).toBe(true);
  });

  it("rejects missing and explicitly unauthenticated providers", () => {
    const [missing, unauthenticated] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("grok"),
        instanceId: "grok_missing",
        installed: false,
      }),
      provider({
        provider: ProviderDriverKind.make("grok"),
        instanceId: "grok_signed_out",
        authStatus: "unauthenticated",
      }),
    ]);

    expect(missing && isProviderInstancePickerSelectable(missing)).toBe(false);
    expect(unauthenticated && isProviderInstancePickerSelectable(unauthenticated)).toBe(false);
  });

  it("rejects disabled provider snapshots with explicit or omitted availability", () => {
    const [available, availabilityOmitted] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("grok"),
        instanceId: "grok_available",
        status: "disabled",
        availability: "available",
      }),
      provider({
        provider: ProviderDriverKind.make("grok"),
        instanceId: "grok_availability_omitted",
        status: "disabled",
      }),
    ]);

    expect(available && isProviderInstancePickerSelectable(available)).toBe(false);
    expect(availabilityOmitted && isProviderInstancePickerSelectable(availabilityOmitted)).toBe(
      false,
    );
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("shows disabled instances with known models so their reason remains visible", () => {
    const [enabledEntry, disabledEntry, missingEntry, signedOutEntry] =
      deriveProviderInstanceEntries([
        provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId: "claudeAgent",
          enabled: false,
          models: [model("sonnet")],
        }),
        provider({
          provider: ProviderDriverKind.make("kimi"),
          instanceId: "kimi",
          installed: false,
        }),
        provider({
          provider: ProviderDriverKind.make("opencodeGo"),
          instanceId: "opencodeGo",
          authStatus: "unauthenticated",
        }),
      ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerSelectable(disabledEntry)).toBe(false);
    expect(disabledEntry && providerInstancePickerBlockReason(disabledEntry)).toContain(
      "turned off",
    );
    expect(missingEntry && isProviderInstancePickerVisible(missingEntry)).toBe(true);
    expect(signedOutEntry && isProviderInstancePickerVisible(signedOutEntry)).toBe(true);
    expect(signedOutEntry && isProviderInstancePickerSelectable(signedOutEntry)).toBe(false);
  });
});

describe("providerInstanceUnavailableReason", () => {
  it("names the provider and the next action for each blocking state", () => {
    const [ready, signedOut, missing, limited, flaky] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        authStatus: "unauthenticated",
      }),
      provider({
        provider: ProviderDriverKind.make("kimi"),
        instanceId: "kimi",
        installed: false,
      }),
      {
        ...provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok" }),
        unavailability: "limit-reached",
      },
      {
        ...provider({ provider: ProviderDriverKind.make("opencodeGo"), instanceId: "opencodeGo" }),
        unavailability: "temporary-failure",
      },
    ]);

    expect(providerInstanceUnavailableReason(ready)).toBeNull();
    expect(providerInstanceUnavailableReason(signedOut)).toMatch(
      /not connected.*Settings > Providers/,
    );
    expect(providerInstanceUnavailableReason(missing)).toMatch(/not installed/);
    expect(providerInstanceUnavailableReason(limited)).toMatch(/limit reached/);
    expect(providerInstanceUnavailableReason(undefined, { providerName: "Codex" })).toMatch(
      /Codex is not set up/,
    );

    expect(limited && providerInstancePickerBlockReason(limited)).toMatch(/limit reached/);
    expect(flaky && providerInstancePickerBlockReason(flaky)).toBeNull();
    expect(flaky && isProviderInstancePickerSelectable(flaky)).toBe(true);
  });

  it("flags a saved model the provider no longer offers", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        models: [model("gpt-5.5")],
      }),
    ]);
    expect(providerInstanceUnavailableReason(entry, { model: "gpt-5.5" })).toBeNull();
    expect(providerInstanceUnavailableReason(entry, { model: "retired-model" })).toMatch(
      /retired-model is not available on/,
    );
  });
});
