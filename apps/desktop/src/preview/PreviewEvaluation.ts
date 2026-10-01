import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  previewAutomationEvaluationDetail,
  PreviewAutomationEvaluationError,
  PreviewOperationError,
  type PreviewManagerError,
} from "./PreviewErrors.ts";
import type { SendCommand } from "./PreviewModel.ts";

const decodeEvaluationEnvelope = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({
      result: Schema.Struct({
        type: Schema.optional(Schema.String),
        value: Schema.optional(Schema.Unknown),
        description: Schema.optional(Schema.String),
      }),
      exceptionDetails: Schema.optional(
        Schema.Struct({
          text: Schema.optional(Schema.String),
          exception: Schema.optional(
            Schema.Struct({ description: Schema.optional(Schema.String) }),
          ),
        }),
      ),
    }),
    Schema.Struct({
      result: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          value: Schema.optional(Schema.Unknown),
        }),
      ),
      exceptionDetails: Schema.Struct({
        text: Schema.optional(Schema.String),
        exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })),
      }),
    }),
  ]),
);

export const decodeEvaluationValue =
  <A>(tabId: string, decode: ReturnType<typeof Schema.decodeUnknownEffect<Schema.Codec<A>>>) =>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CDP evaluation values are arbitrary JavaScript values; the supplied decoder validates typed expressions.
  (value: unknown) =>
    decode(value).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({ operation: "automationEvaluate.decodeResult", tabId, cause }),
      ),
    );

export const evaluateWithDebugger = (
  tabId: string,
  send: SendCommand,
  expression: string,
  returnByValue: boolean,
  awaitPromise = true,
): Effect.Effect<unknown, PreviewManagerError> =>
  send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  }).pipe(
    Effect.flatMap(decodeEvaluationValue(tabId, decodeEvaluationEnvelope)),
    Effect.flatMap((response) => {
      if (!response.exceptionDetails) {
        return Effect.succeed(response.result?.value);
      }

      const detail = previewAutomationEvaluationDetail(response.exceptionDetails);

      return Effect.fail(
        new PreviewAutomationEvaluationError({
          tabId,
          detailKind: detail.detailKind,
          detailLength: detail.detail?.length ?? 0,
          cause: response.exceptionDetails,
        }),
      );
    }),
  );
