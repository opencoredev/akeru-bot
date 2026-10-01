import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { beforeEach } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import {
  OpenCodeAdapter,
  asThreadId,
  makeOpenCodeAdapterHarness,
} from "./test-support/openCodeAdapterHarness.ts";

const { runtimeMock, OpenCodeAdapterTestLayer } = makeOpenCodeAdapterHarness();

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("aborts nested child sessions on interrupt and leaves unrelated sessions alone", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-interrupt-children");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.sessionChildrenById.set(rootSessionId, [
        { id: "ses_child_a" },
        { id: "ses_child_b" },
      ]);
      runtimeMock.state.sessionChildrenById.set("ses_child_a", [{ id: "ses_grandchild" }]);
      runtimeMock.state.sessionChildrenById.set("ses_unrelated", [{ id: "ses_unrelated_child" }]);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run child agents",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      yield* adapter.interruptTurn(threadId, turn.turnId);

      NodeAssert.equal(runtimeMock.state.abortCalls[0], rootSessionId);
      NodeAssert.deepEqual(
        new Set(runtimeMock.state.abortCalls.slice(1)),
        new Set(["ses_child_a", "ses_child_b", "ses_grandchild"]),
      );
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_unrelated"), false);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_unrelated_child"), false);
      NodeAssert.deepEqual(
        new Set(runtimeMock.state.sessionChildrenCalls),
        new Set([rootSessionId, "ses_child_a", "ses_child_b", "ses_grandchild"]),
      );

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("fails interrupt when a child abort fails after attempting every descendant", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-interrupt-child-failure");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.sessionChildrenById.set(rootSessionId, [
        { id: "ses_failing_child" },
        { id: "ses_surviving_sibling" },
      ]);
      runtimeMock.state.abortImplementation = async (sessionID) => {
        if (sessionID === "ses_failing_child") {
          throw new Error("child abort failed");
        }
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run child agents",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const result = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
      NodeAssert.equal(Exit.isFailure(result), true);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_failing_child"), true);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_surviving_sibling"), true);

      yield* adapter.stopSession(threadId);
    }),
  );
});
