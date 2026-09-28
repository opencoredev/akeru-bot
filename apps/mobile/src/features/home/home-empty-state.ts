import type { WorkspaceState } from "../../state/workspaceModel";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  /** The page offers Try again, which reconnects the saved environments. */
  readonly retry: boolean;
}

/** The full-page state the home list shows when there are no chats to list. */
export function deriveHomeEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): HomeEmptyState {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
      retry: false,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
      retry: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
      retry: true,
    };
  }

  // The environment is connected but its first snapshot failed. The stream
  // keeps retrying on its own; the page says so and offers a reconnect.
  if (!catalogState.hasLoadedShellSnapshot && catalogState.shellSnapshotError !== null) {
    return {
      title: "Could not load chats",
      detail: `${catalogState.shellSnapshotError} Akeru keeps trying. Try again to reconnect now.`,
      loading: false,
      retry: true,
    };
  }

  // A connection can report connected a moment before its first snapshot
  // lands; saying "No chats yet" then would be a lie.
  if (!catalogState.hasLoadedShellSnapshot && catalogState.connectionError === null) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and bots from the saved environment.",
      loading: true,
      retry: false,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
      retry: false,
    };
  }

  return {
    title: "No chats yet",
    detail: "Pick a bot to start a chat.",
    loading: false,
    retry: false,
  };
}
