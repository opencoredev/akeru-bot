import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppUpdateLaunchCheck,
  FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS,
  registerHiddenUpdateTap,
  shouldRecheckAppUpdateOnForeground,
} from "./app-updates";
import { makeUpdateClient } from "./app-updates.test-support";

vi.mock("expo-updates", () => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));

describe("createAppUpdateLaunchCheck", () => {
  it("checks at most once for each JavaScript launch", async () => {
    const client = makeUpdateClient();
    const checkOnLaunch = createAppUpdateLaunchCheck(client);

    const first = checkOnLaunch();
    const second = checkOnLaunch();
    await first;

    expect(second).toBeUndefined();
    expect(client.checkForUpdateAsync).toHaveBeenCalledOnce();
  });

  it("does nothing when Expo updates are disabled", () => {
    const client = makeUpdateClient({ isEnabled: false });
    const checkOnLaunch = createAppUpdateLaunchCheck(client);

    expect(checkOnLaunch()).toBeUndefined();
    expect(client.checkForUpdateAsync).not.toHaveBeenCalled();
  });
});

describe("shouldRecheckAppUpdateOnForeground", () => {
  it("requires a meaningful background gap", () => {
    expect(shouldRecheckAppUpdateOnForeground(null, 100_000, false)).toBe(false);
    expect(
      shouldRecheckAppUpdateOnForeground(
        100_000,
        100_000 + FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS - 1,
        false,
      ),
    ).toBe(false);
    expect(
      shouldRecheckAppUpdateOnForeground(
        100_000,
        100_000 + FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS,
        false,
      ),
    ).toBe(true);
  });

  it("stays quiet while a downloaded update waits for its install", () => {
    expect(
      shouldRecheckAppUpdateOnForeground(
        100_000,
        100_000 + FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS,
        true,
      ),
    ).toBe(false);
  });
});

describe("registerHiddenUpdateTap", () => {
  it("unlocks the manual check on the fifth tap", () => {
    let count = 0;

    for (let tap = 1; tap <= 5; tap += 1) {
      const result = registerHiddenUpdateTap(count);
      expect(result.shouldCheck).toBe(tap === 5);
      count = result.nextCount;
    }

    expect(count).toBe(0);
  });
});
