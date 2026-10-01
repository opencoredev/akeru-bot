"use client";

import { Schema } from "effect";
import { isTagged } from "../tagged";

import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  PreviewAutomationWaitForInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationScrollInput,
  PreviewAutomationPressInput,
  PreviewAutomationTypeInput,
  PreviewAutomationClickInput,
  type EnvironmentId,
  type PreviewAutomationHost as PreviewAutomationHostState,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationStatus,
  type PreviewRenderedViewportSize,
  type ScopedThreadRef,
} from "@akeru/contracts";
import { resolvePreviewViewport } from "@akeru/shared/previewViewport";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { browserDefaultOpenViewport, resolveBrowserDefaults } from "~/browser/browserDefaults";
import {
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
} from "~/browser/browserRecording";
import { resolveBrowserRecordingStopTarget } from "~/browser/browserRecordingScope";
import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import { runBrowserViewportMutation } from "~/browser/browserViewportActions";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { isElectron } from "~/env";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import {
  PreviewAutomationOperationError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";
import {
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
} from "./previewAutomationOpenReadiness";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import {
  isPreviewWebviewRendering,
  readRenderedViewport,
  waitForDesktopOverlay,
  waitForRenderedViewport,
} from "./previewAutomationViewport";
import { previewBridge } from "./previewBridge";
import {
  assertPreviewRuntimeCurrent,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";
import { shouldRollbackPreviewViewport } from "./previewViewportRollback";

const currentStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, state.serverEpoch, tabId) : null;

  const visible = runtimeTabId
    ? (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false)
    : false;

  const renderingActive = runtimeTabId ? isPreviewWebviewRendering(runtimeTabId) : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;

  const viewport =
    runtimeTabId && renderingActive
      ? await readRenderedViewport(runtimeTabId).catch(() => null)
      : null;

  const viewportStatus = {
    ...(viewportSetting === undefined ? {} : { viewportSetting }),
    ...(viewport === null ? {} : { viewport }),
  };

  if (runtimeTabId && tabId && previewBridge && state.desktopByTabId[tabId]) {
    const status = await previewBridge.automation.status(runtimeTabId);

    return { ...status, tabId, visible, ...viewportStatus };
  }

  const navStatus = snapshot?.navStatus;

  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && !isTagged(navStatus, "Idle") ? navStatus.url : null,
    title: navStatus && !isTagged(navStatus, "Idle") ? navStatus.title : null,
    loading: isTagged(navStatus ?? {}, "Loading"),
    ...viewportStatus,
  };
};

const raiseAtomCommandFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): never => {
  throw squashAtomCommandFailure(result);
};

const raisePreviewAutomationHostError = (
  error: PreviewAutomationRecordingNotActiveError,
): never => {
  throw error;
};

export function PreviewAutomationHosts() {
  const { environments } = useEnvironments();

  if (!isElectron || !previewBridge?.automation) return null;

  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       */}
      {environments.map((environment) => (
        <PreviewAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

interface PreviewActivity {
  release: (() => void) | null;
}

const decodeOpen = Schema.decodeUnknownSync(PreviewAutomationOpenInput);

const decodeNavigate = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);

const decodeResize = Schema.decodeUnknownSync(PreviewAutomationResizeInput);

const decodeSetColorScheme = Schema.decodeUnknownSync(PreviewAutomationSetColorSchemeInput);

const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);

const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);

const decodePress = Schema.decodeUnknownSync(PreviewAutomationPressInput);

const decodeScroll = Schema.decodeUnknownSync(PreviewAutomationScrollInput);

const decodeEvaluate = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);

const decodeWaitFor = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);

function PreviewAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const [automationClientId] = useState(createPreviewAutomationClientId);

  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    }),
    [automationClientId, environmentId],
  );

  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });

  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
  });

  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });

  const resize = useAtomCommand(previewEnvironment.resize, {
    reportFailure: false,
  });

  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );

  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "preview automation host focus",
  );

  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<PreviewAutomationResponse["result"]> => {
      const threadRef: ScopedThreadRef = {
        environmentId,
        threadId: request.threadId,
      };

      let tabId = request.tabId ?? null;
      const browserActivity: PreviewActivity = { release: null };

      try {
        let state = readThreadPreviewState(threadRef);
        const needsSessionSync = needsPreviewAutomationSessionSync(state, request.tabId);

        if (needsSessionSync) {
          const listTarget = {
            environmentId,
            input: { threadId: request.threadId },
          } as const;

          registry.refresh(previewEnvironment.list(listTarget));
          const result = await listPreviews(listTarget);

          if (isTagged(result, "Failure")) {
            return raiseAtomCommandFailure(result);
          }

          reconcilePreviewServerSessions(threadRef, result.value);
          state = readThreadPreviewState(threadRef);
        }

        tabId = request.tabId ?? state.snapshot?.tabId ?? null;

        const unavailableTarget = {
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          bridgeAvailable: Boolean(previewBridge),
        };

        const requireReadyTab = async () => {
          const bridge = previewBridge;
          const readyTabId = tabId;

          if (!bridge || !readyTabId) {
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          }

          const readyState = readThreadPreviewState(threadRef);
          const runtimeTabId = previewRuntimeTabId(threadRef, readyState.serverEpoch, readyTabId);
          browserActivity.release ??= acquireBrowserSurfaceActivity(runtimeTabId);
          await waitForDesktopOverlay(
            threadRef,
            request.requestId,
            readyTabId,
            runtimeTabId,
            request.operation,
            request.timeoutMs,
          );

          return {
            bridge,
            tabId: readyTabId,
            runtimeTabId,
          };
        };

        switch (request.operation) {
          case "status":
            return await currentStatus(threadRef, tabId);
          case "open": {
            const input = decodeOpen(request.input);

            const resolvedInputUrl = input.url
              ? resolveBrowserNavigationTarget(environmentId, {
                  kind: "url",
                  url: input.url,
                }).resolvedUrl
              : undefined;

            let activeTabId = resolvePreviewAutomationOpenTab(
              state,
              request.tabId,
              input.reuseExistingTab ?? true,
            );

            let activeSnapshot = activeTabId
              ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
              : undefined;

            const reusedExistingTab = activeTabId !== null;
            tabId = activeTabId;

            if (!activeTabId) {
              const result = await open({
                environmentId,
                input: {
                  threadId: request.threadId,
                  ...(resolvedInputUrl ? { url: resolvedInputUrl } : {}),
                  // An agent that didn't state a size gets the user's
                  // configured default, same as a hand-opened tab.
                  viewport: browserDefaultOpenViewport(await resolveBrowserDefaults()),
                },
              });

              if (isTagged(result, "Failure")) {
                return raiseAtomCommandFailure(result);
              }

              const snapshot = result.value;
              applyPreviewServerSnapshot(threadRef, snapshot);
              activeTabId = snapshot.tabId;
              activeSnapshot = snapshot;
              tabId = activeTabId;
            }

            const activeRuntimeTabId = previewRuntimeTabId(
              threadRef,
              readThreadPreviewState(threadRef).serverEpoch,
              activeTabId,
            );

            if (activeSnapshot) {
              const defaultViewport = previewAutomationDefaultViewport(
                reusedExistingTab,
                activeSnapshot,
              );

              if (defaultViewport) {
                const resizeResult = await runBrowserViewportMutation(
                  activeRuntimeTabId,
                  async () => {
                    assertPreviewRuntimeCurrent(
                      threadRef,
                      activeTabId,
                      activeRuntimeTabId,
                      request,
                    );

                    return await resize({
                      environmentId,
                      input: {
                        threadId: request.threadId,
                        tabId: activeTabId,
                        viewport: defaultViewport,
                      },
                    });
                  },
                );

                if (isTagged(resizeResult, "Failure")) {
                  return raiseAtomCommandFailure(resizeResult);
                }

                activeSnapshot = resizeResult.value;
                updatePreviewServerSnapshot(threadRef, resizeResult.value);
              }
            }

            if (activeSnapshot && previewAutomationOpenNeedsOverlay(input, activeSnapshot)) {
              await requireReadyTab();
            }

            if (reusedExistingTab && resolvedInputUrl && previewBridge) {
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              await previewBridge.navigate(activeRuntimeTabId, resolvedInputUrl);
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                "load",
                request.timeoutMs,
              );
            }

            return await currentStatus(threadRef, activeTabId);
          }

          case "navigate": {
            const ready = await requireReadyTab();
            const input = decodeNavigate(request.input);

            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              input.target ?? {
                kind: "url",
                url: input.url!,
              },
            );

            await ready.bridge.navigate(ready.runtimeTabId, resolution.resolvedUrl);
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              input.readiness ?? "load",
              input.timeoutMs ?? request.timeoutMs,
            );

            return await currentStatus(threadRef, ready.tabId);
          }

          case "resize": {
            const ready = await requireReadyTab();
            const input = decodeResize(request.input);
            const setting = resolvePreviewViewport(input);

            const applied = await runBrowserViewportMutation(ready.runtimeTabId, async () => {
              const operationState = assertPreviewRuntimeCurrent(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                request,
              );

              const previousSetting =
                operationState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;

              const result = await resize({
                environmentId,
                input: {
                  threadId: request.threadId,
                  tabId: ready.tabId,
                  viewport: setting,
                },
              });

              if (isTagged(result, "Failure")) {
                return raiseAtomCommandFailure(result);
              }

              updatePreviewServerSnapshot(threadRef, result.value);

              return {
                previousSetting,
                serverEpoch: operationState.serverEpoch,
              };
            });

            let viewport: PreviewRenderedViewportSize;

            try {
              viewport = await waitForRenderedViewport(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                setting,
                input.timeoutMs ?? request.timeoutMs,
                {
                  requestId: request.requestId,
                  operation: request.operation,
                  environmentId,
                  threadId: request.threadId,
                },
              );
            } catch (cause) {
              await runBrowserViewportMutation(ready.runtimeTabId, async () => {
                const latestState = readThreadPreviewState(threadRef);

                const latestSetting =
                  latestState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;

                if (
                  shouldRollbackPreviewViewport(
                    applied.previousSetting,
                    setting,
                    latestSetting,
                    applied.serverEpoch,
                    latestState.serverEpoch,
                  )
                ) {
                  const rollback = await resize({
                    environmentId,
                    input: {
                      threadId: request.threadId,
                      tabId: ready.tabId,
                      viewport: applied.previousSetting,
                    },
                  });

                  if (!isTagged(rollback, "Failure")) {
                    updatePreviewServerSnapshot(threadRef, rollback.value);
                  }
                }
              });
              throw cause;
            }

            return {
              tabId: ready.tabId,
              setting,
              viewport,
            } satisfies PreviewAutomationResizeResult;
          }

          case "setColorScheme": {
            const ready = await requireReadyTab();
            const input = decodeSetColorScheme(request.input);
            await ready.bridge.setColorScheme(ready.runtimeTabId, input.colorScheme);

            return {
              tabId: ready.tabId,
              colorScheme: input.colorScheme,
            } satisfies PreviewAutomationSetColorSchemeResult;
          }

          case "snapshot": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.snapshot(ready.runtimeTabId);
          }

          case "click": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.click(
              ready.runtimeTabId,
              decodeClick(request.input),
            );
          }

          case "type": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.type(
              ready.runtimeTabId,
              decodeType(request.input),
            );
          }

          case "press": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.press(
              ready.runtimeTabId,
              decodePress(request.input),
            );
          }

          case "scroll": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.scroll(
              ready.runtimeTabId,
              decodeScroll(request.input),
            );
          }

          case "evaluate": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.evaluate(
              ready.runtimeTabId,
              decodeEvaluate(request.input),
            );
          }

          case "waitFor": {
            const ready = await requireReadyTab();

            return await ready.bridge.automation.waitFor(
              ready.runtimeTabId,
              decodeWaitFor(request.input),
            );
          }

          case "recordingStart": {
            const ready = await requireReadyTab();

            const startedAt = await startBrowserRecording(
              ready.runtimeTabId,
              threadRef,
              ready.tabId,
            );

            return {
              tabId: ready.tabId,
              recording: true,
              startedAt,
            };
          }

          case "recordingStop": {
            const activeRecordings = readActiveBrowserRecordingTargets(threadRef);

            const activeTabIds = new Set(
              activeRecordings.map((recording) => recording.serverTabId),
            );

            const stopTabId = resolveBrowserRecordingStopTarget(
              activeTabIds,
              tabId,
              request.tabIdExplicit ? request.tabId : undefined,
            );

            tabId = stopTabId ?? tabId;

            const stopRuntimeTabId =
              activeRecordings.find((recording) => recording.serverTabId === stopTabId)
                ?.runtimeTabId ?? null;

            const artifact = stopRuntimeTabId ? await stopBrowserRecording(stopRuntimeTabId) : null;

            if (!artifact || !stopTabId) {
              return raisePreviewAutomationHostError(
                new PreviewAutomationRecordingNotActiveError({
                  requestId: request.requestId,
                  environmentId,
                  threadId: request.threadId,
                  tabId,
                }),
              );
            }

            return { ...artifact, tabId: stopTabId };
          }
        }
      } catch (cause) {
        throw PreviewAutomationOperationError.fromCause({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          cause,
        });
      } finally {
        browserActivity.release?.();
      }
    },
    [environmentId, listPreviews, open, registry, resize],
  );

  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );

  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      void focusAutomationHost({
        environmentId,
        input: {
          clientId: automationClientId,
          environmentId,
          connectionId: automationConnectionId,
          focused: document.hasFocus(),
        },
      });
    };

    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);

    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  return null;
}
