export type AppUpdateCheckState =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "restarting"
  | "current";

export interface AppUpdateClient {
  readonly isEnabled: boolean;
  readonly checkForUpdateAsync: () => Promise<{
    readonly isAvailable: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly fetchUpdateAsync: () => Promise<{
    readonly isNew: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly reloadAsync: () => Promise<void>;
}

/**
 * The pieces of the app the update flow has to coordinate with before it may
 * tear down the JavaScript runtime. Injectable so the flow stays unit-testable.
 */
export interface AppUpdateEnvironment {
  /** Asks the user to install the waiting update now; `false` keeps it deferred. */
  readonly confirmInstallNow: () => Promise<boolean>;
  /**
   * Lands persisted state (drafts, outbox) before the restart. Rejects when a
   * write failed, so a silent restart can hold off instead of dropping the
   * unsaved in-memory state.
   */
  readonly flushPendingWrites: () => Promise<void>;
  /**
   * Whether a deferred restart may fire right now: the app must still be
   * backgrounded (flush latency or an iOS suspend can push the continuation
   * into the next foreground session) and not merely paused behind an
   * app-initiated handoff like the Android image picker.
   */
  readonly isSafeToRestartInBackground: () => Promise<boolean>;
  /**
   * Runs `apply` the next time the app enters the background. With
   * `includeCurrent`, an app that is already backgrounded fires immediately
   * (so a backgrounding that raced module load is not missed); without it,
   * only a future transition fires, so an attempt that already failed in the
   * current background session cannot retry in a tight loop.
   */
  readonly onNextBackground: (apply: () => void, includeCurrent: boolean) => void;
  /**
   * Runs `apply` once the app has stayed foregrounded for the whole prompt
   * window — the signal that a deferred install has had no backgrounding to
   * ride on.
   */
  readonly onForegroundStay: (apply: () => void) => void;
}

/** Tracks a downloaded update waiting for a safe moment to install. */
export interface AppUpdateDeferral {
  pendingInstall: boolean;
  /**
   * Claimed by whichever restart sequence (deferred backgrounding, foreground
   * prompt, manual install) starts first, so racing paths cannot tear down
   * the runtime twice.
   */
  installInProgress: boolean;
}

export function createAppUpdateDeferral(): AppUpdateDeferral {
  return { pendingInstall: false, installInProgress: false };
}

export interface AppUpdateCheckOptions {
  /**
   * "background" (default) installs silently at the next backgrounding,
   * asking only if the app then stays foregrounded so long that the install
   * never gets its chance. "immediate" restarts as soon as the download
   * lands — reserved for flows where the user explicitly requested the update.
   */
  readonly applyMode?: "background" | "immediate";
  readonly client?: AppUpdateClient;
  readonly deferral?: AppUpdateDeferral;
  readonly environment?: AppUpdateEnvironment;
  readonly onFailure?: (message: string) => void;
  readonly onStateChange?: (state: AppUpdateCheckState) => void;
}

export type AppUpdateInstallOutcome = "installed" | "flush-failed" | "restart-failed";
