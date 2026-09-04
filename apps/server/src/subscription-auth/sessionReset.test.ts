import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId, type ProviderSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { SubscriptionProviderId } from "./service.ts";
import type { ApiKeyCredential } from "./types.ts";
import { makeApiKeySessionReset } from "./sessionReset.ts";

function fixture() {
  const credentials: Partial<Record<SubscriptionProviderId, ApiKeyCredential>> = {};
  const stopped: string[] = [];
  const sessions = ["claudeAgent", "grok", "opencode", "codex"].map(
    (driver): ProviderSession => ({
      provider: ProviderDriverKind.make(driver),
      threadId: ThreadId.make(`thread-${driver}`),
      status: "ready",
      runtimeMode: "full-access",
      createdAt: "2026-09-04T00:00:00Z",
      updatedAt: "2026-09-04T00:00:00Z",
    }),
  );
  const reset = makeApiKeySessionReset(
    { getApiKeyCredential: (provider) => credentials[provider] },
    {
      listSessions: () => Effect.succeed(sessions),
      stopSession: ({ threadId }) =>
        Effect.sync(() => {
          stopped.push(threadId);
        }),
    },
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

  it.effect("does not stop sessions after a failed login", () =>
    Effect.gen(function* () {
      const { stopped, reset } = fixture();
      const result = yield* reset(Effect.fail("login failed")).pipe(Effect.flip);
      expect(result).toBe("login failed");
      expect(stopped).toEqual([]);
    }),
  );
});
