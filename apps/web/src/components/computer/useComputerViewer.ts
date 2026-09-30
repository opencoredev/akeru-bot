import { RegistryContext } from "@effect/atom-react";
import {
  deriveComputerViewer,
  type ComputerViewerState,
} from "@akeru/client-runtime/state/computer-viewer";
import {
  createComputerViewerController,
  type ComputerViewerController,
  type ComputerViewerOutcome,
} from "@akeru/client-runtime/state/computer-viewer-controller";
import type { AtomCommandResult } from "@akeru/client-runtime/state/runtime";
import {
  COMPUTER_SESSION_TTL_MS,
  ComputerError,
  type ComputerState,
  type ScopedThreadRef,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { computerEnvironment } from "~/state/computer";
import { useEnvironmentConnectionState } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

const isComputerError = Schema.is(ComputerError);
/** How often an open viewer asks again for a computer that has not started yet. */
const UNAVAILABLE_RECHECK_MS = 5_000;

/** Adapts an RPC command result into the controller's outcome, keeping the server's error code. */
export function computerViewerOutcome<A, E>(
  result: AtomCommandResult<A, E>,
): ComputerViewerOutcome<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  const error = Cause.squash(result.cause);
  return { ok: false, code: isComputerError(error) ? error.code : "adapter" };
}

/**
 * Applies a recheck made while the computer looked unavailable. A recheck that
 * returns after the computer appeared is stale and must not hide it.
 */
export function applyUnavailableRecheck(
  controller: Pick<ComputerViewerController, "dispatch" | "getState">,
  state: ComputerState,
): void {
  if (controller.getState().server?.status !== "unavailable") return;
  controller.dispatch({ type: "server-state", state });
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    () => document.visibilityState === "visible",
    () => true,
  );
}

export interface ComputerViewerHandle {
  readonly controller: ComputerViewerController;
  readonly state: ComputerViewerState;
  readonly view: ReturnType<typeof deriveComputerViewer>;
}

/**
 * Runs one computer viewer for a thread. The stream is held only while the
 * viewer is open and the page is visible; hiding closes it and hands control
 * back to the bot.
 */
export function useComputerViewer(threadRef: ScopedThreadRef, open: boolean): ComputerViewerHandle {
  const registry = useContext(RegistryContext);
  const commandOptions = { reportFailure: false, reportDefect: false } as const;
  const getState = useAtomQueryRunner(computerEnvironment.state, commandOptions);
  const openComputer = useAtomCommand(computerEnvironment.open, commandOptions);
  const acquire = useAtomCommand(computerEnvironment.acquire, commandOptions);
  const input = useAtomCommand(computerEnvironment.input, commandOptions);
  const release = useAtomCommand(computerEnvironment.release, commandOptions);
  const close = useAtomCommand(computerEnvironment.close, commandOptions);
  const stop = useAtomCommand(computerEnvironment.stop, commandOptions);

  const { environmentId, threadId } = threadRef;
  const eventsAtom = useMemo(
    () => computerEnvironment.events({ environmentId, input: { threadId } }),
    [environmentId, threadId],
  );
  const [streamEpoch, setStreamEpoch] = useState(0);
  const resubscribe = useCallback(() => setStreamEpoch((epoch) => epoch + 1), []);

  const controller = useMemo(() => {
    const target = { environmentId, input: { threadId } };
    return createComputerViewerController({
      port: {
        getState: async () => computerViewerOutcome(await getState(target)),
        open: async () => computerViewerOutcome(await openComputer(target)),
        acquire: async () => computerViewerOutcome(await acquire(target)),
        input: async (next) =>
          computerViewerOutcome(await input({ environmentId, input: { threadId, ...next } })),
        release: async (sessionId) =>
          computerViewerOutcome(await release({ environmentId, input: { threadId, sessionId } })),
        close: async () => computerViewerOutcome(await close(target)),
        stop: async () => computerViewerOutcome(await stop(target)),
      },
      onReopened: resubscribe,
    });
  }, [
    acquire,
    close,
    environmentId,
    getState,
    input,
    openComputer,
    release,
    resubscribe,
    stop,
    threadId,
  ]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const pageVisible = usePageVisible();
  const visible = open && pageVisible;

  useEffect(() => {
    if (!visible) return;
    void controller.show();
    return () => {
      void controller.hide();
    };
  }, [controller, visible]);

  const connection = useEnvironmentConnectionState(environmentId).data;
  const connected = connection === null || connection.phase === "connected";
  useEffect(() => {
    controller.dispatch({ type: "connection", connected });
  }, [connected, controller]);

  // A computer can start after the viewer opens, and events only exist for a
  // registered computer, so an open viewer rechecks until one appears.
  const unavailable = visible && connected && state.server?.status === "unavailable";
  useEffect(() => {
    if (!unavailable) return;
    let active = true;
    const timer = setInterval(() => {
      void getState({ environmentId, input: { threadId } }).then((outcome) => {
        const next = computerViewerOutcome(outcome);
        if (active && next.ok) applyUnavailableRecheck(controller, next.value);
      });
    }, UNAVAILABLE_RECHECK_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [controller, environmentId, getState, threadId, unavailable]);

  // Follow the event stream only while someone is watching. The stream ends
  // when the computer stops; resuming bumps the epoch to subscribe again.
  const status = state.server?.status ?? null;
  const streamable = visible && connected && status !== "stopped" && status !== "unavailable";
  useEffect(() => {
    if (!streamable) return;
    if (streamEpoch > 0) registry.refresh(eventsAtom);
    return registry.subscribe(
      eventsAtom,
      (result) => {
        if (result._tag === "Success") controller.receive(result.value);
        else if (result._tag === "Failure") {
          void getState({ environmentId, input: { threadId } }).then((outcome) => {
            const next = computerViewerOutcome(outcome);
            if (next.ok) controller.dispatch({ type: "server-state", state: next.value });
          });
        }
      },
      { immediate: true },
    );
  }, [
    controller,
    environmentId,
    eventsAtom,
    getState,
    registry,
    streamEpoch,
    streamable,
    threadId,
  ]);

  // The lease cannot be renewed. Time it on this device's clock from when it
  // was granted, so clock skew with a remote server cannot end it early.
  const lease = state.lease;
  const leaseId = lease?.sessionId ?? null;
  const leaseExpiresAt = lease?.expiresAt ?? null;
  useEffect(() => {
    if (leaseId === null || leaseExpiresAt === null) return;
    const timer = window.setTimeout(
      () => controller.dispatch({ type: "tick", now: leaseExpiresAt }),
      COMPUTER_SESSION_TTL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [controller, leaseExpiresAt, leaseId]);

  const view = useMemo(() => deriveComputerViewer(state), [state]);
  return { controller, state, view };
}
