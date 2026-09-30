import { describe, expect, it } from "@effect/vitest";
import { type ModelCapabilities, ProviderDriverKind } from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { createModelCapabilities } from "@akeru/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  providerUnavailabilityFromDetail,
  spawnAndCollect,
} from "./providerSnapshot.ts";

describe("buildServerProvider", () => {
  it("does not turn a ready provider's upgrade notice into a login block", () => {
    const input = {
      driver: ProviderDriverKind.make("claudeAgent"),
      presentation: { displayName: "Claude" },
      enabled: true,
      checkedAt: "2026-09-28T00:00:00.000Z",
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        message: "Please run login after upgrading Claude",
      },
    };

    expect(buildServerProvider(input).unavailability).toBeUndefined();
    expect(
      buildServerProvider({ ...input, probe: { ...input.probe, status: "error" } }).unavailability,
    ).toBe("missing-login");
  });
});

describe("providerUnavailabilityFromDetail", () => {
  it.each([
    ["codex", "Not authenticated", "missing-login"],
    ["codex", "refresh token expired; rate limit", "expired-login"],
    ["claudeAgent", "Please run login: OAuth token expired", "expired-login"],
    ["claudeAgent", "model claude-9 not found", "unsupported-model"],
    ["grok", "model not found", "unsupported-model"],
    ["kimi", "rate limit exceeded", "limit-reached"],
    ["opencodeGo", "spending limit reached", "usage-cap"],
    ["opencodeGo", "rate limit and usage cap", "usage-cap"],
    ["opencode", "OpenCode authentication expired; please re-authenticate", "expired-login"],
    ["opencode", "OpenCode model openai/gpt-5 not found", "unsupported-model"],
    ["opencode", "OpenCode API rate limit exceeded", "limit-reached"],
    ["opencode", "OpenCode usage cap exceeded", "usage-cap"],
    ["codex", "socket closed", "temporary-failure"],
  ])("maps %s provider detail", (driver, detail, category) => {
    expect(providerUnavailabilityFromDetail(driver, detail)).toBe(category);
  });
});

describe("buildServerProvider unavailability", () => {
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      driver: ProviderDriverKind.make("claudeAgent"),
      presentation: { displayName: "Claude" },
      enabled: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      probe,
    });
  const authenticated = { status: "authenticated" as const };

  it("ignores informational messages on usable providers", () => {
    expect(
      build({
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: authenticated,
        message: "A newer Claude CLI is available.",
      }).unavailability,
    ).toBeUndefined();
    expect(
      build({
        installed: true,
        version: null,
        status: "warning",
        auth: authenticated,
        message: "Provider status has not been checked in this session yet.",
      }).unavailability,
    ).toBeUndefined();
  });

  it("keeps specific causes on warnings and any cause on errors", () => {
    expect(
      build({
        installed: true,
        version: null,
        status: "warning",
        auth: authenticated,
        message: "rate limit exceeded",
      }).unavailability,
    ).toBe("limit-reached");
    expect(
      build({
        installed: true,
        version: null,
        status: "error",
        auth: authenticated,
        message: "socket closed",
      }).unavailability,
    ).toBe("temporary-failure");
    expect(
      build({
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unauthenticated" },
      }).unavailability,
    ).toBe("missing-login");
  });
});

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("ProviderCommandNotFoundError", () => {
  it("classifies normalized platform failures without parsing messages", () => {
    expect(
      isCommandMissingCause(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "arbitrary host detail",
        }),
      ),
    ).toBe(true);
    expect(isCommandMissingCause(new Error("spawn provider ENOENT"))).toBe(false);
  });

  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});
