import { Predicate } from "effect";
import * as Updates from "expo-updates";
import { settlePromise } from "@akeru/client-runtime/state/runtime";
import {
  type AppUpdateCheckOptions,
  type AppUpdateCheckState,
  type AppUpdateClient,
  type AppUpdateDeferral,
  type AppUpdateEnvironment,
  createAppUpdateDeferral,
} from "./app-update-types";
import {
  armDeferredAppUpdateInstall,
  installAppUpdate,
  installPendingAppUpdate,
  reportUpdateFailure,
} from "./app-update-install";

export { createAppUpdateDeferral } from "./app-update-types";

export type {
  AppUpdateCheckState,
  AppUpdateClient,
  AppUpdateDeferral,
  AppUpdateEnvironment,
} from "./app-update-types";

const appUpdateDeferral = createAppUpdateDeferral();

interface AppUpdateCheckProgress {
  failure: string | undefined;
  state: AppUpdateCheckState | undefined;
}

interface AppUpdateCheckInFlight {
  readonly failureListeners: Set<NonNullable<AppUpdateCheckOptions["onFailure"]>>;
  readonly progress: AppUpdateCheckProgress;
  readonly promise: Promise<void>;
  readonly stateListeners: Set<NonNullable<AppUpdateCheckOptions["onStateChange"]>>;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (cause: unknown) => void;
  readonly resolve: () => void;
}

const HIDDEN_UPDATE_TAP_COUNT = 5;

let appUpdateCheckInFlight: AppUpdateCheckInFlight | undefined;

/** Expo's development launcher reports updates as enabled even though its OTA APIs reject. */
export function isAppUpdateCheckAvailable(client: Pick<AppUpdateClient, "isEnabled"> = Updates) {
  return client.isEnabled && !("__DEV__" in globalThis && __DEV__);
}

/**
 * Keeps the manual update affordance discoverable only to someone deliberately
 * tapping the version row five times.
 */
export function registerHiddenUpdateTap(count: number): {
  readonly nextCount: number;
  readonly shouldCheck: boolean;
} {
  const nextCount = count + 1;

  if (nextCount >= HIDDEN_UPDATE_TAP_COUNT) {
    return {
      nextCount: 0,
      shouldCheck: true,
    };
  }

  return {
    nextCount,
    shouldCheck: false,
  };
}

export async function runAppUpdateCheck(options: AppUpdateCheckOptions = {}): Promise<void> {
  const client = options.client ?? Updates;

  if (!isAppUpdateCheckAvailable(client)) return;

  if (appUpdateCheckInFlight) {
    await observeAppUpdateCheck(appUpdateCheckInFlight, options);

    // A background-mode check in flight may have deferred the download this
    // caller explicitly asked to install; honor the explicit request now.
    if (options.applyMode === "immediate") {
      const deferral = options.deferral ?? appUpdateDeferral;

      if (deferral.pendingInstall) {
        const environment = options.environment ?? defaultAppUpdateEnvironment;
        await installPendingAppUpdate(client, environment, deferral, options);
      }
    }

    return;
  }

  const progress: AppUpdateCheckProgress = {
    failure: undefined,
    state: undefined,
  };

  const failureListeners = new Set<NonNullable<AppUpdateCheckOptions["onFailure"]>>();
  const stateListeners = new Set<NonNullable<AppUpdateCheckOptions["onStateChange"]>>();

  if (options.onFailure) failureListeners.add(options.onFailure);

  if (options.onStateChange) stateListeners.add(options.onStateChange);

  const deferred = createDeferred();

  const inFlight: AppUpdateCheckInFlight = {
    failureListeners,
    progress,
    promise: deferred.promise,
    stateListeners,
  };

  // Publish the operation before any state listener can synchronously re-enter.
  appUpdateCheckInFlight = inFlight;

  const execution = performAppUpdateCheck(client, {
    applyMode: options.applyMode,
    deferral: options.deferral,
    environment: options.environment,
    onFailure: (message) => {
      progress.failure = message;
      notifyListeners(failureListeners, message);
    },
    onStateChange: (state) => {
      progress.state = state;
      notifyListeners(stateListeners, state);
    },
  });

  void execution.then(deferred.resolve, deferred.reject);

  try {
    await deferred.promise;
  } finally {
    if (appUpdateCheckInFlight === inFlight) {
      appUpdateCheckInFlight = undefined;
    }
  }
}

function createDeferred(): Deferred {
  let reject!: Deferred["reject"];
  let resolve!: Deferred["resolve"];

  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function notifyListeners<A>(listeners: ReadonlySet<(value: A) => void>, value: A): void {
  // A listener can synchronously subscribe another caller. Snapshot so that
  // caller receives only observeAppUpdateCheck's explicit current-value replay.
  const snapshot = Array.from(listeners);

  for (const listener of snapshot) listener(value);
}

async function observeAppUpdateCheck(
  inFlight: AppUpdateCheckInFlight,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const onFailure = options.onFailure;
  const onStateChange = options.onStateChange;

  if (onFailure) {
    inFlight.failureListeners.add(onFailure);

    if (inFlight.progress.failure) onFailure(inFlight.progress.failure);
  }

  if (onStateChange) {
    inFlight.stateListeners.add(onStateChange);

    if (inFlight.progress.state) onStateChange(inFlight.progress.state);
  }

  try {
    await inFlight.promise;
  } finally {
    if (onFailure) inFlight.failureListeners.delete(onFailure);

    if (onStateChange) inFlight.stateListeners.delete(onStateChange);
  }
}

async function performAppUpdateCheck(
  client: AppUpdateClient,
  options: AppUpdateCheckOptions,
): Promise<void> {
  const setState = options.onStateChange ?? (() => {});
  const environment = options.environment ?? defaultAppUpdateEnvironment;
  const deferral = options.deferral ?? appUpdateDeferral;

  // The user explicitly asked to install and a previous check has already
  // downloaded the update; restart into it without another network round trip.
  if (options.applyMode === "immediate" && deferral.pendingInstall) {
    await installPendingAppUpdate(client, environment, deferral, options);

    return;
  }

  setState("checking");
  const check = await settlePromise(() => client.checkForUpdateAsync());

  if (Predicate.isTagged(check, "Failure")) {
    reportUpdateFailure(check, "Could not check for updates.", options.onFailure);
    setState("idle");

    return;
  }

  // A rollback directive (`eas update:rollback`) arrives as isAvailable: false
  // with isRollBackToEmbedded: true. The running OTA still has to be dropped.
  if (!check.value.isAvailable && !check.value.isRollBackToEmbedded) {
    setState("current");

    return;
  }

  setState("downloading");
  const fetched = await settlePromise(() => client.fetchUpdateAsync());

  if (Predicate.isTagged(fetched, "Failure")) {
    reportUpdateFailure(fetched, "Could not download the update.", options.onFailure);
    setState("idle");

    return;
  }

  // isNew is always false for a rollback, so it cannot be the sole gate.
  if (!fetched.value.isNew && !fetched.value.isRollBackToEmbedded) {
    setState("current");

    return;
  }

  // A rollback directive exists to pull a broken bundle; never hold it
  // behind a prompt or a deferred install.
  if (options.applyMode === "immediate" || fetched.value.isRollBackToEmbedded) {
    const outcome = await installAppUpdate(
      client,
      environment,
      deferral,
      options,
      options.applyMode === "immediate",
    );

    if (outcome === "flush-failed") {
      // Only reachable for an automatic rollback: keep the state-bearing
      // runtime alive and retry like a deferred install. The fetched rollback
      // still applies at the next cold start regardless.
      setState("ready");
      armDeferredAppUpdateInstall(client, environment, deferral);
    }

    return;
  }

  setState("ready");
  armDeferredAppUpdateInstall(client, environment, deferral);
}

async function defaultConfirmInstallNow(): Promise<boolean> {
  const { Alert } = await import("react-native");
  const { translateOutsideReact: translate } = await import("../../lib/i18n");

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      translate("Update ready"),
      translate(
        "A new version has been downloaded and installs automatically the next time you leave the app. Install it now instead?",
      ),
      [
        { onPress: () => resolve(false), style: "cancel", text: translate("Later") },
        { onPress: () => resolve(true), text: translate("Install Now") },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

async function defaultFlushPendingWrites(): Promise<void> {
  // Attempt every flush before surfacing the first failure, so one broken
  // store cannot keep the others from landing.
  const results = await Promise.allSettled([
    import("../../state/use-composer-drafts").then((drafts) => drafts.flushComposerDrafts()),
    import("../../state/thread-outbox").then((outbox) => outbox.flushThreadOutbox()),
  ]);

  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  if (failed) throw failed.reason;
}

async function defaultIsSafeToRestartInBackground(): Promise<boolean> {
  const { isForegroundHandoffActive } = await import("../../lib/foreground-handoff");

  if (isForegroundHandoffActive()) return false;
  const { AppState } = await import("react-native");

  return AppState.currentState === "background";
}

function defaultOnNextBackground(apply: () => void, includeCurrent: boolean): void {
  void import("react-native").then(({ AppState }) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      subscription.remove();
      apply();
    });

    // The app may already have backgrounded while this module was loading;
    // the listener alone would then wait a whole extra foreground cycle.
    if (includeCurrent && AppState.currentState === "background") {
      subscription.remove();
      apply();
    }
  });
}

/**
 * How long the app may stay foregrounded with a downloaded update before the
 * install prompt appears. Long enough that most sessions background naturally
 * and install silently instead.
 */
export const DEFERRED_INSTALL_PROMPT_AFTER_MS = 30 * 60 * 1000;

/**
 * The window resets on every backgrounding because that is exactly when the
 * deferred install gets its chance. iOS "inactive" blips (app switcher, a
 * pulled-down notification shade) leave the timer running.
 */
function defaultOnForegroundStay(apply: () => void): void {
  void import("react-native").then(({ AppState }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = () => {
      timer ??= setTimeout(() => {
        subscription.remove();
        apply();
      }, DEFERRED_INSTALL_PROMPT_AFTER_MS);
    };

    const disarm = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") arm();
      else if (state === "background") disarm();
    });

    if (AppState.currentState === "active") arm();
  });
}

const defaultAppUpdateEnvironment: AppUpdateEnvironment = {
  confirmInstallNow: defaultConfirmInstallNow,
  flushPendingWrites: defaultFlushPendingWrites,
  isSafeToRestartInBackground: defaultIsSafeToRestartInBackground,
  onNextBackground: defaultOnNextBackground,
  onForegroundStay: defaultOnForegroundStay,
};

export function createAppUpdateLaunchCheck(
  client: AppUpdateClient = Updates,
): () => Promise<void> | undefined {
  let started = false;

  return () => {
    if (started || !isAppUpdateCheckAvailable(client)) return undefined;
    started = true;

    return runAppUpdateCheck({ client });
  };
}

export const checkForAppUpdateOnLaunch = createAppUpdateLaunchCheck();

/**
 * The app can stay resident for days, so a launch-only check misses updates
 * published while it was in memory. Anything shorter reads as noise: brief
 * app switches should not trigger network checks or an install prompt.
 */
export const FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS = 15 * 60 * 1000;

export function shouldRecheckAppUpdateOnForeground(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  pendingInstall: boolean,
): boolean {
  if (pendingInstall) return false;

  return (
    backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS
  );
}

export function createAppUpdateForegroundRecheck(
  client: AppUpdateClient = Updates,
  deferral: AppUpdateDeferral = appUpdateDeferral,
): () => void {
  let started = false;

  return () => {
    if (started || !isAppUpdateCheckAvailable(client)) return;
    started = true;
    void import("react-native").then(({ AppState }) => {
      let backgroundedAtMs: number | null = null;
      AppState.addEventListener("change", (state) => {
        if (state === "background") {
          backgroundedAtMs = Date.now();

          return;
        }

        if (state !== "active") return;

        const shouldCheck = shouldRecheckAppUpdateOnForeground(
          backgroundedAtMs,
          Date.now(),
          deferral.pendingInstall,
        );

        backgroundedAtMs = null;

        if (shouldCheck) void runAppUpdateCheck({ client, deferral });
      });
    });
  };
}

export const startAppUpdateForegroundRecheck = createAppUpdateForegroundRecheck();
