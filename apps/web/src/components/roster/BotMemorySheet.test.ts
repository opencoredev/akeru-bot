import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controls = vi.hoisted(() => ({
  buttons: [] as Array<{ readonly label: string; readonly onClick?: () => void }>,
  inspect: vi.fn(() => "inspect"),
  mutate: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: {} })),
  query: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../ui/button", async () => {
  const React = await import("react");
  return {
    Button: ({ children, onClick, ...props }: React.ComponentProps<"button">) => {
      const label = React.Children.toArray(children)
        .filter((child): child is string => typeof child === "string")
        .join("")
        .trim();
      controls.buttons.push({ label, ...(onClick ? { onClick: () => onClick({} as never) } : {}) });
      return React.createElement("button", { ...props, onClick }, children);
    },
  };
});
vi.mock("../ui/sheet", async () => {
  const React = await import("react");
  const Wrapper = ({ children }: { readonly children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Sheet: Wrapper,
    SheetHeader: Wrapper,
    SheetPanel: Wrapper,
    SheetPopup: Wrapper,
    SheetTitle: Wrapper,
  };
});
vi.mock("../../state/memory", () => ({
  memoryEnvironment: { inspect: controls.inspect, mutate: "mutate" },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: controls.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => controls.mutate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: controls.toast } }));

import { BotMemorySheet } from "./BotMemorySheet";

const candidate = {
  candidateId: "candidate-1",
  tenantId: "local",
  initiatingUserId: "owner",
  sourceThreadId: "thread-1",
  sourceMessageId: null,
  authorBotId: "bot-1",
  fact: "Pending fact",
  scope: "private",
  sensitive: false,
  confidence: 0.9,
  affectedBotIds: ["bot-1"],
  status: "pending",
  createdAt: "2026-08-31T00:00:00.000Z",
  decidedAt: null,
  decidedMemoryRootId: null,
} as const;

const revision = {
  id: "revision-1",
  rootId: "root-1",
  revision: 1,
  partition: { tenantId: "local", scope: "bot", partitionId: "bot-1" },
  entityKind: "bot",
  entityId: "bot-1",
  kind: "fact",
  value: {},
  fact: "Durable fact",
  sourceThreadId: "thread-1",
  sourceMessageId: null,
  authorBotId: "bot-1",
  initiatingUserId: "owner",
  createdAt: "2026-08-31T00:00:00.000Z",
  confirmedAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  confidence: 1,
  approvalState: "approved",
  supersedesId: null,
  supersededById: null,
  visibility: "private",
  deletionState: "active",
  pinned: false,
  sensitive: false,
  affectedBotIds: ["bot-1"],
} as const;

describe("BotMemorySheet", () => {
  beforeEach(() => {
    controls.buttons.length = 0;
    controls.inspect.mockClear();
    controls.mutate.mockClear();
    controls.query.mockReturnValue({
      data: {
        threadId: "thread-1",
        durable: [revision],
        histories: [{ rootId: "root-1", revisions: [revision] }],
        pending: [candidate],
        conversation: {
          current: { activeObservations: "Thread observation" },
          history: [],
        },
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    });
    vi.stubGlobal("window", {
      confirm: vi.fn(() => true),
      prompt: vi.fn(() => "Edited fact"),
    });
  });

  it("does not inspect memory while closed", () => {
    renderToStaticMarkup(
      createElement(BotMemorySheet, {
        open: false,
        onOpenChange: vi.fn(),
        threadRef: {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        },
      }),
    );

    expect(controls.inspect).not.toHaveBeenCalled();
  });

  it("inspects and renders memory while open", () => {
    const markup = renderToStaticMarkup(
      createElement(BotMemorySheet, {
        open: true,
        onOpenChange: vi.fn(),
        threadRef: {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        },
      }),
    );
    expect(markup).toContain("Thread observation");
    expect(markup).toContain("Pending fact");
    expect(markup).toContain("Durable fact");
    expect(controls.inspect).toHaveBeenCalledOnce();
  });
});
