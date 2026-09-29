import { BotId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { Bot, Group } from "./types";
import { useGroupThreadRuntime } from "./useGroupThreadRuntime";

const mocks = vi.hoisted(() => ({
  primaryEnvironmentId: "env-a" as EnvironmentId,
  threadShells: [] as Array<Record<string, unknown>>,
  threadShell: null as Record<string, unknown> | null,
  bots: [] as Bot[],
  groups: [] as Group[],
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
  useRosterStore: (selector: (state: { bots: Bot[]; groups: Group[] }) => unknown) =>
    selector({ bots: mocks.bots, groups: mocks.groups }),
}));

beforeEach(() => {
  hooks.reset();
  mocks.threadShells = [];
  mocks.threadShell = null;
  mocks.bots = [];
  mocks.groups = [];
});

describe("group runtime errors", () => {
  it("allows a configured group bot when the app default has no provider", () => {
    mocks.groups = [
      {
        id: "group-1",
        name: "Project team",
        bossBotId: "bot-1",
        members: [{ kind: "bot", botId: BotId.make("bot-1"), role: "boss" }],
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      },
    ];
    mocks.bots = [
      {
        id: "bot-1",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
      } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.providerAvailable).toBe(true);
  });

  it("allows mentioning a configured member when the boss has no provider", () => {
    mocks.groups = [
      {
        id: "group-1",
        name: "Project team",
        bossBotId: "bot-1",
        members: [
          { kind: "bot", botId: BotId.make("bot-1"), role: "boss" },
          { kind: "bot", botId: BotId.make("bot-2"), role: "specialist" },
        ],
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      },
    ];
    mocks.bots = [
      { id: "bot-1", engine: null } as Bot,
      { id: "bot-2", engine: { provider: "codex", model: "gpt-5.6-sol" } } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.providerAvailable).toBe(true);
  });

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
