import type { WorkspaceState } from "../../state/workspaceModel";

export type TranslateMessage = (
  message: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  /** True while actively working (connecting/syncing) — render a spinner. False for offline/error/idle states — render a wifi-slash icon. */
  readonly showsProgress: boolean;
}

export function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  // The title slot only reports states that make the list unusable: the
  // device offline, a shell still catching up, or no usable environment.
  // A reconnecting environment behind a connected one stays quiet — its row
  // in Settings → Environments carries the per-environment state, and the
  // banner would just replace the header menu with an indefinite spinner.
  return (
    state.networkStatus === "offline" ||
    state.hasPendingShellSnapshot ||
    (state.hasConnections && !state.isLoadingConnections && !state.hasReadyEnvironment)
  );
}

export function workspaceConnectionStatusLabel(state: WorkspaceState, t: TranslateMessage): string {
  if (state.networkStatus === "offline") return t("You are offline");
  const connectingCount = state.connectingEnvironments.length;
  if (connectingCount === 1) {
    return t("Reconnecting to {environment}…", {
      environment: state.connectingEnvironments[0]!.environmentLabel,
    });
  }
  if (connectingCount > 1) {
    return t("Reconnecting {count} environments…", { count: connectingCount });
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? t("Syncing chats…") : t("Loading chats…");
  }
  return t("Not connected");
}

/** Header-title presentation of the connection state, or null while connected. */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
  t: TranslateMessage,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state, t),
    showsProgress:
      state.networkStatus !== "offline" &&
      state.connectionError === null &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
