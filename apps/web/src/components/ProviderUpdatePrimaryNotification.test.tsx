import type { ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({
  environmentId: "environment-a" as EnvironmentId,
  providers: [] as ServerProvider[],
  updateProvider: vi.fn(),
  openSettings: vi.fn(),
  dismissNotificationKey: vi.fn(),
  toasts: [] as Array<Record<string, unknown>>,
  closedToastIds: [] as string[],
  notificationVersion: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => state.providers,
}));

vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: Symbol("primaryServerProvidersAtom"),
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: state.environmentId }),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => state.updateProvider,
}));

vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: new Set<string>(),
    dismissNotificationKey: state.dismissNotificationKey,
  }),
}));

vi.mock("~/settingsDialogStore", () => ({
  openSettings: state.openSettings,
}));

vi.mock("./ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  stackedThreadToast: (input: Record<string, unknown>) => input,
  toastManager: {
    add: (input: Record<string, unknown>) => {
      state.toasts.push(input);
      return `toast-${state.toasts.length}`;
    },
    close: (toastId: string) => state.closedToastIds.push(toastId),
  },
}));

import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

const providerInstanceId = ProviderInstanceId.make("codex");

function provider(updateState?: ServerProvider["updateState"]): ServerProvider {
  return {
    instanceId: providerInstanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-30T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: `1.1.${state.notificationVersion}`,
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-08-30T12:00:00.000Z",
      message: "Update available.",
    },
    ...(updateState ? { updateState } : {}),
  };
}

function renderNotification() {
  hooks.beginRender();
  return ProviderUpdatePrimaryNotification() as ReactElement | null;
}

describe("ProviderUpdatePrimaryNotification", () => {
  beforeEach(() => {
    hooks.reset();
    state.environmentId = EnvironmentId.make("environment-a");
    state.providers = [provider()];
    state.updateProvider.mockReset().mockReturnValue(new Promise(() => {}));
    state.openSettings.mockReset();
    state.dismissNotificationKey.mockReset();
    state.toasts = [];
    state.closedToastIds = [];
    state.notificationVersion += 1;
  });

  it("uses an outline action for routine update notices", () => {
    renderNotification();

    expect(state.toasts[0]).toMatchObject({ actionVariant: "outline" });
  });

  it("opens repair settings for the environment where the update started", async () => {
    let finishUpdate!: () => void;
    state.updateProvider.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve(AsyncResult.failure(Cause.die(new Error("Update failed"))));
        }),
    );
    renderNotification();

    const prompt = state.toasts[0] as {
      actionProps?: { onClick?: () => void };
    };
    prompt.actionProps?.onClick?.();

    state.environmentId = EnvironmentId.make("environment-b");
    renderNotification();
    expect(state.toasts).toHaveLength(1);

    finishUpdate();
    await Promise.resolve();
    await Promise.resolve();

    const repairToast = state.toasts[1] as {
      actionProps?: { onClick?: () => void };
    };
    repairToast.actionProps?.onClick?.();

    expect(state.openSettings).toHaveBeenCalledWith(
      "providers",
      null,
      EnvironmentId.make("environment-a"),
    );
    expect(state.openSettings).not.toHaveBeenCalledWith(
      "providers",
      null,
      EnvironmentId.make("environment-b"),
    );
  });
});
