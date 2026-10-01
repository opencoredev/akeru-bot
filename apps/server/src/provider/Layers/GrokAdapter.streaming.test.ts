import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ThreadId } from "@akeru/contracts";
import {
  makeMockGrokWrapper,
  grokAdapterTestLayer,
  makeTestAdapter,
} from "./test-support/grokAdapterHarness.ts";

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());

      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-native-events",
          write: <Input>(record: Input) =>
            Predicate.isObject(record) &&
            record !== null &&
            "event" in record &&
            Predicate.isObject(record.event) &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const contentDelta = yield* Deferred.make<void>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
