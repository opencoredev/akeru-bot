import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppUpdateLaunchCheck,
  runAppUpdateCheck,
  type AppUpdateCheckState,
} from "./app-updates";
import { makeUpdateClient } from "./app-updates.test-support";

vi.mock("expo-updates", () => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

describe("runAppUpdateCheck", () => {
  it("does nothing while running from the Metro development server", async () => {
    vi.stubGlobal("__DEV__", true);
    const client = makeUpdateClient();

    try {
      await runAppUpdateCheck({ client });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
  });
});

describe("runAppUpdateCheck", () => {
  it("stops quietly when the running bundle is current", async () => {
    const client = makeUpdateClient();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({ client, onStateChange: (state) => states.push(state) });

    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(states).toEqual(["checking", "current"]);
  });

  it("reports manual failures without continuing the update", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const failures: string[] = [];
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      client,
      onFailure: (message) => failures.push(message),
      onStateChange: (state) => states.push(state),
    });

    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(failures).toEqual(["offline"]);
    expect(states).toEqual(["checking", "idle"]);
    reportError.mockRestore();
  });

  it.each(["ERR_NOT_AVAILABLE_IN_DEV_CLIENT", "ERR_UPDATES_DISABLED"])(
    "treats Expo's %s failure as an unavailable update check",
    async (code) => {
      const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = Object.assign(new Error("Updates are unavailable"), { code });
      const client = makeUpdateClient({
        checkForUpdateAsync: vi.fn(async () => {
          throw error;
        }),
      });
      const failures: string[] = [];
      const states: AppUpdateCheckState[] = [];

      await runAppUpdateCheck({
        client,
        onFailure: (message) => failures.push(message),
        onStateChange: (state) => states.push(state),
      });

      expect(reportError).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
      expect(states).toEqual(["checking", "idle"]);
      reportError.mockRestore();
    },
  );

  it("coalesces overlapping launch and manual checks", async () => {
    let resolveCheck!: (result: {
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((resolve) => {
      resolveCheck = resolve;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const checkOnLaunch = createAppUpdateLaunchCheck(client);
    const manualStates: AppUpdateCheckState[] = [];

    const launchCheck = checkOnLaunch();
    const manualCheck = runAppUpdateCheck({
      client,
      onStateChange: (state) => manualStates.push(state),
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(manualStates).toEqual(["checking"]);

    resolveCheck({
      isAvailable: false,
      isRollBackToEmbedded: false,
    });
    await Promise.all([launchCheck, manualCheck]);

    expect(manualStates).toEqual(["checking", "current"]);

    await runAppUpdateCheck({ client });
    expect(client.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it("forwards failures to a manual check coalesced with the launch check", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectCheck!: (error: Error) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((_resolve, reject) => {
      rejectCheck = reject;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const checkOnLaunch = createAppUpdateLaunchCheck(client);
    const failures: string[] = [];
    const manualStates: AppUpdateCheckState[] = [];

    const launchCheck = checkOnLaunch();
    const manualCheck = runAppUpdateCheck({
      client,
      onFailure: (message) => failures.push(message),
      onStateChange: (state) => manualStates.push(state),
    });

    rejectCheck(new Error("offline"));
    await Promise.all([launchCheck, manualCheck]);

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(failures).toEqual(["offline"]);
    expect(manualStates).toEqual(["checking", "idle"]);
    reportError.mockRestore();
  });

  it("publishes the in-flight check before a state callback can re-enter", async () => {
    let resolveCheck!: (result: {
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }) => void;
    const checkResult = new Promise<{
      readonly isAvailable: boolean;
      readonly isRollBackToEmbedded: boolean;
    }>((resolve) => {
      resolveCheck = resolve;
    });
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(() => checkResult),
    });
    const reentrantStates: AppUpdateCheckState[] = [];
    let reentrantCheck: Promise<void> | undefined;
    let didReenter = false;

    const initialCheck = runAppUpdateCheck({
      client,
      onStateChange: (state) => {
        if (state !== "checking" || didReenter) return;
        didReenter = true;
        reentrantCheck = runAppUpdateCheck({
          client,
          onStateChange: (reentrantState) => reentrantStates.push(reentrantState),
        });
      },
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(reentrantCheck).toBeDefined();
    expect(reentrantStates).toEqual(["checking"]);

    resolveCheck({
      isAvailable: false,
      isRollBackToEmbedded: false,
    });
    await Promise.all([initialCheck, reentrantCheck]);

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(reentrantStates).toEqual(["checking", "current"]);
  });
});
