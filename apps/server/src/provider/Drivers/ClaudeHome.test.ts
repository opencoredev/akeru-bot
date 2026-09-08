// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { subscriptionRuntimeEnvironment } from "../../subscription-auth/runtime.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("marks CLAUDE_CONFIG_DIR explicit so saved API keys do not replace the account", () =>
      Effect.gen(function* () {
        const secretsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-claude-home-"));
        try {
          const auth = SubscriptionAuthService.forSecretsDir(secretsDir);
          const login = yield* Effect.promise(() =>
            auth.startLogin("anthropic", { authMode: "api-key" }),
          );
          yield* Effect.promise(() => auth.completeLogin(login.loginId, "provider-wide-key"));
          const environment = yield* makeClaudeEnvironment(
            { homePath: "~/.claude-work" },
            { CLAUDE_CODE_OAUTH_TOKEN: "native-oauth" },
          );
          expect(subscriptionRuntimeEnvironment(secretsDir, "anthropic", environment)).toBe(
            environment,
          );
          expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
        } finally {
          NodeFS.rmSync(secretsDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
