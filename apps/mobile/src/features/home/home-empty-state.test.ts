import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState, environmentsToRetry } from "./home-empty-state";

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

  it("offers a retry when the first snapshot fails on a connected environment", () => {
    expect(
      deriveHomeEmptyState({
        catalogState: workspaceState({
          hasLoadedShellSnapshot: false,
          shellSnapshotError: "Could not synchronize environment data.",
        }),
        projectCount: 0,
      }),
    ).toEqual({
      title: "Could not load chats",
      detail:
        "Could not synchronize environment data. Akeru keeps trying. Try again to reconnect now.",
      loading: false,
      retry: true,
    });
  });

  it("offers a retry when the environment is unavailable", () => {
    expect(
      deriveHomeEmptyState({
        catalogState: workspaceState({
          hasLoadedShellSnapshot: false,
          hasReadyEnvironment: false,
          connectionState: "error",
          connectionError: "Server unreachable.",
        }),
        projectCount: 0,
      }),
    ).toMatchObject({ title: "Environment unavailable", loading: false, retry: true });
  });
});

describe("environmentsToRetry", () => {
  const environment = (
    id: string,
    connectionState: WorkspaceEnvironment["connectionState"],
  ): WorkspaceEnvironment => ({
    environmentId: EnvironmentId.make(id),
    environmentLabel: id,
    displayUrl: "",
    connectionState,
    connectionError: null,
    connectionErrorCode: null,
    connectionErrorTraceId: null,
  });
  const loaded: EnvironmentShellState = {
    snapshot: Option.some({} as never),
    status: "live",
    error: Option.none(),
  };
  const failed: EnvironmentShellState = {
    snapshot: Option.none(),
    status: "synchronizing",
    error: Option.some("Snapshot failed"),
  };

  it("retries only the environment whose first snapshot failed", () => {
    const shells = new Map([
      ["alpha", failed],
      ["beta", loaded],
    ]);
    expect(
      environmentsToRetry(
        [environment("alpha", "connected"), environment("beta", "connected")],
        (id) => shells.get(id)!,
      ),
    ).toEqual(["alpha"]);
  });

  it("leaves disconnected environments alone while another needs recovery", () => {
    expect(
      environmentsToRetry(
        [environment("alpha", "error"), environment("beta", "available")],
        () => loaded,
      ),
    ).toEqual(["alpha"]);
  });

  it("reconnects disconnected environments when nothing else is failing", () => {
    expect(
      environmentsToRetry(
        [environment("alpha", "available"), environment("beta", "connected")],
        () => loaded,
      ),
    ).toEqual(["alpha"]);
  });
});
