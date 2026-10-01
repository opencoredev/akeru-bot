import * as Effect from "effect/Effect";
import {
  previewAutomationEvaluationDetail,
  PreviewAutomationEvaluationError,
  type PreviewManagerError,
} from "./PreviewErrors.ts";
import type { CdpEvaluationResult, SendCommand } from "./PreviewModel.ts";

export const evaluateWithDebugger = <A = unknown>(
  tabId: string,
  send: SendCommand,
  expression: string,
  returnByValue: boolean,
  awaitPromise = true,
): Effect.Effect<A, PreviewManagerError> =>
  send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  }).pipe(
    Effect.flatMap((rawResponse) => {
      // SAFETY: Runtime.evaluate uses the CDP evaluation envelope; the caller owns the type of its injected expression.
      const response = rawResponse as CdpEvaluationResult;

      if (!response.exceptionDetails) {
        // SAFETY: Every typed caller supplies the injected expression that produces A; arbitrary evaluations use the unknown default.
        return Effect.succeed(response.result?.value as A);
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
