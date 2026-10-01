import * as Match from "effect/Match";
import type { PreviewAutomationRequest } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import {
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewTabId,
  type PreviewAutomationError,
  type PreviewAutomationResponse,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { type PreviewAutomationRequestErrorContext } from "./PreviewAutomationState.ts";

export const selectorDiagnosticsFromInput = (
  input: PreviewAutomationRequest["input"],
): Pick<PreviewAutomationRequestErrorContext, "selectorKind" | "selectorLength"> => {
  if (!Predicate.isObjectOrArray(input)) return {};

  if ("locator" in input && Predicate.isString(input.locator)) {
    return { selectorKind: "locator", selectorLength: input.locator.length };
  }

  if ("selector" in input && Predicate.isString(input.selector)) {
    return { selectorKind: "selector", selectorLength: input.selector.length };
  }

  return {};
};

export const isPreviewTabId = Schema.is(PreviewTabId);

export const readResultTabId = (
  result: PreviewAutomationResponse["result"],
): PreviewTabId | null | undefined => {
  if (!Predicate.isObjectOrArray(result) || !("tabId" in result)) return undefined;
  const tabId = result.tabId;

  return tabId === null || isPreviewTabId(tabId) ? tabId : undefined;
};

export type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

export function remoteDetailKind(
  detail: NonNullable<PreviewAutomationResponse["error"]>["detail"],
): RemoteDetailKind {
  if (detail === null) return "null";

  if (Array.isArray(detail)) return "array";

  if (Predicate.isString(detail)) return "string";

  if (Predicate.isNumber(detail)) return "number";

  if (Predicate.isBoolean(detail)) return "boolean";

  return "object";
}

export const classifyResponseError = (
  context: PreviewAutomationRequestErrorContext,
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  const remoteDiagnostics = {
    remoteTag: error._tag,
    remoteMessageLength: error.message.length,
    ...(error.detail === undefined ? {} : { remoteDetailKind: remoteDetailKind(error.detail) }),
    cause: error,
  };

  return Match.value(error._tag).pipe(
    Match.when("PreviewAutomationNoAvailableHostError", (): PreviewAutomationError => {
      return new PreviewAutomationNoAvailableHostError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
    Match.when("PreviewAutomationUnsupportedClientError", (): PreviewAutomationError => {
      return new PreviewAutomationUnsupportedClientError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
    Match.when("PreviewAutomationTabNotFoundError", (): PreviewAutomationError => {
      return new PreviewAutomationTabNotFoundError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
    Match.when("PreviewAutomationTimeoutError", (): PreviewAutomationError => {
      return new PreviewAutomationTimeoutError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
    Match.when("PreviewAutomationControlInterruptedError", (): PreviewAutomationError => {
      return new PreviewAutomationControlInterruptedError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
    Match.when("PreviewAutomationInvalidSelectorError", (): PreviewAutomationError => {
      {
        return new PreviewAutomationInvalidSelectorError({
          ...context,
          ...remoteDiagnostics,
        });
      }
    }),
    Match.when("PreviewAutomationTargetNotEditableError", (): PreviewAutomationError => {
      {
        const detail = Predicate.isObjectOrArray(error.detail) ? error.detail : undefined;

        const remoteSelectorKind =
          detail &&
          "selectorKind" in detail &&
          (detail.selectorKind === "focused-element" ||
            detail.selectorKind === "locator" ||
            detail.selectorKind === "selector")
            ? detail.selectorKind
            : undefined;

        const remoteSelectorLength =
          detail &&
          "selectorLength" in detail &&
          Predicate.isNumber(detail.selectorLength) &&
          Number.isInteger(detail.selectorLength) &&
          detail.selectorLength >= 0
            ? detail.selectorLength
            : undefined;

        return new PreviewAutomationTargetNotEditableError({
          ...context,
          ...remoteDiagnostics,
          ...(remoteSelectorKind === undefined && context.selectorKind === undefined
            ? {}
            : { selectorKind: remoteSelectorKind ?? context.selectorKind }),
          ...(remoteSelectorLength === undefined && context.selectorLength === undefined
            ? {}
            : { selectorLength: remoteSelectorLength ?? context.selectorLength }),
        });
      }
    }),
    Match.when("PreviewAutomationResultTooLargeError", (): PreviewAutomationError => {
      {
        const detail = Predicate.isObjectOrArray(error.detail) ? error.detail : undefined;

        const maximumBytes =
          detail &&
          "maximumBytes" in detail &&
          Predicate.isNumber(detail.maximumBytes) &&
          Number.isInteger(detail.maximumBytes) &&
          detail.maximumBytes > 0
            ? detail.maximumBytes
            : undefined;

        return new PreviewAutomationResultTooLargeError({
          ...context,
          ...remoteDiagnostics,
          ...(maximumBytes === undefined ? {} : { maximumBytes }),
        });
      }
    }),
    Match.when("PreviewAutomationUnavailableError", (): PreviewAutomationError => {
      return new PreviewAutomationRemoteUnavailableError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
    Match.orElse((): PreviewAutomationError => {
      return new PreviewAutomationExecutionError({
        ...context,
        ...remoteDiagnostics,
      });
    }),
  );
};
