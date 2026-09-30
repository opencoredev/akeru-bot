import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { useBotThreadRuntime } from "./useBotThreadRuntime";

const environmentId = EnvironmentId.make("env-a");

const mocks = vi.hoisted(() => {
  const roster = {
    bots: [] as unknown[],
    chatPathByBotId: {} as Record<string, string>,
    openChatByBotId: {} as Record<string, string>,
    recordChatPath: (botId: string, path: string) => {
      roster.chatPathByBotId = { ...roster.chatPathByBotId, [botId]: path };
    },
    openBotChat: (botId: string, threadId: string | null, chatPath?: string) => {
      if (chatPath !== undefined) roster.recordChatPath(botId, chatPath);
      const openChatByBotId = { ...roster.openChatByBotId };
      if (threadId === null) delete openChatByBotId[botId];
      else openChatByBotId[botId] = threadId;
      roster.openChatByBotId = openChatByBotId;
    },
    recordLastMessage: () => undefined,
  };
  return {
    roster,
    threadShells: [] as Array<Record<string, unknown>>,
    commands: {
      create: Symbol("create"),
      startTurn: Symbol("startTurn"),
    },
    createThread: vi.fn(),
    startTurn: vi.fn(),
    otherCommand: vi.fn(),
  };
});

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
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [{ id: "bot-1" }] }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => ({ localExecutionMode: "full-access" }),
}));
vi.mock("../../modelSelection", () => ({
  resolveAppModelSelectionState: () => ({ provider: "codex", model: "gpt" }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "env-a", id: "project-1", defaultModelSelection: null }],
  useThreadShells: () => mocks.threadShells,
  useAllEnvironmentShellsBootstrapped: () => true,
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    (ref &&
      mocks.threadShells.find(
        (shell) => shell.environmentId === ref.environmentId && shell.id === ref.threadId,
      )) ??
    null,
  useThreadMessages: () => [{ role: "user", createdAt: "2026-09-01T00:00:00.000Z" }],
  useThreadActivities: () => [],
  readEnvironmentSupportsFileAttachments: () => true,
}));
vi.mock("../../state/bots", () => ({ environmentBotsAtom: () => null }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env-a" }));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: null }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { create: mocks.commands.create, startTurn: mocks.commands.startTurn },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === mocks.commands.create
      ? mocks.createThread
      : command === mocks.commands.startTurn
        ? mocks.startTurn
        : mocks.otherCommand,
}));
vi.mock("../../session-logic", () => ({ derivePendingUserInputs: () => [] }));
vi.mock("../Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: unknown[]) => projects,
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }) }));
vi.mock("./rosterStore", () => {
  const useRosterStore = (selector: (state: typeof mocks.roster) => unknown) =>
    selector(mocks.roster);
  useRosterStore.getState = () => mocks.roster;
  return { useRosterStore };
});

function chatShell(id: string, updatedAt: string) {
  return {
    environmentId,
    id: ThreadId.make(id),
    botId: "bot-1",
    parentThreadId: null,
    archivedAt: null,
    runtimeMode: "full-access",
    updatedAt,
    createdAt: updatedAt,
  };
}

function render() {
  hooks.beginRender();
  return useBotThreadRuntime("bot-1", null);
}

function deferredCreate() {
  let resolve!: (value: { _tag: "Success"; value: undefined }) => void;
  mocks.createThread.mockReturnValueOnce(
    new Promise((settle) => {
      resolve = settle;
    }),
  );
  return () => resolve({ _tag: "Success", value: undefined });
}

const startedThreadIds = () =>
  mocks.startTurn.mock.calls.map(
    ([call]) => (call as { input: { threadId: string } }).input.threadId,
  );

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  mocks.roster.chatPathByBotId = {};
  mocks.roster.openChatByBotId = {};
  mocks.threadShells = [
    chatShell("older", "2026-09-01T00:00:00.000Z"),
    chatShell("newest", "2026-09-02T00:00:00.000Z"),
  ];
  mocks.startTurn.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.otherCommand.mockResolvedValue({ _tag: "Success", value: undefined });
});

describe("New chat while another chat is opened", () => {
  it("keeps the opened chat and sends into it when creation finishes later", async () => {
    const finishCreate = deferredCreate();
    const creating = render().startNewChat();

    mocks.roster.openBotChat("bot-1", "older", "/env-a/older");
    const sending = render().send("hello older", []);
    finishCreate();

    expect(await creating).toBe(true);
    expect(await sending).toBe(true);
    expect(startedThreadIds()).toEqual(["older"]);
    expect(mocks.roster.openChatByBotId["bot-1"]).toBe("older");
    expect(mocks.roster.chatPathByBotId["bot-1"]).toBe("/env-a/older");
  });

  it("delivers a send typed before the switch to the new chat without leaving the opened chat", async () => {
    const finishCreate = deferredCreate();
    const runtime = render();
    const creating = runtime.startNewChat();
    const sending = runtime.send("hello new", []);

    mocks.roster.openBotChat("bot-1", "older", "/env-a/older");
    render();
    finishCreate();

    expect(await creating).toBe(true);
    expect(await sending).toBe(true);
    const createdId = (mocks.createThread.mock.calls[0]![0] as { input: { threadId: string } })
      .input.threadId;
    expect(startedThreadIds()).toEqual([createdId]);
    expect(mocks.roster.openChatByBotId["bot-1"]).toBe("older");
    expect(mocks.roster.chatPathByBotId["bot-1"]).toBe("/env-a/older");
  });

  it("adopts the new chat when the opened chat's pin is released automatically", async () => {
    mocks.roster.openBotChat("bot-1", "older", "/env-a/older");
    const finishCreate = deferredCreate();
    const creating = render().startNewChat();

    // Another turn makes the opened chat the newest, so its pin is released.
    mocks.roster.openBotChat("bot-1", null, "/env-a/older");
    const sending = render().send("hello new", []);
    finishCreate();

    expect(await creating).toBe(true);
    expect(await sending).toBe(true);
    const createdId = (mocks.createThread.mock.calls[0]![0] as { input: { threadId: string } })
      .input.threadId;
    expect(startedThreadIds()).toEqual([createdId]);
    expect(mocks.roster.openChatByBotId["bot-1"]).toBeUndefined();
    expect(mocks.roster.chatPathByBotId["bot-1"]).toBe(`/env-a/${createdId}`);
  });

  it("switches to the new chat when nothing else was opened meanwhile", async () => {
    const finishCreate = deferredCreate();
    const runtime = render();
    const creating = runtime.startNewChat();
    const sending = runtime.send("hello new", []);
    finishCreate();

    expect(await creating).toBe(true);
    expect(await sending).toBe(true);
    const createdId = (mocks.createThread.mock.calls[0]![0] as { input: { threadId: string } })
      .input.threadId;
    expect(startedThreadIds()).toEqual([createdId]);
    expect(mocks.roster.chatPathByBotId["bot-1"]).toBe(`/env-a/${createdId}`);
  });
});

describe("Opening another chat while a send reads its attachments", () => {
  it("sends into the chat where the message was submitted and keeps the newly opened chat", async () => {
    const readers: Array<() => void> = [];
    class DeferredFileReader extends EventTarget {
      result: string | null = null;
      error: Error | null = null;
      readAsDataURL() {
        readers.push(() => {
          this.result = "data:image/png;base64,AAAA";
          this.dispatchEvent(new Event("load"));
        });
      }
    }
    vi.stubGlobal("FileReader", DeferredFileReader);
    try {
      mocks.roster.openBotChat("bot-1", "older", "/env-a/newest");
      const sending = render().send("look at this", [
        new File(["png"], "shot.png", { type: "image/png" }),
      ]);

      mocks.roster.openBotChat("bot-1", "newest", "/env-a/newest");
      render();
      await vi.waitFor(() => expect(readers).toHaveLength(1));
      readers[0]!();

      expect(await sending).toBe(true);
      expect(startedThreadIds()).toEqual(["older"]);
      expect(mocks.roster.openChatByBotId["bot-1"]).toBe("newest");
      expect(mocks.roster.chatPathByBotId["bot-1"]).toBe("/env-a/newest");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
