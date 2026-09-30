import { catalogRegistry, createTranslator } from "@akeru/client-runtime/i18n";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { makeComposerTestProvider } from "../../test/composerTestProvider";
import {
  botEngineFailureContext,
  botEngineTakesDelegatedWork,
  botEngineUnavailability,
  resolveStickyBotEngine,
  routineDelegateOptions,
} from "./botEngineSelection";

const settings = DEFAULT_UNIFIED_SETTINGS;

describe("resolveStickyBotEngine", () => {
  it("keeps a saved engine whose provider is turned off and explains why", () => {
    const providers = [
      {
        ...makeComposerTestProvider(),
        enabled: false,
        installed: false,
        status: "disabled" as const,
        auth: { status: "unknown" as const },
      },
    ];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]!.instanceId;

    expect(
      resolveStickyBotEngine({
        engine: { provider: instanceId, model: "gpt-5.6-sol" },
        instanceEntries,
        settings,
        providers,
        defaultSelection: { instanceId, model: "gpt-5.6-sol" },
      }),
    ).toEqual({ instanceId, model: "gpt-5.6-sol" });
    expect(
      botEngineUnavailability({ instanceId, model: "gpt-5.6-sol" }, instanceEntries),
    ).toMatchObject({ reason: "disabled", action: "providers" });
  });

  it("returns no engine for a bot without one when no provider can run", () => {
    const providers = [
      {
        ...makeComposerTestProvider(),
        enabled: false,
        installed: false,
        status: "disabled" as const,
        auth: { status: "unknown" as const },
      },
    ];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]!.instanceId;
    expect(
      resolveStickyBotEngine({
        engine: null,
        instanceEntries,
        settings,
        providers,
        defaultSelection: { instanceId, model: "gpt-5.6-sol" },
      }),
    ).toBeNull();
    expect(botEngineUnavailability(null, instanceEntries)).toMatchObject({
      reason: "missing-provider",
      title: "No provider is ready for this bot",
    });
  });

  it("explains a selected engine that cannot run in each locale", async () => {
    const expired = {
      ...makeComposerTestProvider(),
      displayName: "Codex",
      unavailability: "expired-login" as const,
    };
    const signedIn = deriveProviderInstanceEntries([makeComposerTestProvider()]);
    const signedOut = deriveProviderInstanceEntries([expired]);
    const instanceId = signedOut[0]!.instanceId;
    const zh = createTranslator("zh-CN", await catalogRegistry["zh-CN"]!()).t;

    expect(botEngineUnavailability({ instanceId, model: "gpt-5-codex" }, signedOut)).toMatchObject({
      reason: "expired-login",
      title: "Codex sign-in expired",
      description: "Reconnect Codex in Settings > Providers, then send your message again.",
    });
    expect(
      botEngineUnavailability({ instanceId, model: "gpt-5-codex" }, signedOut, zh),
    ).toMatchObject({
      title: "Codex 登录已过期",
      description: "请在“设置 > 提供商”中重新连接 Codex，然后重新发送消息。",
    });
    expect(botEngineUnavailability({ instanceId, model: "gpt-4-retired" }, signedIn)).toMatchObject(
      {
        reason: "unsupported-model",
        description: "Pick another model for this bot.",
      },
    );
    expect(
      botEngineUnavailability({ instanceId, model: "gpt-4-retired" }, signedIn, zh),
    ).toMatchObject({
      title: expect.stringMatching(/^gpt-4-retired 在 .+ 上不可用$/),
      description: "请为此机器人选择其他模型。",
    });
    expect(botEngineUnavailability(null, signedIn, zh)).toMatchObject({
      reason: "missing-provider",
      title: "此机器人没有可用的提供商",
      description: "请在“设置 > 提供商”中连接一个提供商，以便此机器人回复。",
    });
  });

  it("does not rewrite a signed-out engine to another provider", () => {
    const signedOut = {
      ...makeComposerTestProvider(),
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: { status: "unauthenticated" as const },
      models: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          isCustom: false,
          capabilities: {},
        },
      ],
    };
    const providers = [makeComposerTestProvider(), signedOut];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const engine = { provider: signedOut.instanceId, model: "claude-opus-5-5" };

    const resolved = resolveStickyBotEngine({
      engine,
      instanceEntries,
      settings,
      providers,
      defaultSelection: { instanceId: instanceEntries[0]!.instanceId, model: "gpt-5.6-sol" },
    });

    expect(resolved).toEqual({ instanceId: signedOut.instanceId, model: "claude-opus-5-5" });
    const unavailable = botEngineUnavailability(resolved, instanceEntries);
    expect(unavailable).toMatchObject({ reason: "missing-login", action: "providers" });
    expect(unavailable?.title).toContain("is not connected");
  });

  it("flags a saved model the provider no longer lists", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]!.instanceId;
    expect(
      botEngineUnavailability({ instanceId, model: "retired-model" }, instanceEntries),
    ).toMatchObject({ reason: "unsupported-model", action: "none" });
  });

  it("does not show a fallback provider for a bot with an unavailable saved engine", () => {
    const savedId = ProviderInstanceId.make("codex");
    const fallbackId = ProviderInstanceId.make("codex-backup");
    const providers = [
      { ...makeComposerTestProvider(), enabled: false, status: "disabled" as const },
      { ...makeComposerTestProvider(), instanceId: fallbackId },
    ];

    const instanceEntries = deriveProviderInstanceEntries(providers);
    const selected = resolveStickyBotEngine({
      engine: { provider: savedId, model: "gpt-5-codex" },
      instanceEntries,
      settings,
      providers,
      defaultSelection: { instanceId: fallbackId, model: "gpt-5-codex" },
    });
    expect(selected).toEqual({ instanceId: savedId, model: "gpt-5-codex" });
    expect(botEngineUnavailability(selected, instanceEntries)?.reason).not.toBeNull();
  });

  it("keeps the bot engine model instead of the app default", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]?.instanceId;
    if (!instanceId) throw new Error("missing instance");

    const resolved = resolveStickyBotEngine({
      engine: {
        provider: instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      instanceEntries,
      settings,
      providers,
      defaultSelection: { instanceId, model: "gpt-5.6-luna" },
    });

    expect(resolved).toEqual({
      instanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("uses the default instance when the bot has no engine", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]?.instanceId ?? ProviderInstanceId.make("codex");

    const resolved = resolveStickyBotEngine({
      engine: null,
      instanceEntries,
      settings,
      providers,
      defaultSelection: { instanceId, model: "gpt-5.6-luna" },
    });

    expect(resolved?.instanceId).toBe(instanceId);
  });

  it("inherits app options when an older bot engine matches the app model", () => {
    const providers = [makeComposerTestProvider()];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const instanceId = instanceEntries[0]?.instanceId;
    if (!instanceId) throw new Error("missing instance");

    expect(
      resolveStickyBotEngine({
        engine: { provider: instanceId, model: "gpt-5.6-sol" },
        instanceEntries,
        settings,
        providers,
        defaultSelection: {
          instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      }),
    ).toEqual({
      instanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
});

describe("botEngineFailureContext", () => {
  it("names the provider and model behind a failed reply", () => {
    const instanceEntries = deriveProviderInstanceEntries([makeComposerTestProvider()]);
    const entry = instanceEntries[0]!;
    const model = entry.models[0]!;

    expect(
      botEngineFailureContext(
        { instanceId: entry.instanceId, model: model.slug },
        instanceEntries,
        "missing-login",
      ),
    ).toEqual({
      unavailability: "missing-login",
      providerName: entry.displayName,
      modelName: model.name,
    });
    expect(botEngineFailureContext(null, instanceEntries, undefined)).toEqual({
      unavailability: null,
      providerName: null,
      modelName: null,
    });
  });
});

describe("botEngineTakesDelegatedWork", () => {
  const instanceEntries = deriveProviderInstanceEntries([
    makeComposerTestProvider(),
    {
      ...makeComposerTestProvider(),
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
    },
    {
      ...makeComposerTestProvider(),
      instanceId: ProviderInstanceId.make("opencode_go"),
      driver: ProviderDriverKind.make("opencodeGo"),
    },
  ]);

  it("marks only a saved engine on standard OpenCode", () => {
    expect(
      botEngineTakesDelegatedWork({ provider: "opencode", model: "model" }, instanceEntries),
    ).toBe(false);
    expect(
      botEngineTakesDelegatedWork({ provider: "opencode_go", model: "model" }, instanceEntries),
    ).toBe(true);
    expect(
      botEngineTakesDelegatedWork({ provider: "codex", model: "model" }, instanceEntries),
    ).toBe(true);
  });

  it("does not mark a bot without an engine or on an unknown instance", () => {
    expect(botEngineTakesDelegatedWork(null, instanceEntries)).toBe(true);
    expect(
      botEngineTakesDelegatedWork({ provider: "missing", model: "model" }, instanceEntries),
    ).toBe(true);
  });
});

describe("routineDelegateOptions", () => {
  const instanceEntries = deriveProviderInstanceEntries([
    makeComposerTestProvider(),
    {
      ...makeComposerTestProvider(),
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
    },
  ]);
  const bot = (id: string, provider: string | null, archivedAt: string | null = null) => ({
    id,
    name: id,
    archivedAt,
    engine: provider === null ? null : { provider, model: "model" },
  });

  it("leaves out the routine's own bot and archived bots, and marks bots that cannot take work", () => {
    expect(
      routineDelegateOptions(
        "owner",
        [
          bot("owner", "codex"),
          bot("scout", "codex"),
          bot("builder", "opencode"),
          bot("retired", "codex", "2026-09-01T00:00:00.000Z"),
          bot("fresh", null),
        ],
        instanceEntries,
      ),
    ).toEqual([
      { id: "scout", name: "scout", canTakeWork: true },
      { id: "builder", name: "builder", canTakeWork: false },
      { id: "fresh", name: "fresh", canTakeWork: true },
    ]);
  });
});
