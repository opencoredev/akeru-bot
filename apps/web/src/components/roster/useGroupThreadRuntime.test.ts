import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { useGroupThreadRuntime } from "./useGroupThreadRuntime";

const mocks = vi.hoisted(() => ({
  primaryEnvironmentId: "env-a" as EnvironmentId,
  threadShells: [] as Array<Record<string, unknown>>,
  threadShell: null as Record<string, unknown> | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => ({}) }));
vi.mock("../../modelSelection", () => ({ resolveAppModelSelectionState: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => mocks.threadShells,
  useAllEnvironmentShellsBootstrapped: () => true,
  useThreadShell: () => mocks.threadShell,
  useThreadMessages: () => [],
  useThreadActivities: () => [],
  readEnvironmentSupportsFileAttachments: () => true,
}));
vi.mock("../../state/bots", () => ({ environmentGroupsAtom: () => null }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
}));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: null }));
vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../session-logic", () => ({ derivePendingUserInputs: () => [] }));
vi.mock("../Sidebar.logic", () => ({ sortScopedProjectsForSidebar: () => [] }));
vi.mock("./rosterStore", () => ({
  useRosterStore: (selector: (state: { bots: []; groups: [] }) => unknown) =>
    selector({ bots: [], groups: [] }),
}));

beforeEach(() => {
  hooks.reset();
  mocks.threadShells = [];
  mocks.threadShell = null;
});

describe("group runtime errors", () => {
  it("surfaces the persisted provider error for a failed turn", () => {
    mocks.threadShells = [
      {
        environmentId: mocks.primaryEnvironmentId,
        id: ThreadId.make("thread-1"),
        groupId: "group-1",
        updatedAt: "2026-09-13T00:00:00.000Z",
        archivedAt: null,
      },
    ];
    mocks.threadShell = {
      ...mocks.threadShells[0],
      session: { lastError: "Provider rejected the request." },
    };

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.error).toBe("Provider rejected the request.");
  });
});
