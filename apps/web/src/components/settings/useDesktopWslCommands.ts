import { useCallback, useMemo } from "react";
import { type DesktopWslState } from "@akeru/contracts";
import { applyWslEnableSelection } from "./ConnectionsSettings.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { refreshDesktopWslState } from "~/state/desktopWslState";
import { type EnvironmentPresentation } from "~/state/environments";

// Sentinels for the consolidated WSL backend picker. The colon is
// rejected by DISTRO_NAME_PATTERN (validated on the desktop side) so
// neither can collide with a real distro name.
export const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";

export const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

// Pending WSL setting change waiting on user confirmation. Set when
// the user tries a destructive change (disable, switch distro,
// toggle wsl-only) while the WSL backend has saved-env state on this
// machine. Confirming applies the change; cancelling drops it
// without touching the persisted setting. Null when nothing is
// pending.
export type PendingWslChange =
  // wasWslOnly is true when the user picked Off while wsl-only mode
  // was active. In that case "disable" also clears wsl-only and
  // relaunches onto the Windows backend, because leaving wsl-only on
  // with wslBackendEnabled off is a meaningless state (wsl-only is
  // only honoured when the WSL backend is enabled).
  | { readonly kind: "disable"; readonly wasWslOnly: boolean }
  | { readonly kind: "distro"; readonly nextDistro: string | null }
  // Asked at enable time so the user picks the mode upfront instead
  // of being dropped into "both backends" and having to discover the
  // wsl-only switch separately. Resolved through enable-mode action
  // buttons on the dialog rather than a single Confirm.
  | { readonly kind: "enable"; readonly nextDistro: string | null }
  | { readonly kind: "wsl-only"; readonly nextValue: boolean };

export function useDesktopWslCommands({
  desktopBridge,
  desktopWslState,
  environments,
  pendingWslChange,
  setPendingWslChange,
  setIsUpdatingWslBackend,
  setDesktopWslMutationError,
}: {
  desktopBridge: Window["desktopBridge"];
  desktopWslState: DesktopWslState | null;
  environments: readonly EnvironmentPresentation[];
  pendingWslChange: PendingWslChange | null;
  setPendingWslChange: (change: PendingWslChange | null) => void;
  setIsUpdatingWslBackend: (updating: boolean) => void;
  setDesktopWslMutationError: (error: string | null) => void;
}) {
  // Apply a setting change immediately. The orchestrator reconciles the
  // pool in the background and the primary backend is untouched, so we
  // don't gate this behind a confirmation dialog. After the desktop
  // side persists the change and nudges its orchestrator, we trigger
  // the renderer's reconciler so the WSL backend's saved-env-shaped
  // entry catches up (registers/unregisters) without a reload.
  const applyWslSettingChange = useCallback(
    async (apply: () => Promise<DesktopWslState>) => {
      if (!desktopBridge) return;
      setIsUpdatingWslBackend(true);
      setDesktopWslMutationError(null);

      try {
        await apply();
        refreshDesktopWslState();
        // The connection platform source polls the desktop bootstrap list and
        // reconciles the environment catalog automatically, so toggling the WSL
        // backend on/off or switching distros is picked up here without an
        // explicit renderer reconcile.
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update WSL backend.";
        setDesktopWslMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change WSL backend",
            description: message,
          }),
        );
        refreshDesktopWslState();
      } finally {
        setIsUpdatingWslBackend(false);
      }
    },
    [desktopBridge],
  );

  // Reload the keep-alive WSL state atom. Clearing the mutation error before
  // refresh lets the atom-owned load error become the visible retry state.
  const loadWslState = useCallback(() => {
    setDesktopWslMutationError(null);
    refreshDesktopWslState();
  }, []);

  // True when a desktop-local WSL backend is currently registered as an
  // environment on this machine. We use this as a proxy for "the user has work
  // that lives on the WSL side": if WSL has connected in a way that registered
  // the env, disabling or switching distros could disrupt open threads/projects.
  // If WSL never connected (fresh install, toggled on then immediately off,
  // etc.) there's no local environment, so we skip the confirmation dialog.
  const hasWslRegistrationToLose = useMemo(() => {
    return environments.some((environment) =>
      isDesktopLocalConnectionTarget(environment.entry.target),
    );
  }, [environments]);

  // Single picker for "WSL backend off" vs "running on distro X". The
  // dropdown maps "Off" to disable and any distro entry to enable +
  // run on that distro. Splitting these into a separate switch and
  // dropdown was confusing — they're the same decision.
  const handleSelectWslMode = useCallback(
    (value: string) => {
      if (!desktopBridge || !desktopWslState) return;

      const defaultDistroName =
        desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;

      if (value === BACKEND_VALUE_WSL_OFF) {
        // Match the recovery row's visibility (`enabled || wslOnly`): when WSL
        // went unavailable while wsl-only was persisted, `enabled` can be false
        // while `wslOnly` is true, and the "Switch to Windows" button must
        // still clear that state instead of silently no-op'ing.
        if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
        const wasWslOnly = desktopWslState.wslOnly;

        // Confirm when there's WSL state to lose, OR when wsl-only is
        // on (turning the only running backend off needs to switch
        // back to Windows and restart — always consequential).
        if (hasWslRegistrationToLose || wasWslOnly) {
          setPendingWslChange({ kind: "disable", wasWslOnly });

          return;
        }

        void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));

        return;
      }

      const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
      const resolvedNext = nextDistro ?? defaultDistroName;

      if (!desktopWslState.enabled) {
        // Was off, user picked a distro: ask whether to run both
        // backends or only WSL. We always ask here so the user picks
        // the mode upfront instead of having to discover the wsl-only
        // switch afterwards.
        setPendingWslChange({ kind: "enable", nextDistro });

        return;
      }

      // Already enabled — treat as a distro switch. Skip the change if
      // the user re-picked the row that's already selected.
      const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;

      if (resolvedCurrent === resolvedNext) return;

      // Confirm when there's WSL registration to lose, OR in wsl-only mode:
      // there the primary IS the WSL backend, so a distro change relaunches
      // the app (the IPC handler does this) rather than swapping a secondary,
      // and the user should see that coming.
      if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
        setPendingWslChange({ kind: "distro", nextDistro });

        return;
      }

      void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, hasWslRegistrationToLose],
  );

  // Dispatched from the enable modal's two action buttons.
  const handleConfirmEnableWsl = useCallback(
    (mode: "both" | "wsl-only") => {
      if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== "enable") return;
      const nextDistro = pendingWslChange.nextDistro;
      setPendingWslChange(null);
      const persistedDistro = desktopWslState?.distro ?? null;
      void applyWslSettingChange(() =>
        applyWslEnableSelection({
          bridge: desktopBridge,
          mode,
          nextDistro,
          persistedDistro,
        }),
      );
    },
    [applyWslSettingChange, desktopBridge, desktopWslState, pendingWslChange],
  );

  const handleToggleWslOnly = useCallback(
    (enabled: boolean) => {
      if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
      // wsl-only changes which backend the pool uses as "primary",
      // which is decided once at app launch. The desktop side persists
      // the setting immediately but doesn't tear down or restart
      // anything itself; the renderer warns the user to expect a
      // restart and (in a follow-up) can trigger it automatically.
      // Always prompt — even enabling is consequential here.
      setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
    },
    [desktopBridge, desktopWslState],
  );

  const handleConfirmWslChange = useCallback(() => {
    if (!desktopBridge || !pendingWslChange) return;
    const change = pendingWslChange;

    // The enable kind resolves through handleConfirmEnableWsl, not
    // this single Confirm path.
    if (change.kind === "enable") return;
    setPendingWslChange(null);

    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);

        if (change.wasWslOnly) {
          // Clearing wsl-only relaunches onto the Windows backend.
          return await desktopBridge.setWslOnly(false);
        }

        return next;
      });

      return;
    }

    if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));

      return;
    }

    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
  }, [applyWslSettingChange, desktopBridge, pendingWslChange]);

  return {
    loadWslState,
    handleSelectWslMode,
    handleConfirmEnableWsl,
    handleToggleWslOnly,
    handleConfirmWslChange,
  };
}
