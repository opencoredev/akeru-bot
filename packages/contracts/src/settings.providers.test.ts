import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  defaultEnabledForDriver,
  resolveProviderInstanceEnabled,
} from "./settings.ts";
import {
  decodeServerSettings,
  decodeServerSettingsPatch,
  decodeServerSettingsRpcPatch,
  decodeClaudeSettings,
} from "./settings.test-support.ts";

describe("ServerSettings voice", () => {
  it("rejects unsupported providers and voices", () => {
    expect(() => decodeServerSettings({ voice: { provider: "xai" } })).toThrow();
    expect(() => decodeServerSettingsPatch({ voice: { voice: "unknown" } })).toThrow();
  });
});

describe("ClaudeSettings auto-compaction", () => {
  it("uses Claude's default threshold when no override is configured", () => {
    expect(decodeClaudeSettings({}).autoCompactWindow).toBe("");
  });

  it.each(["100000", "300000", "1000000"])(
    "accepts a supported auto-compaction threshold: %s",
    (value) => {
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
    },
  );

  it.each(["99999", "1000001", "300k", "invalid"])(
    "rejects an unsupported auto-compaction threshold: %s",
    (value) => {
      expect(() => decodeClaudeSettings({ autoCompactWindow: value })).toThrow();
    },
  );

  it("rejects an unsupported threshold at the settings patch boundary", () => {
    expect(() =>
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300k" } } }),
    ).toThrow();
    expect(
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300000" } } }),
    ).toBeDefined();
  });
});

describe("ServerSettings sandbox providers", () => {
  it("defaults to local with cloud providers disconnected", () => {
    expect(decodeServerSettings({}).sandbox).toEqual({
      defaultProvider: "local",
      autoIdle: true,
      providers: {
        e2b: { environment: [] },
        daytona: { environment: [] },
        vercel: { environment: [] },
        upstash: { environment: [] },
        ascii: { environment: [] },
        railway: { environment: [] },
        tenki: { environment: [] },
      },
    });
  });

  it("accepts a provider credential patch", () => {
    expect(
      decodeServerSettingsPatch({
        sandbox: {
          defaultProvider: "e2b",
          providers: {
            e2b: {
              environment: [{ name: "E2B_API_KEY", value: "secret", sensitive: true }],
            },
          },
        },
      }).sandbox,
    ).toEqual({
      defaultProvider: "e2b",
      providers: {
        e2b: {
          environment: [{ name: "E2B_API_KEY", value: "secret", sensitive: true }],
        },
      },
    });
  });

  it("accepts the Ascii Box credential", () => {
    expect(
      decodeServerSettingsPatch({
        sandbox: {
          providers: {
            ascii: {
              environment: [{ name: "BOX_API_KEY", value: "secret", sensitive: true }],
            },
          },
        },
      }).sandbox?.providers?.ascii?.environment,
    ).toEqual([{ name: "BOX_API_KEY", value: "secret", sensitive: true }]);
  });

  it("accepts Tenki's secret API key", () => {
    expect(
      decodeServerSettingsRpcPatch({
        sandbox: {
          providers: {
            tenki: {
              environment: [{ name: "TENKI_API_KEY", value: "secret", sensitive: true }],
            },
          },
        },
      }).sandbox?.providers?.tenki?.environment,
    ).toEqual([{ name: "TENKI_API_KEY", value: "secret", sensitive: true }]);
  });

  it("keeps automatic idle cleanup enabled", () => {
    expect(() => decodeServerSettingsPatch({ sandbox: { autoIdle: false } })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });

    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("provider enabled defaults", () => {
  it("enables only the stable bindings by default", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.claudeAgent.enabled).toBe(true);
    expect(decoded.providers.grok.enabled).toBe(false);
    expect(decoded.providers.grok.verboseProtocolLogging).toBe(false);
    expect(decoded.providers.opencode.enabled).toBe(false);
    expect(decoded.providers.opencodeGo.enabled).toBe(true);
  });

  it("decodes ACP protocol logging opt-ins for Grok", () => {
    const decoded = decodeServerSettings({
      providers: {
        grok: { verboseProtocolLogging: true },
      },
    });

    expect(decoded.providers.grok.verboseProtocolLogging).toBe(true);
  });

  it("derives per-driver defaults from the settings schemas", () => {
    expect(defaultEnabledForDriver(ProviderDriverKind.make("codex"))).toBe(true);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("grok"))).toBe(false);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("opencodeGo"))).toBe(true);
    // Unknown fork drivers stay enabled; their own build decides otherwise.
    expect(defaultEnabledForDriver(ProviderDriverKind.make("ollama"))).toBe(true);
  });

  it("still decodes settings that name the retired Cursor provider", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorId = ProviderInstanceId.make("cursor");

    const decoded = decodeServerSettings({
      providers: { cursor: { enabled: true, binaryPath: "cursor-agent" } },
      providerInstances: {
        [cursorId]: { driver: cursor, enabled: true, config: { binaryPath: "cursor-agent" } },
      },
    });

    // The legacy map drops the key; the instance envelope survives opaquely and
    // the registry reports it as an unavailable driver.
    expect(decoded.providers).not.toHaveProperty("cursor");
    expect(decoded.providerInstances[cursorId]?.driver).toBe(cursor);
    expect(decodeServerSettingsPatch({ providers: { cursor: { enabled: false } } })).toEqual({
      providers: {},
    });
  });

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    // No flags anywhere: driver default applies.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    // Envelope flag wins over the driver default.
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    // Legacy in-config flag fills in when the envelope is silent.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    // Conflicting flags: the explicit false wins, whichever side it is on.
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });

    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });

    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});
