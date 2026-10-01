import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeBrowserbaseSession } from "./BrowserbaseContext.ts";

for (const input of [
  null,
  {},
  { connectUrl: "" },
  { connectUrl: 42 },
  { connectUrl: "not-a-url" },
  { connectUrl: "file:///tmp/session" },
]) {
  it.effect(`rejects a malformed Browserbase session ${JSON.stringify(input)}`, () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(decodeBrowserbaseSession(input));
      assert.equal(failure._tag, "BrowserConfigurationError");
      assert.equal(failure.message, "Browserbase returned an invalid browser connection URL.");
    }),
  );
}
it.effect("accepts a CDP connection URL without depending on unused provider fields", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* decodeBrowserbaseSession({
        connectUrl: "wss://connect.example.com/session",
        unused: "value",
      }),
      { connectUrl: "wss://connect.example.com/session" },
    );
  }),
);
