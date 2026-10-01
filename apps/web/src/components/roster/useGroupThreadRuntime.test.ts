vi.mock("./botConversationMessageProjection", () => ({
  useBotConversationMessageProjection: () => mocks.messageProjection,
}));
import { BotId, EnvironmentId, ThreadId } from "@akeru/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeComposerTestProvider } from "../../test/composerTestProvider";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import type { Bot, Group } from "./types";
import { useGroupThreadRuntime } from "./useGroupThreadRuntime";
import type { BotConversationMessageProjection } from "./botConversationMessageProjection";

const mocks = vi.hoisted(() => ({
  messageProjection: {
    messages: [],
    lastMessageRole: null,
    hasMessages: false,
    lastUserMessageAt: null,
  } as BotConversationMessageProjection,
  primaryEnvironmentId: "env-a" as EnvironmentId,
  groupAtom: Symbol("groups"),
  startTurnAtom: Symbol("start-turn"),
  providersAtom: Symbol("providers"),
  providers: [] as ReturnType<typeof makeComposerTestProvider>[],
  serverGroups: [] as Array<{ id: string }>,
  projects: [] as Array<Record<string, unknown>>,
  startTurn: null as unknown as ReturnType<typeof vi.fn>,
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
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === mocks.groupAtom
      ? mocks.serverGroups
      : atom === mocks.providersAtom
        ? mocks.providers
        : [],
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../../modelSelection", () => ({ resolveAppModelSelectionState: () => null }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useThreadShells: () => mocks.threadShells,
  useAllEnvironmentShellsBootstrapped: () => true,
  useThreadShell: () => mocks.threadShell,
  useThreadMessages: () => [],
  useThreadActivities: () => [],
  readEnvironmentSupportsFileAttachments: () => true,
}));
vi.mock("../../state/bots", () => ({ environmentGroupsAtom: () => mocks.groupAtom }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
}));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: mocks.providersAtom }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { startTurn: mocks.startTurnAtom },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) =>
    atom === mocks.startTurnAtom ? mocks.startTurn : vi.fn().mockResolvedValue({ _tag: "Success" }),
}));
vi.mock("../../session-logic", () => ({ derivePendingUserInputs: () => [] }));
vi.mock("../Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: unknown) => projects,
}));
vi.mock("./rosterStore", () => ({
  useRosterStore: (selector: (state: { bots: Bot[]; groups: Group[] }) => unknown) =>
    selector({ bots: mocks.bots, groups: mocks.groups }),
}));

beforeEach(() => {
  hooks.reset();
  mocks.messageProjection = {
    messages: [],
    lastMessageRole: null,
    hasMessages: false,
    lastUserMessageAt: null,
  };
  mocks.threadShells = [];
  mocks.threadShell = null;
  mocks.serverGroups = [];
  mocks.projects = [];
  mocks.startTurn = vi.fn().mockResolvedValue({ _tag: "Success" });
  mocks.providers = [makeComposerTestProvider()];
  mocks.bots = [];
  mocks.groups = [];
});

describe("group runtime errors", () => {
  it("reports a newer routine startup failure instead of the previous failed turn", () => {
    mocks.threadShells = [
      {
        environmentId: mocks.primaryEnvironmentId,
        id: ThreadId.make("thread-1"),
        groupId: "group-1",
        archivedAt: null,
        updatedAt: "2026-09-18T01:00:00.000Z",
      },
    ];
    mocks.threadShell = {
      ...mocks.threadShells[0],
      latestTurn: {
        state: "error",
        requestedAt: "2026-09-18T00:00:00.000Z",
        errorMessage: "Previous turn failed.",
      },
      session: { status: "error", lastError: "Routine failed before starting." },
    };
    mocks.messageProjection = {
      messages: [],
      lastMessageRole: "user",
      hasMessages: true,
      lastUserMessageAt: "2026-09-18T01:00:00.000Z",
    };
    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");
    expect(runtime.turnFailure?.message).toBe("Routine failed before starting.");
  });

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
        archivedAt: null,
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
      { id: "bot-1", engine: null, archivedAt: null } as Bot,
      { id: "bot-2", engine: { provider: "codex", model: "gpt-5.6-sol" }, archivedAt: null } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.providerAvailable).toBe(true);
  });

  it("does not count an archived member as an available group provider", () => {
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
      { id: "bot-1", engine: null, archivedAt: null } as Bot,
      {
        id: "bot-2",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        archivedAt: "2026-09-14T00:00:00.000Z",
      } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.providerAvailable).toBe(false);
  });

  it("does not count a disabled provider as available for the group", () => {
    mocks.providers = [{ ...makeComposerTestProvider(), enabled: false, status: "disabled" }];
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
        archivedAt: null,
      } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.providerAvailable).toBe(false);
  });

  it("accepts an explicit specialist when the boss is missing", async () => {
    mocks.serverGroups = [{ id: "group-1" }];
    mocks.projects = [
      {
        id: "project-1",
        environmentId: mocks.primaryEnvironmentId,
        defaultModelSelection: null,
      },
    ];
    mocks.groups = [
      {
        id: "group-1",
        name: "Project team",
        bossBotId: "missing-boss",
        members: [{ kind: "bot", botId: BotId.make("bot-2"), role: "specialist" }],
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      },
    ];
    mocks.bots = [
      {
        id: "bot-2",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        archivedAt: null,
        runtimeMode: "full-access",
      } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.providerAvailable).toBe(true);
    expect(await runtime.send("@Scout, check this", [], "bot-2")).toBe(true);
    expect(mocks.startTurn.mock.calls[0]?.[0].input.respondingBotId).toBe("bot-2");
  });

  it("queues a group follow-up while the first send is still being accepted", async () => {
    let acceptFirst!: () => void;
    let firstStarted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => (acceptFirst = resolve));
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    mocks.startTurn = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstStarted();
        await firstAccepted;
        return { _tag: "Success" };
      })
      .mockResolvedValue({ _tag: "Success" });
    mocks.serverGroups = [{ id: "group-1" }];
    mocks.projects = [
      {
        id: "project-1",
        environmentId: mocks.primaryEnvironmentId,
        defaultModelSelection: null,
      },
    ];
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
        archivedAt: null,
        runtimeMode: "full-access",
      } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");
    const first = runtime.send("Compare A and B", []);
    const followUp = runtime.send("Also include C", []);
    await firstStartedPromise;
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);

    acceptFirst();
    expect(await Promise.all([first, followUp])).toEqual([true, true]);
    expect(mocks.startTurn).toHaveBeenCalledTimes(2);
    const firstInput = mocks.startTurn.mock.calls[0]?.[0].input;
    const secondInput = mocks.startTurn.mock.calls[1]?.[0].input;
    expect(firstInput.bootstrap?.createThread.groupId).toBe("group-1");
    expect(secondInput.bootstrap).toBeUndefined();
    expect(secondInput.threadId).toBe(firstInput.threadId);
  });

  it("keeps a follow-up in the same chat after switching groups mid-send", async () => {
    let acceptFirst!: () => void;
    let firstStarted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => (acceptFirst = resolve));
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    mocks.startTurn = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstStarted();
        await firstAccepted;
        return { _tag: "Success" };
      })
      .mockResolvedValue({ _tag: "Success" });
    mocks.serverGroups = [{ id: "group-1" }, { id: "group-2" }];
    mocks.projects = [
      {
        id: "project-1",
        environmentId: mocks.primaryEnvironmentId,
        defaultModelSelection: null,
      },
    ];
    mocks.groups = ["group-1", "group-2"].map((id) => ({
      id,
      name: id,
      bossBotId: "bot-1",
      members: [{ kind: "bot", botId: BotId.make("bot-1"), role: "boss" }],
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    })) as Group[];
    mocks.bots = [
      {
        id: "bot-1",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        archivedAt: null,
        runtimeMode: "full-access",
      } as Bot,
    ];

    hooks.beginRender();
    const first = useGroupThreadRuntime("group-1").send("Compare A and B", []);
    hooks.beginRender();
    useGroupThreadRuntime("group-2");
    hooks.beginRender();
    const followUp = useGroupThreadRuntime("group-1").send("Also include C", []);
    await firstStartedPromise;

    acceptFirst();
    expect(await Promise.all([first, followUp])).toEqual([true, true]);
    const firstInput = mocks.startTurn.mock.calls[0]?.[0].input;
    const secondInput = mocks.startTurn.mock.calls[1]?.[0].input;
    expect(secondInput.bootstrap).toBeUndefined();
    expect(secondInput.threadId).toBe(firstInput.threadId);
  });

  it("keeps queued first messages in one chat after leaving the group", async () => {
    let acceptFirst!: () => void;
    let firstStarted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => (acceptFirst = resolve));
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    mocks.startTurn = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstStarted();
        await firstAccepted;
        return { _tag: "Success" };
      })
      .mockResolvedValue({ _tag: "Success" });
    mocks.serverGroups = [{ id: "group-1" }, { id: "group-2" }];
    mocks.projects = [
      {
        id: "project-1",
        environmentId: mocks.primaryEnvironmentId,
        defaultModelSelection: null,
      },
    ];
    mocks.groups = ["group-1", "group-2"].map((id) => ({
      id,
      name: id,
      bossBotId: "bot-1",
      members: [{ kind: "bot", botId: BotId.make("bot-1"), role: "boss" }],
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    })) as Group[];
    mocks.bots = [
      {
        id: "bot-1",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        archivedAt: null,
        runtimeMode: "full-access",
      } as Bot,
    ];

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");
    const first = runtime.send("Compare A and B", []);
    const queued = runtime.send("Also include C", []);
    await firstStartedPromise;
    hooks.beginRender();
    useGroupThreadRuntime("group-2");

    acceptFirst();
    expect(await Promise.all([first, queued])).toEqual([true, true]);
    const firstInput = mocks.startTurn.mock.calls[0]?.[0].input;
    const secondInput = mocks.startTurn.mock.calls[1]?.[0].input;
    expect(secondInput.bootstrap).toBeUndefined();
    expect(secondInput.threadId).toBe(firstInput.threadId);
  });

  it("keeps a queued message in its chat when a newer chat appears after switching groups", async () => {
    let acceptFirst!: () => void;
    let firstStarted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => (acceptFirst = resolve));
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    mocks.startTurn = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstStarted();
        await firstAccepted;
        return { _tag: "Success" };
      })
      .mockResolvedValue({ _tag: "Success" });
    mocks.serverGroups = [{ id: "group-1" }, { id: "group-2" }];
    mocks.projects = [
      {
        id: "project-1",
        environmentId: mocks.primaryEnvironmentId,
        defaultModelSelection: null,
      },
    ];
    mocks.groups = ["group-1", "group-2"].map((id) => ({
      id,
      name: id,
      bossBotId: "bot-1",
      members: [{ kind: "bot", botId: BotId.make("bot-1"), role: "boss" }],
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    })) as Group[];
    mocks.bots = [
      {
        id: "bot-1",
        engine: { provider: "codex", model: "gpt-5.6-sol" },
        archivedAt: null,
        runtimeMode: "full-access",
      } as Bot,
    ];
    const chat = (id: string, updatedAt: string) => ({
      environmentId: mocks.primaryEnvironmentId,
      id: ThreadId.make(id),
      groupId: "group-1",
      updatedAt,
      archivedAt: null,
      runtimeMode: "full-access",
    });
    mocks.threadShells = [chat("thread-x", "2026-09-13T00:00:00.000Z")];
    mocks.threadShell = mocks.threadShells[0]!;

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");
    const first = runtime.send("Compare A and B", []);
    const queued = runtime.send("Also include C", []);
    await firstStartedPromise;
    hooks.beginRender();
    useGroupThreadRuntime("group-2");
    // Another device starts a newer chat in the group before the queue drains.
    mocks.threadShells = [
      chat("thread-x", "2026-09-13T00:00:00.000Z"),
      chat("thread-y", "2026-09-13T00:01:00.000Z"),
    ];
    mocks.threadShell = mocks.threadShells[1]!;
    hooks.beginRender();
    useGroupThreadRuntime("group-1");

    acceptFirst();
    expect(await Promise.all([first, queued])).toEqual([true, true]);
    expect(mocks.startTurn.mock.calls[1]?.[0].input.threadId).toBe("thread-x");
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

  it("keeps the server's failure category so the chat can name the fix", () => {
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
      latestTurn: {
        turnId: "turn-1",
        state: "error",
        requestedAt: "2026-09-13T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-09-13T00:00:01.000Z",
        errorMessage: "Claude authentication failed.",
        unavailability: "expired-login",
      },
      session: { status: "error", lastError: "Claude authentication failed." },
    };

    hooks.beginRender();
    const runtime = useGroupThreadRuntime("group-1");

    expect(runtime.failure).toEqual({
      message: "Claude authentication failed.",
      unavailability: "expired-login",
    });
    expect(runtime.error).toBe("Claude authentication failed.");
  });
});
