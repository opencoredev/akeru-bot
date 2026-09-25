import { describe, expect, it } from "vite-plus/test";

import { createTranslator } from "./i18n/index.ts";
import { zhCNCatalog } from "./i18n/zh-CN.ts";
import { PROVIDER_CONNECTIONS } from "./providerAuth.ts";
import {
  providerAccessGuide,
  providerAccessModelNames,
  providerAccessState,
} from "./providerAccessGuide.ts";

describe("providerAccessState", () => {
  it("is ready only after a provider request succeeded", () => {
    expect(providerAccessState(undefined)).toBe("not-connected");
    expect(providerAccessState({ connected: false, health: "healthy" })).toBe("not-connected");
    expect(providerAccessState({ connected: true })).toBe("unverified");
    expect(providerAccessState({ connected: true, health: "detected" })).toBe("unverified");
    expect(providerAccessState({ connected: true, health: "detected", healthChecking: true })).toBe(
      "checking",
    );
    expect(providerAccessState({ connected: true, health: "healthy", healthChecking: false })).toBe(
      "ready",
    );
    expect(providerAccessState({ connected: false, healthChecking: true })).toBe("not-connected");
    expect(providerAccessState({ connected: true, health: "healthy" })).toBe("ready");
    expect(providerAccessState({ connected: true, health: "recovered" })).toBe("ready");
    expect(providerAccessState({ connected: true, health: "failed-first-request" })).toBe("failed");
    expect(providerAccessState({ connected: true, health: "expired" })).toBe("expired");
    expect(providerAccessState({ connected: true, health: "unsupported" })).toBe("unverified");
  });

  it("tells the user to wait instead of starting a check that is already running", () => {
    expect(
      providerAccessGuide("openai-codex", {
        connected: true,
        health: "detected",
        healthChecking: true,
      }),
    ).toMatchObject({
      state: "checking",
      stateLabel: "Checking access",
      nextStep: "Wait for the health check to finish.",
    });
  });
});

describe("providerAccessGuide", () => {
  it("explains every connectable provider and has no guide for removed Cursor", () => {
    for (const { id } of PROVIDER_CONNECTIONS) {
      const guide = providerAccessGuide(id, undefined);
      expect(guide?.unlockedBy, id).toBeTruthy();
      expect(guide?.apiAccess, id).toBeTruthy();
      expect(guide?.limits, id).toBeTruthy();
      expect(guide?.state, id).toBe("not-connected");
    }
    expect(providerAccessGuide("cursor", undefined)).toBeNull();
  });

  it("does not claim that a consumer subscription includes API access", () => {
    for (const id of ["openai-codex", "anthropic", "xai", "kimi-for-coding"] as const) {
      expect(providerAccessGuide(id, undefined)?.apiAccess, id).toMatch(/do(es)? not include/);
    }
    expect(providerAccessGuide("opencode-go", undefined)?.alternative).toBeNull();
  });

  it("gives one next step that matches the credential type", () => {
    expect(providerAccessGuide("anthropic", { connected: true, health: "detected" })).toMatchObject(
      {
        stateLabel: "Not verified yet",
        saved: "Subscription login saved in this environment.",
        nextStep: "Choose Check OAuth to send a health request.",
      },
    );
    expect(
      providerAccessGuide("anthropic", {
        connected: true,
        authMode: "api-key",
        health: "failed",
        lastFailedRequest: { at: "2026-09-25T00:00:00.000Z", message: "401 Unauthorized" },
      }),
    ).toMatchObject({
      saved: "API key saved in this environment.",
      nextStep: "Check the key and its billing, then choose Check key.",
      failure: "401 Unauthorized",
    });
    expect(
      providerAccessGuide("anthropic", {
        connected: true,
        health: "recovered",
        lastFailedRequest: { at: "2026-09-25T00:00:00.000Z", message: "401 Unauthorized" },
      })?.failure,
    ).toBeNull();
    expect(providerAccessGuide("opencode-go", undefined)).toMatchObject({
      saved: "Missing: no OpenCode Go API key in this environment.",
      nextStep: "Choose Connect and paste your OpenCode Go API key.",
    });
    expect(
      providerAccessGuide("openai-codex", { connected: true, health: "healthy" })?.nextStep,
    ).toBe("No action needed. A provider request succeeded.");
  });

  it("lists live model names and caps the list", () => {
    expect(providerAccessGuide("xai", undefined, { models: ["Grok 4"] })?.models).toBe("Grok 4.");
    expect(
      providerAccessGuide("xai", undefined, { models: ["a", "b", "c", "d", "e", "f"] })?.models,
    ).toBe("a, b, c, d, and 2 more.");
  });

  it("reads model names from the default instance only", () => {
    const model = (name: string, isCustom = false) => ({
      slug: name,
      name,
      isCustom,
      capabilities: null,
    });
    const providers = [
      { instanceId: "grok", driver: "grok", models: [model("Grok 4"), model("mine", true)] },
      { instanceId: "grok-work", driver: "grok", models: [model("Other")] },
    ] as unknown as Parameters<typeof providerAccessModelNames>[0];
    expect(providerAccessModelNames(providers, "xai")).toEqual(["Grok 4"]);
    expect(providerAccessModelNames(providers, "anthropic")).toEqual([]);
    expect(providerAccessModelNames(undefined, "xai")).toEqual([]);
  });

  it("translates every guide string in zh-CN", () => {
    const { t } = createTranslator("zh-CN", zhCNCatalog);
    const guide = providerAccessGuide(
      "kimi-for-coding",
      { connected: true, health: "expired" },
      { t },
    );
    expect(guide).toMatchObject({
      stateLabel: "登录已过期",
      unlockedBy: "Kimi For Coding 会员。",
      nextStep: "选择“重新连接”，然后重新登录。",
    });
  });
});
