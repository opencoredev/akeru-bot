import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    latestCachedSnapshotReceivedAt: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("deriveHomeEmptyState", () => {
  it("keeps loading while a connected environment has not sent its first snapshot", () => {
    expect(
      deriveHomeEmptyState({
        catalogState: workspaceState({ hasLoadedShellSnapshot: false }),
        projectCount: 0,
      }),
    ).toMatchObject({ title: "Connecting to environment", loading: true });
  });

  it("says there are no chats once the snapshot has loaded", () => {
    expect(deriveHomeEmptyState({ catalogState: workspaceState(), projectCount: 2 })).toMatchObject(
      { title: "No chats yet", loading: false },
    );
  });
});
