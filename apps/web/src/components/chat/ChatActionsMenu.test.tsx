import { EnvironmentId, type OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Item = { disabled?: boolean; onClick?: () => void; variant?: string };

const mocks = vi.hoisted(() => ({
  shell: null as unknown,
  visited: {} as Record<string, string>,
  items: new Map<string, Item>(),
  subTriggers: new Map<string, Item>(),
  actions: {
    rename: vi.fn(),
    regenerateTitle: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    settle: vi.fn(),
    unsettle: vi.fn(),
    snooze: vi.fn(),
    unsnooze: vi.fn(),
    markUnread: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
  },
}));

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("")
    .trim();
}

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => mocks.shell,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
}));
vi.mock("../../hooks/useChatActions", () => ({ useChatActions: () => mocks.actions }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-09-27T12:00" }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (select: (state: unknown) => unknown) =>
    select({ threadLastVisitedAtById: mocks.visited, markThreadVisited: vi.fn() }),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuPopup: ({ children }: { children: ReactNode }) => children,
  MenuSub: ({ children }: { children: ReactNode }) => children,
  MenuSubPopup: ({ children }: { children: ReactNode }) => children,
  MenuSeparator: () => null,
  MenuTrigger: () => null,
  MenuSubTrigger: (props: Item & { children: ReactNode }) => {
    mocks.subTriggers.set(textOf(props.children), props);
    return null;
  },
  MenuItem: (props: Item & { children: ReactNode }) => {
    mocks.items.set(textOf(props.children), props);
    return null;
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  // Renders the trigger element itself, so the pinned mark shows up in markup.
  TooltipTrigger: ({ render }: { render?: ReactNode }) => render ?? null,
  TooltipPopup: () => null,
}));

import { buildChatPaletteActions, ChatActionsMenu } from "./ChatActionsMenu";
import { resolveChatMenuState } from "./chatActions.logic";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Trip plans",
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-09-27T10:00:00.000Z",
      startedAt: "2026-09-27T10:00:01.000Z",
      completedAt: "2026-09-27T10:01:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T10:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-09-27T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as OrchestrationThreadShell;
}

function render(props: Parameters<typeof ChatActionsMenu>[0] = { threadRef }): string {
  mocks.items.clear();
  mocks.subTriggers.clear();
  return renderToStaticMarkup(<ChatActionsMenu {...props} />);
}

beforeEach(() => {
  mocks.shell = shell();
  mocks.visited = {
    [`${threadRef.environmentId}:${threadRef.threadId}`]: "2026-09-27T10:01:00.000Z",
  };
  for (const action of Object.values(mocks.actions)) action.mockReset();
});

const SNOOZE_PRESETS = ["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"];

/** Menu rows in order, with snooze presets (whose times follow the clock) folded away. */
function menuLabels(): string[] {
  return [...mocks.items.keys()].filter(
    (label) => !SNOOZE_PRESETS.some((preset) => label.startsWith(preset)),
  );
}

function click(label: string): void {
  const item = mocks.items.get(label);
  expect(item, label).toBeDefined();
  expect(item?.disabled ?? false, `${label} is disabled`).toBe(false);
  item?.onClick?.();
}

describe("ChatActionsMenu", () => {
  it("renders nothing before the bot has a chat", () => {
    mocks.shell = null;
    expect(render()).toBe("");
    expect(mocks.items.size).toBe(0);
  });

  it("offers each way in for an idle chat and runs it on the open chat", () => {
    render();

    expect(menuLabels()).toEqual([
      "Rename chat",
      "Regenerate title",
      "Pin chat",
      "Mark unread",
      "Settle chat",
      "Archive chat",
      "Delete chat",
    ]);
    expect(mocks.subTriggers.get("Snooze")?.disabled).toBe(false);

    click("Pin chat");
    click("Mark unread");
    click("Settle chat");
    click("Archive chat");
    click("Delete chat");
    expect(mocks.actions.pin).toHaveBeenCalledWith(threadRef);
    expect(mocks.actions.markUnread).toHaveBeenCalledWith(threadRef);
    expect(mocks.actions.settle).toHaveBeenCalledWith(threadRef);
    expect(mocks.actions.archive).toHaveBeenCalledWith(threadRef);
    expect(mocks.actions.delete).toHaveBeenCalledWith(threadRef);
    expect(mocks.items.get("Delete chat")?.variant).toBe("destructive");
  });

  it("snoozes until the chosen preset", () => {
    render();
    const preset = [...mocks.items.entries()].find(([label]) => label.startsWith("Tomorrow"));
    preset?.[1].onClick?.();

    expect(mocks.actions.snooze).toHaveBeenCalledTimes(1);
    const [ref, until] = mocks.actions.snooze.mock.calls[0] ?? [];
    expect(ref).toEqual(threadRef);
    expect(Date.parse(until)).toBeGreaterThan(Date.now());
  });

  it("shows pinned, settled, and snoozed chats with the way back out", () => {
    mocks.shell = shell({
      pinnedAt: "2026-09-27T11:00:00.000Z",
      settledOverride: "settled",
      settledAt: "2026-09-27T11:00:00.000Z",
      snoozedUntil: "2999-01-01T09:00:00.000Z",
    });
    const markup = render();

    expect(markup).toContain('aria-label="Pinned"');
    expect(markup).toContain("Snoozed until");
    expect(menuLabels()).toEqual([
      "Rename chat",
      "Regenerate title",
      "Unpin chat",
      "Mark unread",
      "Un-settle chat",
      "Wake chat",
      "Archive chat",
      "Delete chat",
    ]);
    expect(mocks.subTriggers.size).toBe(0);

    click("Unpin chat");
    click("Un-settle chat");
    click("Wake chat");
    expect(mocks.actions.unpin).toHaveBeenCalledWith(threadRef);
    expect(mocks.actions.unsettle).toHaveBeenCalledWith(threadRef);
    expect(mocks.actions.unsnooze).toHaveBeenCalledWith(threadRef);
  });

  it("labels a settled chat that is not snoozed", () => {
    mocks.shell = shell({ settledOverride: "settled", settledAt: "2026-09-27T11:00:00.000Z" });
    expect(render()).toContain('data-testid="chat-state-settled"');
  });

  it("keeps a running chat from being archived or settled", () => {
    mocks.shell = shell({
      session: {
        threadId: "thread-1",
        status: "running",
        activeTurnId: "turn-2",
      } as OrchestrationThreadShell["session"],
    });
    render();

    expect(mocks.items.get("Archive chat")?.disabled).toBe(true);
    expect(mocks.items.get("Settle chat")?.disabled).toBe(true);
    expect(mocks.items.get("Delete chat")?.disabled).toBeUndefined();
  });

  it("offers Mark unread only while the chat reads as seen", () => {
    mocks.visited = {
      [`${threadRef.environmentId}:${threadRef.threadId}`]: "2026-09-27T10:00:59.999Z",
    };
    render();
    expect(mocks.items.get("Mark unread")?.disabled).toBe(true);
  });

  it("starts a new chat with the bot only once the current chat has messages", () => {
    const start = vi.fn(async () => true);
    render({ threadRef, newChat: { canStart: false, start } });
    expect(mocks.items.get("New chat")?.disabled).toBe(true);

    render({ threadRef, newChat: { canStart: true, start } });
    expect(menuLabels()[0]).toBe("New chat");
    click("New chat");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("buildChatPaletteActions", () => {
  const t = ((message: string, params?: Record<string, string | number>) =>
    message.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key]))) as Parameters<
    typeof buildChatPaletteActions
  >[0]["t"];

  function paletteActions(overrides: Partial<OrchestrationThreadShell> = {}) {
    const state = resolveChatMenuState({
      shell: shell(overrides),
      lastVisitedAt: "2026-09-27T10:01:00.000Z",
      now: "2026-09-27T12:00:00.000Z",
      supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
    });
    return buildChatPaletteActions({
      threadRef,
      state,
      newChat: null,
      actions: mocks.actions as unknown as Parameters<typeof buildChatPaletteActions>[0]["actions"],
      t,
      now: new Date("2026-09-27T12:00:00.000Z"),
      openRename: vi.fn(),
    });
  }

  it("offers each snooze preset with its wake time and snoozes from now", async () => {
    const actions = paletteActions();
    const snoozes = actions.filter((action) => action.id.startsWith("snooze:"));

    expect(snoozes.map((action) => action.title)).toContain("Snooze chat: Tomorrow");
    expect(snoozes.length).toBeGreaterThanOrEqual(4);
    expect(snoozes.every((action) => (action.description ?? "").length > 0)).toBe(true);
    expect(actions.some((action) => action.id === "unsnooze")).toBe(false);

    await snoozes.find((action) => action.id === "snooze:tomorrow")?.run();
    const [ref, until] = mocks.actions.snooze.mock.calls[0] ?? [];
    expect(ref).toEqual(threadRef);
    expect(Date.parse(until)).toBeGreaterThan(Date.now());
  });

  it("offers Wake chat instead of the presets while the chat is snoozed", async () => {
    const actions = paletteActions({ snoozedUntil: "2999-01-01T09:00:00.000Z" });

    expect(actions.some((action) => action.id.startsWith("snooze:"))).toBe(false);
    await actions.find((action) => action.id === "unsnooze")?.run();
    expect(mocks.actions.unsnooze).toHaveBeenCalledWith(threadRef);
  });
});
