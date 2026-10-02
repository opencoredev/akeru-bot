import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderValidationError } from "../Errors.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import {
  asThreadId,
  codexInstanceId,
  claudeAgentInstanceId,
  CODEX_DRIVER,
  CLAUDE_AGENT_DRIVER,
  makeProviderServiceHarness,
} from "./test-support/providerServiceHarness.ts";

const { routing } = makeProviderServiceHarness();

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes feedback to the Codex adapter and returns its feedback ID", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-route");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.uploadFeedback.mockClear();

      const result = yield* provider.uploadFeedback({
        threadId,
        reason: "The agent stopped early.",
      });

      assert.deepStrictEqual(result, { feedbackId: `feedback-${threadId}` });
      assert.deepStrictEqual(routing.codex.uploadFeedback.mock.calls, [
        [{ threadId, reason: "The agent stopped early." }],
      ]);
    }),
  );
});

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("rejects feedback for providers that do not support uploads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-feedback-claude");
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* provider.uploadFeedback({ threadId }).pipe(Effect.flip);

      assert.instanceOf(error, ProviderValidationError);
      assert.include(error.issue, "does not support feedback uploads");
      routing.claude.startSession.mockClear();
    }),
  );
});
