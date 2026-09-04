import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfig,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { SubscriptionProviderId } from "./service.ts";
import type { ApiKeyCredential } from "./types.ts";
import { makeApiKeySessionReset } from "./sessionReset.ts";

function session(driver: string, instanceId?: string): ProviderSession {
  return {
    provider: ProviderDriverKind.make(driver),
    ...(instanceId ? { providerInstanceId: ProviderInstanceId.make(instanceId) } : {}),
    threadId: ThreadId.make(`thread-${instanceId ?? driver}`),
    status: "ready",
    runtimeMode: "full-access",
    createdAt: "2026-09-04T00:00:00Z",
    updatedAt: "2026-09-04T00:00:00Z",
  };
}

function fixture(
  extraSessions: ReadonlyArray<ProviderSession> = [],
  instances: Readonly<Record<string, ProviderInstanceConfig>> = {},
) {
  const credentials: Partial<Record<SubscriptionProviderId, ApiKeyCredential>> = {};
  const stopped: string[] = [];
  const sessions = [
    ...["claudeAgent", "grok", "opencode", "codex"].map((driver) => session(driver)),
    ...extraSessions,
  ];
  const reset = makeApiKeySessionReset(
    { getApiKeyCredential: (provider) => credentials[provider] },
    {
      listSessions: () => Effect.succeed(sessions),
      stopSession: ({ threadId }) =>
        Effect.sync(() => {
          stopped.push(threadId);
        }),
    },
    Effect.succeed(instances),
  );
  return { credentials, stopped, reset };
}

describe("API-key session reset", () => {
  it.effect("stops the matching bridge after replacing its key", () =>
    Effect.gen(function* () {
      const { credentials, stopped, reset } = fixture();
      credentials.anthropic = { type: "api-key", access: "old-key" };
      const result = yield* reset(
        Effect.sync(() => {
          credentials.anthropic = { type: "api-key", access: "new-key" };
          return "connected";
        }),
      );
      expect(result).toBe("connected");
      expect(stopped).toEqual(["thread-claudeAgent"]);
    }),
  );

  it.effect("stops a bridge when its key is disconnected or replaced by OAuth", () =>
    Effect.gen(function* () {
      const { credentials, stopped, reset } = fixture();
      credentials.xai = { type: "api-key", access: "grok-key" };
      yield* reset(
        Effect.sync(() => {
          delete credentials.xai;
        }),
      );
      expect(stopped).toEqual(["thread-grok"]);
    }),
  );

  it.effect("stops a bridge when only the endpoint changes", () =>
    Effect.gen(function* () {
      const { credentials, stopped, reset } = fixture();
      credentials["opencode-go"] = {
        type: "api-key",
        access: "key",
        baseUrl: "https://old.example/v1",
      };
      yield* reset(
        Effect.sync(() => {
          credentials["opencode-go"] = {
            type: "api-key",
            access: "key",
            baseUrl: "https://new.example/v1",
          };
        }),
      );
      expect(stopped).toEqual(["thread-opencode"]);
    }),
  );

  it.effect("keeps sessions for pending and unchanged credentials", () =>
    Effect.gen(function* () {
      const { credentials, stopped, reset } = fixture();
      credentials.anthropic = { type: "api-key", access: "key" };
      yield* reset(Effect.succeed({ status: "pending" }));
      yield* reset(
        Effect.sync(() => {
          credentials.anthropic = { type: "api-key", access: "key" };
        }),
      );
      expect(stopped).toEqual([]);
    }),
  );

  it.effect("keeps sessions for instances that bring their own connection", () =>
    Effect.gen(function* () {
      const { credentials, stopped, reset } = fixture(
        [
          session("claudeAgent", "claude-work"),
          session("claudeAgent", "claude-shared"),
          session("grok", "grok-own-key"),
        ],
        {
          "claude-work": {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: "~/.claude-work" },
          },
          "claude-shared": { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
          "grok-own-key": {
            driver: ProviderDriverKind.make("grok"),
            environment: [{ name: "XAI_API_KEY", value: "own", sensitive: true }],
          },
        },
      );
      credentials.anthropic = { type: "api-key", access: "old" };
      credentials.xai = { type: "api-key", access: "old" };
      yield* reset(
        Effect.sync(() => {
          credentials.anthropic = { type: "api-key", access: "new" };
          credentials.xai = { type: "api-key", access: "new" };
        }),
      );
      expect(stopped).toEqual(["thread-claudeAgent", "thread-grok", "thread-claude-shared"]);
    }),
  );

  it.effect("does not stop sessions after a failed login", () =>
    Effect.gen(function* () {
      const { stopped, reset } = fixture();
      const result = yield* reset(Effect.fail("login failed")).pipe(Effect.flip);
      expect(result).toBe("login failed");
      expect(stopped).toEqual([]);
    }),
  );
});
