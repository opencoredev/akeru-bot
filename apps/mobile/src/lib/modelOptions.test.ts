import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveModelSendBlock,
  resolveSelectableModelSelection,
} from "./modelOptions";

describe("mobile model options", () => {
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("lists host-detected models for disconnected subscriptions as disabled", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", capabilities: null }],
        },
        {
          instanceId: "grok",
          driver: "grok",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          models: [{ slug: "grok-build", name: "Grok Build", capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildModelOptions(config, null, [
      {
        provider: "openai-codex",
        connected: false,
        health: "missing",
        dependentBots: [],
        dependentRoutines: [],
      },
      {
        provider: "xai",
        connected: true,
        health: "detected",
        dependentBots: [],
        dependentRoutines: [],
      },
    ]);

    expect(
      options.map((option) => [option.key, option.disabledReason?.split(".")[0] ?? null]),
    ).toEqual([
      ["codex:gpt-5.6-sol", "Codex is not connected"],
      ["grok:grok-build", null],
    ]);
  });

  it("keeps unavailable providers' models visible with their reason", () => {
    const config = {
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "unauthenticated" },
          unavailability: "missing-login",
          models: [{ slug: "claude-opus", name: "Claude Opus", capabilities: null }],
        },
        {
          instanceId: "kimi",
          driver: "kimi",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "kimi-k3", name: "Kimi K3", capabilities: null }],
        },
        {
          instanceId: "grok",
          driver: "grok",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          unavailability: "temporary-failure",
          models: [{ slug: "grok-build", name: "Grok Build", capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;

    const options = buildModelOptions(config, null);

    expect(options.map((option) => [option.key, option.disabledReason])).toEqual([
      [
        "claudeAgent:claude-opus",
        "Claude is not connected. Connect your Claude account in Settings > Providers.",
      ],
      [
        "kimi:kimi-k3",
        "Kimi For Coding is turned off. Turn Kimi For Coding on in Settings > Providers, then send your message again.",
      ],
      ["grok:grok-build", null],
    ]);
  });

  it("keeps a saved selection visible after its provider drops the model", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", capabilities: null }],
        },
      ],
    } as unknown as ServerConfig;

    const saved = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-4-retired",
    }).find((option) => option.key === "codex:gpt-4-retired");

    expect(saved?.providerLabel).toBe("Codex");
    expect(saved?.disabledReason).toBe(
      "gpt-4-retired is not available on Codex. Pick another model for this bot.",
    );
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });
});

describe("resolveModelSendBlock", () => {
  const claude = (patch: Record<string, unknown>) =>
    ({
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [{ slug: "claude-opus", name: "Claude Opus", isCustom: false }],
          ...patch,
        },
      ],
    }) as unknown as ServerConfig;
  const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };

  it("blocks Send with the provider, what failed, and the next step", () => {
    const block = resolveModelSendBlock(
      claude({ auth: { status: "unauthenticated" }, unavailability: "missing-login" }),
      selection,
    );
    expect(block).toMatchObject({ title: "Claude is not connected", action: "providers" });
  });

  it("names the saved model when the provider no longer offers it", () => {
    const block = resolveModelSendBlock(claude({ models: [{ slug: "other", name: "Other" }] }), {
      ...selection,
    });
    expect(block?.title).toBe("claude-opus is not available on Claude");
  });

  it("lets a temporary failure or an offline environment through", () => {
    expect(resolveModelSendBlock(claude({ unavailability: "temporary-failure" }), selection)).toBe(
      null,
    );
    expect(resolveModelSendBlock(null, selection)).toBe(null);
    expect(resolveModelSendBlock(claude({}), selection)).toBe(null);
  });
});
