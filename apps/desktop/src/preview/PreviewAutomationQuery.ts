import type {
  PreviewAutomationEvaluateInput,
  PreviewAutomationScrollInput,
  PreviewAutomationWaitForInput,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import {
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTimeoutError,
} from "./PreviewErrors.ts";
import type { createPreviewAutomationSnapshot } from "./PreviewAutomationSnapshot.ts";
import type { createPreviewBrowserControl } from "./PreviewBrowserControl.ts";
import type { createPreviewState } from "./PreviewState.ts";
import { MAX_EVALUATION_BYTES, type SendCommand } from "./PreviewModel.ts";

export const createPreviewAutomationQuery = ({
  automationLocator,
  ensurePlaywrightInjected,
  encodeJson,
  evaluateWithDebugger,
  automationSelectorDiagnostics,
  requireWebContents,
  withControlSession,
  currentMillis,
}: {
  readonly automationLocator: ReturnType<
    typeof createPreviewAutomationSnapshot
  >["automationLocator"];
  readonly ensurePlaywrightInjected: ReturnType<
    typeof createPreviewBrowserControl
  >["ensurePlaywrightInjected"];
  readonly encodeJson: ReturnType<typeof createPreviewState>["encodeJson"];
  readonly evaluateWithDebugger: ReturnType<
    typeof createPreviewBrowserControl
  >["evaluateWithDebugger"];
  readonly automationSelectorDiagnostics: ReturnType<
    typeof createPreviewAutomationSnapshot
  >["automationSelectorDiagnostics"];
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly withControlSession: ReturnType<typeof createPreviewBrowserControl>["withControlSession"];
  readonly currentMillis: ReturnType<typeof createPreviewState>["currentMillis"];
}) => {
  const performAutomationScroll = Effect.fn("PreviewManager.performAutomationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
    send: SendCommand,
  ) {
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationScroll.encodeLocator", tabId }, locator)
      : null;
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
        try {
          const target = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "window"};
          if (!target) return { notFound: true };
          target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
      true,
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
  });

  const automationScroll = Effect.fn("PreviewManager.automationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "scroll", (send) =>
      performAutomationScroll(tabId, input, send),
    );
  });

  const performAutomationEvaluate = Effect.fn("PreviewManager.performAutomationEvaluate")(
    function* (tabId: string, input: PreviewAutomationEvaluateInput, send: SendCommand) {
      yield* send("Runtime.enable");
      const value = yield* evaluateWithDebugger(
        tabId,
        send,
        input.expression,
        input.returnByValue ?? true,
        input.awaitPromise ?? true,
      );
      const serialized = yield* encodeJson(
        { operation: "automationEvaluate.encodeResult", tabId },
        value,
      );
      const actualBytes = Buffer.byteLength(serialized, "utf8");
      if (actualBytes > MAX_EVALUATION_BYTES) {
        return yield* new PreviewAutomationResultTooLargeError({
          tabId,
          actualBytes,
          maximumBytes: MAX_EVALUATION_BYTES,
        });
      }
      return value;
    },
  );

  const automationEvaluate = Effect.fn("PreviewManager.automationEvaluate")(function* (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "evaluate", (send) =>
      performAutomationEvaluate(tabId, input, send),
    );
  });

  const performAutomationWaitFor = Effect.fn("PreviewManager.performAutomationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
    send: SendCommand,
  ) {
    const timeoutMs = input.timeoutMs ?? 15_000;
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const [locatorJson, textJson, urlIncludesJson] = yield* Effect.all([
      locator
        ? encodeJson({ operation: "automationWaitFor.encodeLocator", tabId }, locator)
        : Effect.succeed(null),
      input.text
        ? encodeJson({ operation: "automationWaitFor.encodeText", tabId }, input.text)
        : Effect.succeed(null),
      input.urlIncludes
        ? encodeJson({ operation: "automationWaitFor.encodeUrl", tabId }, input.urlIncludes)
        : Effect.succeed(null),
    ]);
    const deadline = (yield* currentMillis) + timeoutMs;
    while ((yield* currentMillis) <= deadline) {
      const result = yield* evaluateWithDebugger<
        { matched: boolean } | { invalidSelector: true; message: string }
      >(
        tabId,
        send,
        `(() => {
              try {
                const selectorMatched = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, false) !== null; })()` : "true"};
                const textMatched = ${
                  textJson ? `(document.body?.innerText || "").includes(${textJson})` : "true"
                };
                const urlMatched = ${
                  urlIncludesJson ? `location.href.includes(${urlIncludesJson})` : "true"
                };
                return { matched: selectorMatched && textMatched && urlMatched };
              } catch (error) {
                return { invalidSelector: true, message: String(error) };
              }
            })()`,
        true,
      );
      if ("invalidSelector" in result) {
        return yield* new PreviewAutomationInvalidSelectorError({
          operation: "waitFor",
          tabId,
          ...automationSelectorDiagnostics(input),
          reasonLength: result.message.length,
          cause: result,
        });
      }
      if (result.matched) return;
      yield* Effect.sleep(100);
    }
    return yield* new PreviewAutomationTimeoutError({
      tabId,
      timeoutMs,
    });
  });

  const automationWaitFor = Effect.fn("PreviewManager.automationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "waitFor", (send) =>
      performAutomationWaitFor(tabId, input, send),
    );
  });
  return { automationScroll, automationEvaluate, automationWaitFor };
};
