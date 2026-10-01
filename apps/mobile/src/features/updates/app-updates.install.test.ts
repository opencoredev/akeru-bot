import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppUpdateDeferral,
  runAppUpdateCheck,
  type AppUpdateCheckState,
} from "./app-updates";
import {
  makeAvailableUpdateClient,
  makeUpdateClient,
  makeUpdateEnvironment,
} from "./app-updates.test-support";

vi.mock("expo-updates", () => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

describe("runAppUpdateCheck install", () => {
  it("downloads silently and installs at the next backgrounding", async () => {
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      client,
      deferral,
      environment,
      onStateChange: (state) => states.push(state),
    });

    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(states).toEqual(["checking", "downloading", "ready"]);
    expect(deferral.pendingInstall).toBe(true);
    expect(backgroundCallbacks).toHaveLength(1);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    expect(environment.flushPendingWrites).toHaveBeenCalled();
  });

  it("flushes pending writes before restarting", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();

    await runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral: createAppUpdateDeferral(),
      environment,
    });

    const flushOrder = vi.mocked(environment.flushPendingWrites).mock.invocationCallOrder[0]!;
    const reloadOrder = vi.mocked(client.reloadAsync).mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(reloadOrder);
  });

  it("prompts once the app has stayed foregrounded with the download waiting", async () => {
    const client = makeAvailableUpdateClient();
    const { environment, foregroundStayCallbacks } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(foregroundStayCallbacks).toHaveLength(1);

    foregroundStayCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    expect(environment.confirmInstallNow).toHaveBeenCalledOnce();
    expect(environment.flushPendingWrites).toHaveBeenCalled();
  });

  it("keeps the background install armed when the foreground prompt is declined", async () => {
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment, foregroundStayCallbacks } = makeUpdateEnvironment({
      confirmInstallNow: vi.fn(async () => false),
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });

    foregroundStayCallbacks[0]!();
    await vi.waitFor(() => expect(environment.confirmInstallNow).toHaveBeenCalledOnce());
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
  });

  it("skips the foreground prompt once the install is no longer pending", async () => {
    const client = makeAvailableUpdateClient();
    const { environment, foregroundStayCallbacks } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });

    // A failed deferred reload resets the deferral before the stay fires.
    deferral.pendingInstall = false;
    foregroundStayCallbacks[0]!();

    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).not.toHaveBeenCalled();
  });

  it("re-arms instead of restarting when the app is no longer safely backgrounded", async () => {
    const client = makeAvailableUpdateClient();
    const safe = vi.fn(async () => false);
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({
      isSafeToRestartInBackground: safe,
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    expect(backgroundCallbacks).toHaveLength(1);
    // Arming may fire for an already-backgrounded app…
    expect(vi.mocked(environment.onNextBackground).mock.calls[0]![1]).toBe(true);

    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(backgroundCallbacks).toHaveLength(2));
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);
    // …but a re-arm must wait for a fresh transition, or an unsafe attempt
    // would retry in a tight loop within the same background session.
    expect(vi.mocked(environment.onNextBackground).mock.calls[1]![1]).toBe(false);

    safe.mockResolvedValue(true);
    backgroundCallbacks[1]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
  });

  it("resets the deferral when the deferred restart fails", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeAvailableUpdateClient({
      reloadAsync: vi.fn(async () => {
        throw new Error("reload rejected");
      }),
    });
    const { backgroundCallbacks, environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    backgroundCallbacks[0]!();

    await vi.waitFor(() => expect(deferral.pendingInstall).toBe(false));
    reportError.mockRestore();
  });

  it("arms the deferred install once across repeated checks", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    await runAppUpdateCheck({ client, deferral, environment });

    expect(environment.onNextBackground).toHaveBeenCalledOnce();
    expect(environment.onForegroundStay).toHaveBeenCalledOnce();
  });

  it("restarts into an already-downloaded update when the user asks to install", async () => {
    const client = makeUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();
    deferral.pendingInstall = true;

    await runAppUpdateCheck({ applyMode: "immediate", client, deferral, environment });

    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
  });

  it("honors an immediate request that joined an in-flight background check", async () => {
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
    const { environment } = makeUpdateEnvironment();
    const deferral = createAppUpdateDeferral();

    const backgroundCheck = runAppUpdateCheck({ client, deferral, environment });
    const manualCheck = runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral,
      environment,
    });

    resolveCheck({ isAvailable: true, isRollBackToEmbedded: false });
    await Promise.all([backgroundCheck, manualCheck]);

    // The coalesced background check deferred the download, but the manual
    // caller explicitly asked to install, so the restart happens anyway.
    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
  });

  it("runs a single restart when the deferred install races the foreground prompt", async () => {
    const client = makeAvailableUpdateClient();
    let releaseFlush!: () => void;
    const blockedFlush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const flushPendingWrites = vi.fn(async (): Promise<void> => {});
    const { backgroundCallbacks, environment, foregroundStayCallbacks } = makeUpdateEnvironment({
      flushPendingWrites,
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    flushPendingWrites.mockReturnValue(blockedFlush);

    // The deferred install starts and blocks on its flush; the foreground
    // prompt firing in that window must not begin a second restart.
    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(flushPendingWrites).toHaveBeenCalledOnce());
    foregroundStayCallbacks[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();

    releaseFlush();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
  });

  it("holds the deferred restart and re-arms when the pre-restart flush fails", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeAvailableUpdateClient();
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({
      flushPendingWrites: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });
    backgroundCallbacks[0]!();

    await vi.waitFor(() => expect(backgroundCallbacks).toHaveLength(2));
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);
    reportError.mockRestore();
  });

  it("restarts without prompting when the caller asked for an immediate install", async () => {
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment();
    const states: AppUpdateCheckState[] = [];

    await runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral: createAppUpdateDeferral(),
      environment,
      onStateChange: (state) => states.push(state),
    });

    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "downloading", "restarting"]);
  });

  it("holds an automatic rollback restart when the flush fails and re-arms it", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => ({
        isAvailable: false,
        isRollBackToEmbedded: true,
      })),
      fetchUpdateAsync: vi.fn(async () => ({
        isNew: false,
        isRollBackToEmbedded: true,
      })),
    });
    const flushPendingWrites = vi.fn(async (): Promise<void> => {
      throw new Error("storage unavailable");
    });
    const { backgroundCallbacks, environment } = makeUpdateEnvironment({ flushPendingWrites });
    const deferral = createAppUpdateDeferral();

    await runAppUpdateCheck({ client, deferral, environment });

    // Nobody asked for this restart, so it must not discard the state it
    // failed to land; the rollback waits armed for the next backgrounding.
    expect(client.reloadAsync).not.toHaveBeenCalled();
    expect(deferral.pendingInstall).toBe(true);
    expect(backgroundCallbacks).toHaveLength(1);

    flushPendingWrites.mockResolvedValue(undefined);
    backgroundCallbacks[0]!();
    await vi.waitFor(() => expect(client.reloadAsync).toHaveBeenCalledOnce());
    reportError.mockRestore();
  });

  it("still restarts a user-requested install when the flush fails", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeAvailableUpdateClient();
    const { environment } = makeUpdateEnvironment({
      flushPendingWrites: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });

    await runAppUpdateCheck({
      applyMode: "immediate",
      client,
      deferral: createAppUpdateDeferral(),
      environment,
    });

    expect(client.reloadAsync).toHaveBeenCalledOnce();
    reportError.mockRestore();
  });

  it("restarts into the embedded bundle for a rollback directive", async () => {
    const client = makeUpdateClient({
      checkForUpdateAsync: vi.fn(async () => ({
        isAvailable: false,
        isRollBackToEmbedded: true,
      })),
      fetchUpdateAsync: vi.fn(async () => ({
        isNew: false,
        isRollBackToEmbedded: true,
      })),
    });
    const { environment } = makeUpdateEnvironment();

    await runAppUpdateCheck({ client, deferral: createAppUpdateDeferral(), environment });

    expect(client.fetchUpdateAsync).toHaveBeenCalledOnce();
    // A rollback pulls a broken bundle, so it never waits on the prompt.
    expect(environment.confirmInstallNow).not.toHaveBeenCalled();
    expect(client.reloadAsync).toHaveBeenCalledOnce();
  });
});
