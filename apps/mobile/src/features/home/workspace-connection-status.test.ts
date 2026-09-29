import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import {
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
  workspaceConnectionStatusPresentation,
  type TranslateMessage,
} from "./workspace-connection-status";

const t: TranslateMessage = (message, params) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    message,
  );

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

describe("workspace connection status", () => {
  it("stays hidden while a ready environment is connected", () => {
    expect(shouldShowWorkspaceConnectionStatus(workspaceState())).toBe(false);
  });

  it("surfaces offline snapshots", () => {
    const state = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state, t)).toBe("You are offline");
  });

  it("names the environment while reconnecting", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Julius’s Mac mini",
          displayUrl: "",
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorCode: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state, t)).toBe("Reconnecting to Julius’s Mac mini…");
  });

  it("surfaces connection errors before the generic disconnected fallback", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasLoadedShellSnapshot: false,
      hasReadyEnvironment: false,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state, t)).toBe("Could not reach Julius’s Mac mini");
  });

  it("shows shell catch-up while cached threads remain visible", () => {
    const state = workspaceState({ hasPendingShellSnapshot: true });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state, t)).toBe("Syncing chats…");
  });

  it("distinguishes initial shell loading from cached catch-up", () => {
    const state = workspaceState({
      hasLoadedShellSnapshot: false,
      hasPendingShellSnapshot: true,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state, t)).toBe("Loading chats…");
  });

  it("presents nothing while connected", () => {
    expect(workspaceConnectionStatusPresentation(workspaceState(), t)).toBeNull();
  });

  it("stays quiet when another environment is reconnecting while one is connected", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: true,
      connectingEnvironments: [
        {
          environmentId: "environment-2" as never,
          environmentLabel: "ms-a2",
          displayUrl: "",
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorCode: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(false);
    expect(workspaceConnectionStatusPresentation(state, t)).toBeNull();
  });

  it("stays quiet with no environments configured", () => {
    const state = workspaceState({
      hasConnections: false,
      hasReadyEnvironment: false,
      hasLoadedShellSnapshot: false,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(false);
    expect(workspaceConnectionStatusPresentation(state, t)).toBeNull();
  });

  it("stays quiet while connections are still loading", () => {
    const state = workspaceState({
      isLoadingConnections: true,
      hasReadyEnvironment: false,
      hasLoadedShellSnapshot: false,
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(false);
  });

  it("reports a connection error when nothing is ready", () => {
    const state = workspaceState({
      hasReadyEnvironment: false,
      connectionError: "Could not reach ms-a2",
    });

    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusPresentation(state, t)).toEqual({
      label: "Could not reach ms-a2",
      showsProgress: false,
    });
  });

  it("still shows the environment name when nothing is connected", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "ms-a2",
          displayUrl: "",
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorCode: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusLabel(state, t)).toBe("Reconnecting to ms-a2…");
  });

  it("presents progress while reconnecting but not while offline", () => {
    const reconnecting = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Julius’s Mac mini",
          displayUrl: "",
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorCode: null,
          connectionErrorTraceId: null,
        },
      ],
    });
    expect(workspaceConnectionStatusPresentation(reconnecting, t)).toEqual({
      label: "Reconnecting to Julius’s Mac mini…",
      showsProgress: true,
    });

    const offline = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });
    expect(workspaceConnectionStatusPresentation(offline, t)).toEqual({
      label: "You are offline",
      showsProgress: false,
    });
  });

  it("stays quiet offline with no environments configured", () => {
    const state = workspaceState({
      hasConnections: false,
      hasReadyEnvironment: false,
      networkStatus: "offline",
    });

    expect(workspaceConnectionStatusPresentation(state, t)).toBeNull();
  });

  it("shows chat syncing ahead of another environment's error", () => {
    const state = workspaceState({
      hasPendingShellSnapshot: true,
      connectionError: "Could not reach ms-a2",
    });

    expect(workspaceConnectionStatusPresentation(state, t)).toEqual({
      label: "Syncing chats…",
      showsProgress: true,
    });
  });
});
