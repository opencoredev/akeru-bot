import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

/**
 * Shared handling for the tagged errors a CLI command raises on purpose, as
 * opposed to defects: the message already tells the user what happened and how
 * to fix it, so the command prints only that to stderr and still fails. The
 * error is marked reported so `NodeRuntime.runMain` does not log it again with
 * a stack trace.
 *
 * Only errors whose `_tag` is on the caller's allowlist are handled this way.
 * Everything else — infrastructure failures, defects — falls through untouched
 * so `runMain` still prints it with its cause and stack.
 */
export const reportExpectedCliError =
  (expectedTags: ReadonlyArray<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tapError(effect, (error) => {
      const tagged = error as { readonly _tag?: unknown; readonly cause?: unknown };
      if (
        !(error instanceof Error) ||
        typeof tagged._tag !== "string" ||
        !expectedTags.includes(tagged._tag)
      ) {
        return Effect.void;
      }
      const lines =
        tagged.cause === undefined
          ? [error.message]
          : [error.message, `Caused by: ${String(tagged.cause)}`];
      return Console.error(lines.join("\n")).pipe(
        Effect.andThen(
          Effect.sync(() => {
            (error as Record<string, unknown>)[Runtime.errorReported] = false;
          }),
        ),
      );
    });
