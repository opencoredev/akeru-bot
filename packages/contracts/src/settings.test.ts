import * as Schema from "effect/Schema";
import { ServerSettingsRpcPatch } from "./settings.ts";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  decodeClientSettings,
  decodeClientSettingsPatch,
  decodeServerSettings,
  decodeServerSettingsPatch,
  encodeServerSettings,
} from "./settings.test-support.ts";

const decodeServerSettingsRpcPatch = Schema.decodeUnknownSync(ServerSettingsRpcPatch);

describe("ServerSettings voice", () => {
  it("defaults to enabled ChatGPT voice calls with Alloy", () => {
    expect(decodeServerSettings({}).voice).toEqual({
      enabled: true,
      provider: "chatgpt",
      voice: "alloy",
    });
  });

  it("accepts a partial voice settings patch", () => {
    expect(decodeServerSettingsPatch({ voice: { enabled: false, voice: "marin" } }).voice).toEqual({
      enabled: false,
      voice: "marin",
    });
  });
});

describe("ServerSettings product feedback", () => {
  it("defaults to the Akeru endpoint and remains server patchable", () => {
    expect(decodeServerSettings({})).toMatchObject({
      productFeedbackEnabled: true,
      productFeedbackEndpoint: "https://akeru-feedback.leoisadev.workers.dev/v1/feedback",
    });
    expect(
      decodeServerSettingsPatch({
        productFeedbackEnabled: false,
        productFeedbackEndpoint: "http://localhost:8787/v1/feedback",
      }),
    ).toEqual({
      productFeedbackEnabled: false,
      productFeedbackEndpoint: "http://localhost:8787/v1/feedback",
    });
  });

  it("rejects insecure non-loopback and relative endpoints", () => {
    expect(() =>
      decodeServerSettingsPatch({ productFeedbackEndpoint: "http://feedback.example.test" }),
    ).toThrow();
    expect(() => decodeServerSettingsPatch({ productFeedbackEndpoint: "/api/feedback" })).toThrow();
  });
});

describe("ServerSettings analytics", () => {
  it("defaults analytics on and accepts an opt-out patch", () => {
    expect(decodeServerSettings({}).analyticsEnabled).toBe(true);
    expect(decodeServerSettingsPatch({ analyticsEnabled: false })).toEqual({
      analyticsEnabled: false,
    });
  });

  it("rejects a non-boolean analytics patch", () => {
    expect(() => decodeServerSettingsPatch({ analyticsEnabled: "false" })).toThrow();
  });
});

describe("policy records", () => {
  it("keeps policy acceptance local", () => {
    expect(decodeClientSettings({})).toMatchObject({
      reviewedPrivacyPolicyVersion: "",
      reviewedTermsVersion: "",
    });
    expect(
      decodeClientSettingsPatch({
        reviewedPrivacyPolicyVersion: "2026-08-31",
        reviewedTermsVersion: "2026-08-31",
      }),
    ).toEqual({
      reviewedPrivacyPolicyVersion: "2026-08-31",
      reviewedTermsVersion: "2026-08-31",
    });
  });
});

describe("ServerSettings local execution", () => {
  it("auto-reviews local execution by default and accepts each supported policy", () => {
    expect(decodeServerSettings({}).localExecutionMode).toBe("auto");
    expect(
      decodeServerSettingsPatch({ localExecutionMode: "approval-required" }).localExecutionMode,
    ).toBe("approval-required");
    expect(decodeServerSettingsPatch({ localExecutionMode: "auto" }).localExecutionMode).toBe(
      "auto",
    );
    expect(
      decodeServerSettingsPatch({ localExecutionMode: "full-access" }).localExecutionMode,
    ).toBe("full-access");
  });

  it("rejects edit-only automatic approval", () => {
    expect(() => decodeServerSettingsPatch({ localExecutionMode: "auto-accept-edits" })).toThrow();
  });
});

describe("ServerSettings local execution", () => {
  it("keeps auto review as the unified default", () => {
    expect(decodeServerSettings({}).localExecutionMode).toBe("auto");
    expect(decodeServerSettingsPatch({ localExecutionMode: "auto" }).localExecutionMode).toBe(
      "auto",
    );
    expect(
      decodeServerSettingsPatch({ localExecutionMode: "full-access" }).localExecutionMode,
    ).toBe("full-access");
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});

    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});

describe("ServerSettings Akeru Cloud URL", () => {
  it("defaults to the hosted cloud and accepts HTTPS or loopback HTTP origins", () => {
    expect(decodeServerSettings({}).akeruCloudUrl).toBe(
      "https://akeru-cloud.leoisadev.workers.dev",
    );
    expect(decodeServerSettingsPatch({ akeruCloudUrl: "http://127.0.0.1:8787" })).toEqual({
      akeruCloudUrl: "http://127.0.0.1:8787",
    });
    expect(() =>
      decodeServerSettingsPatch({ akeruCloudUrl: "http://cloud.example.test" }),
    ).toThrow();
    expect(() =>
      decodeServerSettingsPatch({ akeruCloudUrl: "https://cloud.example.test/path" }),
    ).toThrow();
  });

  it("cannot be changed by clients over RPC", () => {
    expect(decodeServerSettingsRpcPatch({ akeruCloudUrl: "https://cloud.example.test" })).toEqual(
      {},
    );
  });
});
