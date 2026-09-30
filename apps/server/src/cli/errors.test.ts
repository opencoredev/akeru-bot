import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";

import { reportExpectedCliError } from "./errors.ts";

class ExpectedCliError extends Schema.TaggedErrorClass<ExpectedCliError>()("ExpectedCliError", {}) {
  override get message(): string {
    return "Something expected went wrong. Try again.";
  }
}

class WrappingCliError extends Schema.TaggedErrorClass<WrappingCliError>()("WrappingCliError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The thing failed.";
  }
}

describe("reportExpectedCliError", () => {
  it.effect("prints the message and suppresses the runMain report for allowlisted tags", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.fail(new ExpectedCliError()).pipe(reportExpectedCliError(["ExpectedCliError"])),
      );
      if (!Exit.isFailure(exit)) assert.fail("expected the command to fail");
      assert.isFalse(Runtime.getErrorReported(Cause.squash(exit.cause)));
      const errorLines = yield* TestConsole.errorLines;
      assert.equal(errorLines.at(-1), "Something expected went wrong. Try again.");
    }).pipe(Effect.provide(TestConsole.layer)),
  );

  it.effect("prints the wrapped cause on a second line when the error carries one", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.fail(new WrappingCliError({ cause: new Error("tailscale: exit status 1") })).pipe(
          reportExpectedCliError(["WrappingCliError"]),
        ),
      );
      if (!Exit.isFailure(exit)) assert.fail("expected the command to fail");
      assert.isFalse(Runtime.getErrorReported(Cause.squash(exit.cause)));
      const errorLines = yield* TestConsole.errorLines;
      const rendered = errorLines.at(-1) ?? "";
      assert.include(rendered, "The thing failed.");
      assert.include(rendered, "Caused by:");
      assert.include(rendered, "tailscale: exit status 1");
    }).pipe(Effect.provide(TestConsole.layer)),
  );

  it.effect("leaves non-allowlisted errors untouched and reported", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.fail(new WrappingCliError({ cause: new Error("disk is read-only") })).pipe(
          reportExpectedCliError(["ExpectedCliError"]),
        ),
      );
      if (!Exit.isFailure(exit)) assert.fail("expected the command to fail");
      assert.isTrue(Runtime.getErrorReported(Cause.squash(exit.cause)));
      const errorLines = yield* TestConsole.errorLines;
      assert.isEmpty(errorLines.filter((line): line is string => typeof line === "string"));
    }).pipe(Effect.provide(TestConsole.layer)),
  );
});
