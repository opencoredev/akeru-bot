import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeEvaluationValue, evaluateWithDebugger } from "./PreviewEvaluation.ts";
import type { SendCommand } from "./PreviewModel.ts";

const decodeBoolean = Schema.decodeUnknownEffect(Schema.Boolean);

const decodePoint = Schema.decodeUnknownEffect(
  Schema.Struct({ x: Schema.Number, y: Schema.Number }),
);

const reply =
  (value: Schema.Json): SendCommand =>
  () =>
    Effect.succeed(value);

const evaluate = (send: SendCommand) => evaluateWithDebugger("tab", send, "true", true);

describe("debugger evaluation decoding", () => {
  it.effect("preserves arbitrary evaluation values without claiming their type", () =>
    Effect.gen(function* () {
      const value = { nested: [true, "text"] };
      expect(yield* evaluate(reply({ result: { type: "object", value } }))).toEqual(value);
    }),
  );

  for (const value of [
    null,
    {},
    { result: null },
    { result: { type: 123 } },
    { exceptionDetails: "invalid" },
  ]) {
    it.effect(`rejects a malformed CDP envelope: ${JSON.stringify(value)}`, () =>
      Effect.gen(function* () {
        const error = yield* evaluate(reply(value)).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => expect.fail("Expected malformed CDP response to fail"),
          }),
        );

        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "automationEvaluate.decodeResult",
        });
      }),
    );
  }

  it.effect("accepts an undefined JavaScript result", () =>
    Effect.gen(function* () {
      expect(yield* evaluate(reply({ result: { type: "undefined" } }))).toBeUndefined();
    }),
  );

  it.effect("rejects a string returned for an injected boolean expression", () =>
    Effect.gen(function* () {
      const error = yield* evaluate(reply({ result: { value: "wrong type" } })).pipe(
        Effect.flatMap(decodeEvaluationValue("tab", decodeBoolean)),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "PreviewOperationError" });
    }),
  );

  it.effect("rejects incomplete objects before typed callers access their properties", () =>
    Effect.gen(function* () {
      const error = yield* evaluate(reply({ result: { value: {} } })).pipe(
        Effect.flatMap(decodeEvaluationValue("tab", decodePoint)),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "PreviewOperationError" });
    }),
  );

  it.effect("decodes a valid injected result", () =>
    Effect.gen(function* () {
      const value = yield* evaluate(reply({ result: { value: { x: 3, y: 5 } } })).pipe(
        Effect.flatMap(decodeEvaluationValue("tab", decodePoint)),
      );

      expect(value).toEqual({ x: 3, y: 5 });
    }),
  );

  it.effect("preserves the evaluation error for page exceptions", () =>
    Effect.gen(function* () {
      const error = yield* evaluate(
        reply({
          result: { type: "object" },
          exceptionDetails: { text: "Uncaught", exception: { description: "Page failure" } },
        }),
      ).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => expect.fail("Expected page exception to fail"),
        }),
      );

      expect(error).toMatchObject({
        _tag: "PreviewAutomationEvaluationError",
        detailKind: "exception-description",
      });
    }),
  );
});
