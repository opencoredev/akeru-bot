import { Predicate } from "effect";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import type {
  AppUpdateCheckOptions,
  AppUpdateClient,
  AppUpdateDeferral,
  AppUpdateEnvironment,
  AppUpdateInstallOutcome,
} from "./app-update-types";

const UPDATE_CHECK_UNAVAILABLE_ERROR_CODES = new Set([
  "ERR_NOT_AVAILABLE_IN_DEV_CLIENT",
  "ERR_UPDATES_DISABLED",
]);

/**
 * Restarting mid-session while native surfaces are mounted is the crashiest
 * moment expo-updates has, so the restart flushes persistence first and, by
 * default, waits for a backgrounding — where nothing is rendering and the
 * teardown is invisible. Only a restart the user explicitly asked for may
 * proceed over a failed flush; an automatic one aborts with "flush-failed"
 * so unsaved state is never silently discarded.
 */
export async function installAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  options: AppUpdateCheckOptions,
  userRequested: boolean,
): Promise<AppUpdateInstallOutcome> {
  // A concurrent install sequence already owns the restart.
  if (deferral.installInProgress) return "installed";
  deferral.installInProgress = true;
  const setState = options.onStateChange ?? (() => {});
  setState("restarting");
  const flushed = await settlePromise(() => environment.flushPendingWrites());

  if (Predicate.isTagged(flushed, "Failure")) {
    reportUpdateFailure(flushed, "Could not save pending state.", undefined);

    if (!userRequested) {
      deferral.installInProgress = false;

      return "flush-failed";
    }
  }

  const reloaded = await settlePromise(() => client.reloadAsync());

  if (Predicate.isTagged(reloaded, "Failure")) {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.", options.onFailure);
    setState("idle");
    deferral.installInProgress = false;

    return "restart-failed";
  }

  return "installed";
}

/** Restarts into an already-downloaded update at the user's request. */
export async function installPendingAppUpdate(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const outcome = await installAppUpdate(client, environment, deferral, options, true);

  if (outcome === "restart-failed") {
    // Let later checks re-arm the install; the downloaded update still
    // applies at the next cold start regardless.
    deferral.pendingInstall = false;
  }
}

export function armDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): void {
  if (deferral.pendingInstall) return;
  deferral.pendingInstall = true;
  scheduleDeferredAppUpdateInstall(client, environment, deferral, true);
  environment.onForegroundStay(() => {
    void promptDeferredAppUpdateInstall(client, environment, deferral);
  });
}

/**
 * A deferred install normally rides the next backgrounding, but a session that
 * never leaves the foreground would sit on the download forever. Only then is
 * the user asked, and declining simply leaves the background install armed.
 */
async function promptDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): Promise<void> {
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  const installNow = await settlePromise(() => environment.confirmInstallNow());

  if (!Predicate.isTagged(installNow, "Success") || !installNow.value) return;

  // A backgrounding while the alert was up may have started the deferred
  // restart already; the stale accept must not start a second one.
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  await installPendingAppUpdate(client, environment, deferral, {});
}

function scheduleDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
  includeCurrent: boolean,
): void {
  environment.onNextBackground(() => {
    void applyDeferredAppUpdateInstall(client, environment, deferral);
  }, includeCurrent);
}

async function applyDeferredAppUpdateInstall(
  client: AppUpdateClient,
  environment: AppUpdateEnvironment,
  deferral: AppUpdateDeferral,
): Promise<void> {
  if (!deferral.pendingInstall || deferral.installInProgress) return;
  deferral.installInProgress = true;
  const flushed = await settlePromise(() => environment.flushPendingWrites());
  const safe = await settlePromise(() => environment.isSafeToRestartInBackground());

  if (
    Predicate.isTagged(flushed, "Failure") ||
    !Predicate.isTagged(safe, "Success") ||
    !safe.value
  ) {
    if (Predicate.isTagged(flushed, "Failure")) {
      // Nothing is lost yet: keep the state-bearing runtime alive and retry
      // the flush at the next backgrounding instead of restarting over it.
      reportUpdateFailure(flushed, "Could not save pending state.", undefined);
    }

    deferral.installInProgress = false;
    // This attempt already ran in the current background session; retrying
    // before a fresh transition would just loop over the same failure.
    scheduleDeferredAppUpdateInstall(client, environment, deferral, false);

    return;
  }

  const reloaded = await settlePromise(() => client.reloadAsync());

  if (Predicate.isTagged(reloaded, "Failure")) {
    reportUpdateFailure(reloaded, "Downloaded, but could not restart the app.", undefined);
    deferral.installInProgress = false;
    // Let later checks re-arm the install; the downloaded update still
    // applies at the next cold start regardless.
    deferral.pendingInstall = false;
  }
}

export function reportUpdateFailure(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
  onFailure: AppUpdateCheckOptions["onFailure"],
): void {
  if (!Predicate.isTagged(result, "Failure") || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);

  if (isAppUpdateUnavailableError(error)) return;

  reportAtomCommandResult(result, { label: "app update check" });
  onFailure?.(error instanceof Error ? error.message : fallback);
}

function isAppUpdateUnavailableError(cause: unknown): boolean {
  if (!Predicate.isObjectOrArray(cause) || cause === null || !("code" in cause)) return false;
  const code = cause.code;

  return Predicate.isString(code) && UPDATE_CHECK_UNAVAILABLE_ERROR_CODES.has(code);
}
