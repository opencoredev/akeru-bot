import type {
  DesktopPreviewColorScheme,
  DesktopPreviewRecordingFrame,
  PreviewAutomationActionEvent,
} from "@akeru/contracts";

import { webContents } from "electron";
import * as Cause from "effect/Cause";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { type playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";

import {
  previewAutomationEvaluationDetail,
  PreviewOperationError,
  isPreviewOperationError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationEvaluationError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationControlInterruptedError,
  type PreviewManagerError,
  isPreviewAutomationControlInterruptedError,
  isPreviewAutomationEvaluationError,
  isPreviewAutomationInvalidSelectorError,
} from "./PreviewErrors.ts";
import type { makePreviewState } from "./PreviewState.ts";
import {
  type PreviewTabState,
  DIAGNOSTIC_BUFFER_LIMIT,
  type CdpEvaluationResult,
  type RecordingFrameListener,
  type PreviewInputSignal,
  type FrameCaptureSession,
  type BrowserControlSession,
  type BrowserDiagnostics,
  type ExpectedAgentInput,
  inputSignalsMatch,
  type SendCommand,
} from "./PreviewModel.ts";

export const makePreviewBrowserControl = ({
  currentIso,
  diagnosticsRef,
  replaceMap,
  controlSessionsRef,
  parentScope,
  attemptPromise,
  tabIdForWebContents,
  frameCaptureSessionsRef,
  recordingFrameListenersRef,
  deliverEvent,
  runFork,
  attempt,
  actionTimelineRef,
  nextCounter,
  actionSequenceRef,
  currentMillis,
  controlEpochRef,
  update,
  tabsRef,
  playwrightInstallExpression,
  expectedAgentInputsRef,
}: {
  readonly currentIso: ReturnType<typeof makePreviewState>["currentIso"];
  readonly diagnosticsRef: Ref.Ref<ReadonlyMap<number, BrowserDiagnostics>>;
  readonly replaceMap: ReturnType<typeof makePreviewState>["replaceMap"];
  readonly controlSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<number, BrowserControlSession>
  >;
  readonly parentScope: Scope.Scope;
  readonly attemptPromise: ReturnType<typeof makePreviewState>["attemptPromise"];
  readonly tabIdForWebContents: ReturnType<typeof makePreviewState>["tabIdForWebContents"];
  readonly frameCaptureSessionsRef: SynchronizedRef.SynchronizedRef<
    ReadonlyMap<string, FrameCaptureSession>
  >;
  readonly recordingFrameListenersRef: Ref.Ref<ReadonlySet<RecordingFrameListener>>;
  readonly deliverEvent: ReturnType<typeof makePreviewState>["deliverEvent"];
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions | undefined,
  ) => Fiber.Fiber<A, E>;
  readonly attempt: ReturnType<typeof makePreviewState>["attempt"];
  readonly actionTimelineRef: Ref.Ref<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >;
  readonly nextCounter: ReturnType<typeof makePreviewState>["nextCounter"];
  readonly actionSequenceRef: Ref.Ref<number>;
  readonly currentMillis: ReturnType<typeof makePreviewState>["currentMillis"];
  readonly controlEpochRef: Ref.Ref<ReadonlyMap<string, number>>;
  readonly update: ReturnType<typeof makePreviewState>["update"];
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabState>>;
  readonly playwrightInstallExpression: ReturnType<
    typeof playwrightInjectedRuntimeInstallExpression
  >;
  readonly expectedAgentInputsRef: Ref.Ref<ReadonlyMap<string, readonly ExpectedAgentInput[]>>;
}) => {
  const pushBounded = <A>(buffer: ReadonlyArray<A>, entry: A): ReadonlyArray<A> =>
    [...buffer, entry].slice(-DIAGNOSTIC_BUFFER_LIMIT);

  const captureDiagnosticMessage = Effect.fnUntraced(function* (
    webContentsId: number,
    method: string,
    params: Record<string, unknown>,
  ) {
    const timestamp = yield* currentIso;
    yield* Ref.update(diagnosticsRef, (allDiagnostics) => {
      const current = allDiagnostics.get(webContentsId);
      if (!current) return allDiagnostics;
      const requestId = typeof params["requestId"] === "string" ? params["requestId"] : null;
      const next = (() => {
        if (method === "Runtime.consoleAPICalled") {
          const args = Array.isArray(params["args"]) ? params["args"] : [];
          const text = args
            .map((arg) => {
              if (typeof arg !== "object" || arg === null) return String(arg);
              const value = arg as Record<string, unknown>;
              return String(value["value"] ?? value["description"] ?? "");
            })
            .join(" ");
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof params["type"] === "string" ? params["type"] : "log",
              text,
              timestamp,
              source: "console",
            }),
          };
        }
        if (method === "Runtime.exceptionThrown") {
          const details =
            typeof params["exceptionDetails"] === "object" && params["exceptionDetails"] !== null
              ? (params["exceptionDetails"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: "error",
              text: String(details["text"] ?? "Uncaught exception"),
              timestamp,
              source: "exception",
            }),
          };
        }
        if (method === "Log.entryAdded") {
          const entry =
            typeof params["entry"] === "object" && params["entry"] !== null
              ? (params["entry"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof entry["level"] === "string" ? entry["level"] : "info",
              text: String(entry["text"] ?? ""),
              timestamp,
              source: typeof entry["source"] === "string" ? entry["source"] : "log",
            }),
          };
        }
        if (method === "Network.requestWillBeSent" && requestId) {
          const request =
            typeof params["request"] === "object" && params["request"] !== null
              ? (params["request"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.set(requestId, {
                url: String(request["url"] ?? ""),
                method: String(request["method"] ?? "GET"),
              });
            }),
          };
        }
        if (method === "Network.responseReceived" && requestId) {
          const request = current.requests.get(requestId);
          const response =
            typeof params["response"] === "object" && params["response"] !== null
              ? (params["response"] as Record<string, unknown>)
              : {};
          const status = typeof response["status"] === "number" ? response["status"] : null;
          return request && status !== null && status >= 400
            ? {
                ...current,
                networkEntries: pushBounded(current.networkEntries, {
                  ...request,
                  status,
                  failed: true,
                  timestamp,
                }),
              }
            : current;
        }
        if (method === "Network.loadingFailed" && requestId) {
          const request = current.requests.get(requestId);
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
            networkEntries: request
              ? pushBounded(current.networkEntries, {
                  ...request,
                  status: null,
                  failed: true,
                  errorText: String(params["errorText"] ?? "Network request failed"),
                  timestamp,
                })
              : current.networkEntries,
          };
        }
        if (method === "Network.loadingFinished" && requestId) {
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
          };
        }
        return current;
      })();
      return replaceMap(allDiagnostics, (copy) => {
        copy.set(webContentsId, next);
      });
    });
  });

  const detachControlSession = Effect.fn("PreviewManager.detachControlSession")(function* (
    webContentsId: number,
  ) {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (control) {
      yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
      return;
    }
    yield* Ref.update(diagnosticsRef, (diagnostics) =>
      replaceMap(diagnostics, (copy) => {
        copy.delete(webContentsId);
      }),
    );
  });

  const ensureControlSession = Effect.fn("PreviewManager.ensureControlSession")(function* (
    wc: Electron.WebContents,
  ) {
    return yield* SynchronizedRef.modifyEffect(
      controlSessionsRef,
      (
        sessions,
      ): Effect.Effect<
        readonly [BrowserControlSession, ReadonlyMap<number, BrowserControlSession>],
        PreviewManagerError
      > => {
        const existing = sessions.get(wc.id);
        if (existing) return Effect.succeed([existing, sessions] as const);
        if (wc.isDevToolsOpened()) {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          );
        }
        if (wc.debugger.isAttached()) {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          );
        }
        const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
          const semaphore = yield* Semaphore.make(1);
          const scope = yield* Scope.fork(parentScope, "sequential");
          const wcDebugger = wc.debugger;
          const handleDebuggerMessage = Effect.fnUntraced(function* (
            method: string,
            params: Record<string, unknown>,
          ) {
            if (method === "Page.screencastFrame") {
              const sessionId = params["sessionId"];
              if (typeof sessionId === "number") {
                yield* attemptPromise(
                  {
                    operation: "ackScreencastFrame",
                    webContentsId: wc.id,
                  },
                  () => wcDebugger.sendCommand("Page.screencastFrameAck", { sessionId }),
                ).pipe(Effect.ignore);
              }
              const tabId = yield* tabIdForWebContents(wc.id);
              const metadata =
                typeof params["metadata"] === "object" && params["metadata"] !== null
                  ? (params["metadata"] as Record<string, unknown>)
                  : {};
              if (tabId && typeof params["data"] === "string") {
                const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(
                  tabId,
                );
                if (captureSession?.consumers.has("recording")) {
                  const receivedAt = yield* currentIso;
                  const listeners = yield* Ref.get(recordingFrameListenersRef);
                  const frame: DesktopPreviewRecordingFrame = {
                    tabId,
                    data: params["data"],
                    width:
                      typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
                    height:
                      typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
                    receivedAt,
                  };
                  yield* Effect.forEach(
                    listeners,
                    (listener) =>
                      deliverEvent("recording-frame", frame.tabId, () => listener(frame)),
                    { discard: true },
                  );
                }
              }
            }
            yield* captureDiagnosticMessage(wc.id, method, params);
          });
          const onMessage: BrowserControlSession["onMessage"] = (_event, method, params) => {
            runFork(handleDebuggerMessage(method, params));
          };
          yield* Scope.addFinalizer(
            scope,
            Effect.all(
              [
                Ref.update(diagnosticsRef, (diagnostics) =>
                  replaceMap(diagnostics, (copy) => {
                    copy.delete(wc.id);
                  }),
                ),
                attempt({ operation: "detachControlSession", webContentsId: wc.id }, () => {
                  wcDebugger.off("message", onMessage);
                  if (wcDebugger.isAttached()) wcDebugger.detach();
                }).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          );
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            debugger: wcDebugger,
            semaphore,
            scope,
            onMessage,
          };
          const initialize = Effect.fn("PreviewManager.initializeControlSession")(function* () {
            yield* Ref.update(diagnosticsRef, (diagnostics) =>
              replaceMap(diagnostics, (copy) => {
                copy.set(wc.id, {
                  consoleEntries: [],
                  networkEntries: [],
                  requests: new Map(),
                });
              }),
            );
            yield* attempt({ operation: "attachDebuggerListeners", webContentsId: wc.id }, () => {
              wcDebugger.on("message", onMessage);
              wcDebugger.attach("1.3");
            });
            yield* Effect.all(
              ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"].map(
                (method) =>
                  attemptPromise(
                    { operation: `initializeDebugger.${method}`, webContentsId: wc.id },
                    () => wcDebugger.sendCommand(method),
                  ),
              ),
              { concurrency: "unbounded", discard: true },
            );
            return [
              control,
              replaceMap(sessions, (copy) => {
                copy.set(wc.id, control);
              }),
            ] as const;
          });
          return yield* initialize().pipe(
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          );
        });
        return createControlSession();
      },
    );
  });

  const pushAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) =>
      replaceMap(timelines, (copy) => {
        copy.set(tabId, [...(timelines.get(tabId) ?? []), event].slice(-200));
      }),
    );

  const replaceAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) => {
      const timeline = timelines.get(tabId);
      if (!timeline) return timelines;
      return replaceMap(timelines, (copy) => {
        copy.set(
          tabId,
          timeline.map((candidate) => (candidate.id === event.id ? event : candidate)),
        );
      });
    });

  const prepareAutomationInput = Effect.fn("PreviewManager.prepareAutomationInput")(function* (
    send: SendCommand,
    enableRuntime: boolean,
  ) {
    yield* Effect.all(
      [
        ...(enableRuntime ? [send("Runtime.enable")] : []),
        send("Input.setIgnoreInputEvents", { ignore: false }),
      ],
      { concurrency: 2, discard: true },
    );
  });

  const withControlSession = Effect.fn("PreviewManager.withControlSession")(function* <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand, sendCleanup: SendCommand) => Effect.Effect<A, PreviewManagerError>,
  ) {
    const sequence = yield* nextCounter(actionSequenceRef);
    const startedAt = yield* currentIso;
    const millis = yield* currentMillis;
    const actionEvent: PreviewAutomationActionEvent = {
      id: `browser-action-${millis.toString(36)}-${sequence.toString(36)}`,
      action,
      status: "running",
      startedAt,
    };
    yield* pushAction(tabId, actionEvent);
    const epoch = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
    const control = yield* ensureControlSession(wc);
    const execute = Effect.fn("PreviewManager.executeControlAction")(function* () {
      yield* update(tabId, { controller: "agent" });
      const send: SendCommand = Effect.fn("PreviewManager.sendCommand")(
        function* (method, commandParams) {
          const before = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
          if (before !== epoch) {
            return yield* new PreviewAutomationControlInterruptedError({
              operation: action,
              tabId,
              webContentsId: wc.id,
            });
          }
          const result = yield* attemptPromise(
            { operation: `${action}.${method}`, tabId, webContentsId: wc.id },
            () => control.debugger.sendCommand(method, commandParams),
          );
          const after = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
          if (after !== epoch) {
            return yield* new PreviewAutomationControlInterruptedError({
              operation: action,
              tabId,
              webContentsId: wc.id,
            });
          }
          return result;
        },
      );
      // Cleanup commands must still run after human input invalidates the action's
      // control epoch. Otherwise a partially dispatched input can leave Chromium
      // with a held key or focus emulation enabled for subsequent actions.
      const sendCleanup: SendCommand = Effect.fn("PreviewManager.sendCleanupCommand")(
        function* (method, commandParams) {
          return yield* attemptPromise(
            {
              operation: `${action}.cleanup.${method}`,
              tabId,
              webContentsId: wc.id,
            },
            () => control.debugger.sendCommand(method, commandParams),
          );
        },
      );
      return yield* use(send, sendCleanup);
    });
    const finalize = Effect.fn("PreviewManager.finalizeControlAction")(function* (
      exit: Exit.Exit<A, PreviewManagerError>,
    ) {
      const completedAt = yield* currentIso;
      if (exit._tag === "Success") {
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: "succeeded",
          completedAt,
        });
      } else {
        const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
        const interrupted = isPreviewAutomationControlInterruptedError(error);
        const errorMessage = isPreviewOperationError(error)
          ? PreviewOperationError.toTimelineMessage(error)
          : isPreviewAutomationEvaluationError(error)
            ? PreviewAutomationEvaluationError.toTimelineMessage(error)
            : isPreviewAutomationInvalidSelectorError(error)
              ? PreviewAutomationInvalidSelectorError.toTimelineMessage(error)
              : error instanceof Error
                ? error.message
                : String(error);
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: interrupted ? "interrupted" : "failed",
          completedAt,
          error: errorMessage,
        });
      }
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.has(tabId)) yield* update(tabId, { controller: "none" });
    });
    return yield* control.semaphore.withPermit(execute().pipe(Effect.onExit(finalize)));
  });

  const evaluateWithDebugger = <A = unknown>(
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
        const response = rawResponse as CdpEvaluationResult;
        if (!response.exceptionDetails) {
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

  const ensurePlaywrightInjected = Effect.fn("PreviewManager.ensurePlaywrightInjected")(function* (
    tabId: string,
    send: SendCommand,
  ) {
    const installed = yield* evaluateWithDebugger<boolean>(
      tabId,
      send,
      "Boolean(globalThis.__t3PlaywrightInjected)",
      true,
    );
    if (installed) return;
    const expression = yield* playwrightInstallExpression.pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "ensurePlaywrightInjected",
            tabId,
            cause,
          }),
      ),
    );
    yield* evaluateWithDebugger(tabId, send, expression, true);
  });

  const consumeExpectedAgentInput = Effect.fn("PreviewManager.consumeExpectedAgentInput")(
    function* (tabId: string, signal: PreviewInputSignal) {
      const now = yield* currentMillis;
      return yield* Ref.modify(expectedAgentInputsRef, (allExpected) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        const index = pending.findIndex((expected) => inputSignalsMatch(expected.signal, signal));
        const matched = index >= 0;
        const nextPending = matched
          ? pending.filter((_, pendingIndex) => pendingIndex !== index)
          : pending;
        return [
          matched,
          replaceMap(allExpected, (copy) => {
            if (nextPending.length === 0) copy.delete(tabId);
            else copy.set(tabId, nextPending);
          }),
        ] as const;
      });
    },
  );

  const expectAgentInput = Effect.fn("PreviewManager.expectAgentInput")(function* (
    tabId: string,
    signal: PreviewInputSignal,
  ) {
    const now = yield* currentMillis;
    yield* Ref.update(expectedAgentInputsRef, (allExpected) =>
      replaceMap(allExpected, (copy) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        copy.set(tabId, [...pending, { signal, expiresAt: now + 1_000 }]);
      }),
    );
  });

  // Emulated media lives on the CDP debugger session, not the WebContents, so
  // it is lost whenever the session detaches (webview swap, DevTools
  // open/close) and must be re-applied after every (re)attach.
  const applyColorScheme = Effect.fn("PreviewManager.applyColorScheme")(function* (
    tabId: string,
    wc: Electron.WebContents,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const control = yield* ensureControlSession(wc);
    yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
      control.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-color-scheme",
            // An empty value clears the override so the page follows the OS.
            value: colorScheme === "system" ? "" : colorScheme,
          },
        ],
      }),
    );
  });

  // Re-establish the control session after a detach, restoring any
  // color-scheme override the tab carries. The scheme is read after the
  // session attaches so a concurrent setColorScheme is not overwritten with
  // a stale snapshot.
  const restoreControlSession = (tabId: string, wc: Electron.WebContents) =>
    Effect.gen(function* () {
      const beforeAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (beforeAttach?.webContentsId !== wc.id) return;
      const control = yield* ensureControlSession(wc);
      const afterAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (afterAttach?.webContentsId !== wc.id) {
        yield* detachControlSession(wc.id);
        return;
      }
      if (afterAttach.colorScheme !== "system") {
        yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
          control.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [
              {
                name: "prefers-color-scheme",
                value: afterAttach.colorScheme,
              },
            ],
          }),
        );
      }
    }).pipe(Effect.ignore);

  const automationStatus = Effect.fn("PreviewManager.automationStatus")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) {
      const navStatus = tab?.navStatus;
      return {
        available: false,
        visible: true,
        tabId,
        url: !navStatus || navStatus.kind === "Idle" ? null : navStatus.url,
        title: !navStatus || navStatus.kind === "Idle" ? null : navStatus.title,
        loading: navStatus?.kind === "Loading",
      };
    }
    const wc = webContents.fromId(tab.webContentsId);
    return !wc || wc.isDestroyed()
      ? {
          available: false,
          visible: true,
          tabId,
          url: null,
          title: null,
          loading: false,
        }
      : {
          available: true,
          visible: true,
          tabId,
          url: wc.getURL() || null,
          title: wc.getTitle() || null,
          loading: wc.isLoading(),
        };
  });
  return {
    detachControlSession,
    prepareAutomationInput,
    withControlSession,
    evaluateWithDebugger,
    ensurePlaywrightInjected,
    consumeExpectedAgentInput,
    expectAgentInput,
    applyColorScheme,
    restoreControlSession,
    automationStatus,
  };
};
