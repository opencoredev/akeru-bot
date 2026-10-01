import { vi } from "vite-plus/test";
import type { AppUpdateClient, AppUpdateEnvironment } from "./app-updates";

export function makeUpdateClient(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    isEnabled: true,
    checkForUpdateAsync: vi.fn(async () => ({
      isAvailable: false,
      isRollBackToEmbedded: false,
    })),
    fetchUpdateAsync: vi.fn(async () => ({
      isNew: true,
      isRollBackToEmbedded: false,
    })),
    reloadAsync: vi.fn(async () => {}),
    ...overrides,
  };
}

export function makeUpdateEnvironment(overrides: Partial<AppUpdateEnvironment> = {}): {
  readonly backgroundCallbacks: Array<() => void>;
  readonly environment: AppUpdateEnvironment;
  readonly foregroundStayCallbacks: Array<() => void>;
} {
  const backgroundCallbacks: Array<() => void> = [];
  const foregroundStayCallbacks: Array<() => void> = [];

  return {
    backgroundCallbacks,
    foregroundStayCallbacks,
    environment: {
      confirmInstallNow: vi.fn(async () => true),
      flushPendingWrites: vi.fn(async () => {}),
      isSafeToRestartInBackground: vi.fn(async () => true),
      onNextBackground: vi.fn((apply: () => void, _includeCurrent: boolean) => {
        backgroundCallbacks.push(apply);
      }),
      onForegroundStay: vi.fn((apply: () => void) => {
        foregroundStayCallbacks.push(apply);
      }),
      ...overrides,
    },
  };
}

export function makeAvailableUpdateClient(
  overrides: Partial<AppUpdateClient> = {},
): AppUpdateClient {
  return makeUpdateClient({
    checkForUpdateAsync: vi.fn(async () => ({
      isAvailable: true,
      isRollBackToEmbedded: false,
    })),
    ...overrides,
  });
}
