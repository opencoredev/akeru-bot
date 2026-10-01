import { decodeEvaluationValue } from "./PreviewEvaluation.ts";
import * as Schema from "effect/Schema";
import type {
  DesktopPreviewPointerEvent,
  PreviewAutomationClickInput,
  PreviewAutomationPressInput,
  PreviewAutomationTypeInput,
} from "@akeru/contracts";

import { webContents } from "electron";

import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { previewAutomationKeySequence } from "./PreviewKeyboard.ts";

import {
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
} from "./PreviewErrors.ts";
import type { createPreviewAutomationSnapshot } from "./PreviewAutomationSnapshot.ts";
import type { createPreviewBrowserControl } from "./PreviewBrowserControl.ts";
import type { createPreviewState } from "./PreviewState.ts";
import {
  AGENT_CURSOR_MOVE_MS,
  AGENT_CURSOR_CLICK_LEAD_MS,
  type PointerEventListener,
  type SendCommand,
} from "./PreviewModel.ts";

const decodeClickPoint = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ x: Schema.Number, y: Schema.Number }),
    Schema.Struct({ invalidSelector: Schema.Literal(true), message: Schema.String }),
    Schema.Struct({ notFound: Schema.Literal(true) }),
  ]),
);

const decodeViewport = Schema.decodeUnknownEffect(
  Schema.Struct({ width: Schema.Number, height: Schema.Number }),
);

const decodeTypeResult = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({ invalidSelector: Schema.Literal(true), message: Schema.String }),
    Schema.Struct({ notEditable: Schema.Literal(true) }),
    Schema.Struct({ notFound: Schema.Literal(true) }),
  ]),
);

export const createPreviewAutomationInput = ({
  automationLocator,
  ensurePlaywrightInjected,
  encodeJson,
  evaluateWithDebugger,
  automationSelectorDiagnostics,
  pointerEventListenersRef,
  deliverEvent,
  prepareAutomationInput,
  nextCounter,
  pointerSequenceRef,
  currentIso,
  expectAgentInput,
  requireWebContents,
  withControlSession,
  hostPlatform,
  attempt,
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
  readonly pointerEventListenersRef: Ref.Ref<ReadonlySet<PointerEventListener>>;
  readonly deliverEvent: ReturnType<typeof createPreviewState>["deliverEvent"];
  readonly prepareAutomationInput: ReturnType<
    typeof createPreviewBrowserControl
  >["prepareAutomationInput"];
  readonly nextCounter: ReturnType<typeof createPreviewState>["nextCounter"];
  readonly pointerSequenceRef: Ref.Ref<number>;
  readonly currentIso: ReturnType<typeof createPreviewState>["currentIso"];
  readonly expectAgentInput: ReturnType<typeof createPreviewBrowserControl>["expectAgentInput"];
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly withControlSession: ReturnType<typeof createPreviewBrowserControl>["withControlSession"];
  readonly hostPlatform: NodeJS.Platform;
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
}) => {
  const resolveClickPoint = Effect.fn("PreviewManager.resolveClickPoint")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationClickInput,
  ) {
    if (!("selector" in input) && !("locator" in input)) {
      return { x: input.x!, y: input.y! };
    }

    const locator = automationLocator(input)!;
    yield* ensurePlaywrightInjected(tabId, send);

    const locatorJson = yield* encodeJson(
      { operation: "automationClick.encodeLocator", tabId },
      locator,
    );

    const point = yield* evaluateWithDebugger(
      tabId,
      send,
      `(() => {
          try {
            const injected = globalThis.__t3PlaywrightInjected;
            const parsed = injected.parseSelector(${locatorJson});
            const element = injected.querySelector(parsed, document, true);
            if (!element) return { notFound: true };
            const visible = injected.elementState(element, "visible");
            const enabled = injected.elementState(element, "enabled");
            if (!visible.matches || !enabled.matches) return { notFound: true };
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    ).pipe(Effect.flatMap(decodeEvaluationValue(tabId, decodeClickPoint)));

    if ("invalidSelector" in point) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: point.message.length,
        cause: point,
      });
    }

    if ("notFound" in point) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }

    return point;
  });

  const emitPointerEvent = Effect.fn("PreviewManager.emitPointerEvent")(function* (
    event: DesktopPreviewPointerEvent,
  ) {
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("pointer-event", event.tabId, () => listener(event)),
      { discard: true },
    );
  });

  const performAutomationClick = Effect.fn("PreviewManager.performAutomationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
    send: SendCommand,
  ) {
    yield* prepareAutomationInput(send, true);
    const point = yield* resolveClickPoint(tabId, send, input);

    const viewport = yield* evaluateWithDebugger(
      tabId,
      send,
      "({ width: window.innerWidth, height: window.innerHeight })",
      true,
    ).pipe(Effect.flatMap(decodeEvaluationValue(tabId, decodeViewport)));

    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      return yield* new PreviewAutomationCoordinatesOutsideViewportError({
        tabId,
        x: point.x,
        y: point.y,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    }

    const moveSequence = yield* nextCounter(pointerSequenceRef);
    const moveCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "move",
      ...point,
      sequence: moveSequence,
      createdAt: moveCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_MOVE_MS);
    const clickSequence = yield* nextCounter(pointerSequenceRef);
    const clickCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "click",
      ...point,
      sequence: clickSequence,
      createdAt: clickCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_CLICK_LEAD_MS);
    yield* expectAgentInput(tabId, { kind: "pointer", ...point, button: 0 });
    yield* send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    yield* send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  });

  const automationClick = Effect.fn("PreviewManager.automationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "click", (send) =>
      performAutomationClick(tabId, input, send),
    );
  });

  const typeIntoAutomationTarget = Effect.fn("PreviewManager.typeIntoAutomationTarget")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationTypeInput,
  ) {
    const locator = automationLocator(input);

    if (locator) yield* ensurePlaywrightInjected(tabId, send);

    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationType.encodeLocator", tabId }, locator)
      : null;

    const textJson = yield* encodeJson(
      { operation: "automationType.encodeText", tabId },
      input.text,
    );

    const result = yield* evaluateWithDebugger(
      tabId,
      send,
      `(() => {
          try {
            const element = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "document.activeElement"};
            if (!element) return { notFound: true };
            const textControl =
              element instanceof HTMLTextAreaElement ||
              (element instanceof HTMLInputElement &&
                !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(element.type));
            const editable = textControl || element.isContentEditable;
            if (!editable || element.disabled || element.readOnly) return { notEditable: true };
            element.focus();
            if (document.activeElement !== element) return { notEditable: true };
            const clear = ${input.clear ?? false};
            if (clear) {
              if (textControl) {
                element.select();
              } else {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
              }
            }
            const text = ${textJson};
            let inserted = true;
            if (text.length > 0) {
              inserted = document.execCommand("insertText", false, text);
            } else if (clear) {
              document.execCommand("delete", false);
              const cleared = textControl
                ? element.value.length === 0
                : (element.textContent ?? "").length === 0;
              if (!cleared) {
                if (textControl) {
                  const prototype = element instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                  if (valueSetter) valueSetter.call(element, "");
                  else element.value = "";
                } else {
                  element.replaceChildren();
                }
                element.dispatchEvent(new InputEvent("input", {
                  bubbles: true,
                  inputType: "deleteContentBackward",
                }));
              }
            }
            if (!inserted) return { notEditable: true };
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    ).pipe(Effect.flatMap(decodeEvaluationValue(tabId, decodeTypeResult)));

    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }

    if ("notFound" in result) {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }

    if ("notEditable" in result) {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
  });

  const performAutomationType = Effect.fn("PreviewManager.performAutomationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
    send: SendCommand,
  ) {
    // CDP Input.insertText silently drops text until Electron has activated a hidden
    // guest WebContents with a pointer event. Editing in the page runtime keeps
    // background automation deterministic without stealing foreground app focus.
    yield* typeIntoAutomationTarget(tabId, send, input);
  });

  const automationType = Effect.fn("PreviewManager.automationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "type", (send) =>
      performAutomationType(tabId, input, send),
    );
  });

  const performAutomationPress = Effect.fn("PreviewManager.performAutomationPress")(function* (
    tabId: string,
    wc: Electron.WebContents,
    input: PreviewAutomationPressInput,
    send: SendCommand,
    sendCleanup: SendCommand,
  ) {
    yield* prepareAutomationInput(send, false);

    const keySequence = previewAutomationKeySequence(input, {
      isMac: hostPlatform === "darwin",
    });

    const previouslyFocused = yield* attempt(
      { operation: "automationPress.getFocusedWebContents", tabId, webContentsId: wc.id },
      () => webContents.getFocusedWebContents(),
    );

    let keyDownAttempted = false;

    const releaseInput = Effect.gen(function* () {
      if (keyDownAttempted) {
        yield* sendCleanup("Input.dispatchKeyEvent", keySequence.keyUp).pipe(Effect.ignore);
      }

      yield* sendCleanup("Emulation.setFocusEmulationEnabled", { enabled: false }).pipe(
        Effect.ignore,
      );

      if (previouslyFocused && previouslyFocused.id !== wc.id && !previouslyFocused.isDestroyed()) {
        yield* attempt(
          {
            operation: "automationPress.restoreFocusedWebContents",
            tabId,
            webContentsId: previouslyFocused.id,
          },
          () => previouslyFocused.focus(),
        ).pipe(Effect.ignore);
      }
    });

    // Focus the guest WebContents itself, not its containing BrowserWindow. This
    // activates native keyboard behavior for hidden/background previews without
    // changing which thread is mounted in the UI. Restore the previous renderer
    // after dispatch so automation never leaves the app's input focus behind.
    yield* Effect.gen(function* () {
      yield* attempt(
        { operation: "automationPress.focusWebContents", tabId, webContentsId: wc.id },
        () => wc.focus(),
      );
      yield* send("Page.bringToFront");
      yield* send("Emulation.setFocusEmulationEnabled", { enabled: true });
      yield* expectAgentInput(tabId, keySequence.signal);
      keyDownAttempted = true;
      yield* send("Input.dispatchKeyEvent", keySequence.keyDown);
    }).pipe(Effect.ensuring(releaseInput));
  });

  const automationPress = Effect.fn("PreviewManager.automationPress")(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "press", (send, sendCleanup) =>
      performAutomationPress(tabId, wc, input, send, sendCleanup),
    );
  });

  return { automationClick, automationType, automationPress };
};
