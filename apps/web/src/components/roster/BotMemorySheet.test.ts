import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controls = vi.hoisted(() => ({
  buttons: [] as Array<{ readonly label: string; readonly onClick?: () => void }>,
  inspect: vi.fn(() => "inspect-documents"),
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
  memoryEnvironment: {
    inspectDocuments: controls.inspect,
    replaceDocument: "replace-document",
    clearObservations: "clear-observations",
  },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: controls.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => controls.mutate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: controls.toast } }));

import { BotMemorySheet } from "./BotMemorySheet";

const document = (target: "user" | "memory" | "group", content: string, charLimit: number) => ({
  target,
  content,
  charCount: content.length,
  charLimit,
  updatedAt: "2026-08-31T00:00:00.000Z",
});

describe("BotMemorySheet", () => {
  beforeEach(() => {
    controls.buttons.length = 0;
    controls.inspect.mockClear();
    controls.mutate.mockClear();
    controls.query.mockImplementation((input) => ({
      data: {
        botId: "bot-1",
        groupId: "group-1",
        user: document("user", "The user prefers short answers.", 1_375),
        memory: document("memory", "Use the release checklist.", 2_200),
        group: document("group", "The group ships on Fridays.", 2_200),
        conversation: {
          current: input
            ? {
                generationCount: 2,
                activeObservations: "Thread observation",
                createdAt: "2026-08-31T00:00:00.000Z",
                updatedAt: "2026-08-31T00:00:00.000Z",
              }
            : null,
          history: [],
        },
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }));
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
    expect(markup).toContain("The user prefers short answers.");
    expect(markup).toContain("Use the release checklist.");
    expect(markup).toContain("The group ships on Fridays.");
    expect(controls.inspect).toHaveBeenCalledOnce();
  });
});
