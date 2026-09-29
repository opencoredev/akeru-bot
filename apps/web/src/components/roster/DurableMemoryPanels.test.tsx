import {
  DURABLE_MEMORY_EXPORT_SCOPES,
  type DurableImportReviewItem,
  type DurableMemoryExportScope,
  type DurableMemoryFact,
  type ImportConflictDecision,
  resolveImportConflicts,
} from "@t3tools/client-runtime/durable-memory";
import type { AkeruMemoryImportPreview } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DurableFactList, DurableImportReview, DurableScopePicker } from "./DurableMemoryPanels";

import { Button } from "../ui/button";

type ButtonElement = ReactElement<{
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  "aria-checked"?: boolean;
  "aria-pressed"?: boolean;
}>;

// The panels are stateless, so their rendered element trees expose every button handler directly.
function buttons(node: ReactNode): ButtonElement[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === Button) return [node as ButtonElement];
  return buttons(node.props.children);
}

function button(node: ReactNode, label: string, index = 0) {
  const match = buttons(node).filter((item) => item.props.children === label)[index];
  if (!match) throw new Error(`No "${label}" button`);
  return match;
}

const conflict = (rootId: string, localFact: string, archiveFact: string) =>
  ({
    rootId,
    classification: "conflicting",
    reason: "Local and archive histories diverge.",
    localFact,
    archiveFact,
  }) as unknown as DurableImportReviewItem;

describe("DurableImportReview conflict choices", () => {
  const preview = {
    previewHash: "a".repeat(64),
    items: [
      { rootId: "m1", classification: "conflicting", reason: "" },
      { rootId: "m2", classification: "new", reason: "" },
      { rootId: "m3", classification: "conflicting", reason: "" },
    ],
  } as unknown as AkeruMemoryImportPreview;
  const groups = [
    {
      classification: "conflicting" as const,
      items: [
        conflict("m1", "Prefers tea.", "Prefers coffee."),
        conflict("m3", "Lives in Oslo.", "Lives in Bergen."),
      ],
    },
    {
      classification: "new" as const,
      items: [
        {
          rootId: "m2",
          classification: "new",
          reason: "Missing locally.",
          localFact: null,
          archiveFact: "Works in UTC.",
        } as unknown as DurableImportReviewItem,
      ],
    },
  ];

  it("gives each conflict its own choice and applies only after every choice", () => {
    const onApply = vi.fn();
    let choices: Record<string, ImportConflictDecision> = {};
    const render = () => {
      const resolution = resolveImportConflicts(preview, choices);
      return DurableImportReview({
        groups,
        choices,
        unresolvedCount: resolution.ready ? 0 : resolution.unresolved.length,
        busy: false,
        onChoose: (rootId, decision) => {
          choices = { ...choices, [rootId]: decision };
        },
        onApply,
        onCancel: () => {},
      });
    };

    let tree = render();
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("Conflicts (2)");
    expect(markup).toContain("New (1)");
    expect(markup).toContain("Yours: Prefers tea.");
    expect(markup).toContain("Archive: Prefers coffee.");
    expect(markup).toContain("Choose a version for 2 conflicts");
    expect(buttons(tree).filter((item) => item.props.children === "Keep mine")).toHaveLength(2);
    expect(button(tree, "Apply import").props.disabled).toBe(true);

    button(tree, "Use archive", 0).props.onClick();
    tree = render();
    expect(button(tree, "Use archive", 0).props["aria-checked"]).toBe(true);
    expect(button(tree, "Keep mine", 1).props["aria-checked"]).toBe(false);
    expect(button(tree, "Apply import").props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain("Choose a version for 1 conflict ");

    button(tree, "Keep mine", 1).props.onClick();
    tree = render();
    expect(button(tree, "Apply import").props.disabled).toBe(false);
    expect(resolveImportConflicts(preview, choices)).toEqual({
      ready: true,
      resolutions: [
        { rootId: "m1", decision: "use-archive" },
        { rootId: "m3", decision: "keep-local" },
      ],
    });
    button(tree, "Apply import").props.onClick();
    expect(onApply).toHaveBeenCalledOnce();
  });
});

describe("DurableScopePicker", () => {
  it("offers every export scope and reports the selected one", () => {
    let value: DurableMemoryExportScope = "bot";
    const render = () =>
      DurableScopePicker({
        label: "Durable export scope",
        options: DURABLE_MEMORY_EXPORT_SCOPES,
        value,
        onChange: (scope) => {
          value = scope;
        },
      });
    let tree = render();
    expect(buttons(tree).map((item) => item.props.children)).toEqual([
      "This chat",
      "This bot",
      "This project",
      "All memory",
    ]);
    expect(button(tree, "This bot").props["aria-pressed"]).toBe(true);

    button(tree, "All memory").props.onClick();
    tree = render();
    expect(value).toBe("all");
    expect(button(tree, "All memory").props["aria-pressed"]).toBe(true);
    expect(button(tree, "This bot").props["aria-pressed"]).toBe(false);
  });
});

const listedFact = (overrides: Partial<Record<keyof DurableMemoryFact, unknown>> = {}) =>
  ({
    rootId: "m1",
    fact: "Prefers detailed replies.",
    scope: "bot-user",
    sourceThreadId: "thread-1",
    affectedBotIds: ["bot-1", "bot-2"],
    approvalState: "pending",
    deletionState: "active",
    pinned: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    revision: 2,
    supersededFact: "Prefers short replies.",
    ...overrides,
  }) as unknown as DurableMemoryFact;

function renderFactList(
  props: Partial<Parameters<typeof DurableFactList>[0]> & {
    readonly facts: ReadonlyArray<DurableMemoryFact>;
  },
) {
  return DurableFactList({
    currentThreadId: "thread-1",
    currentBotId: "bot-1",
    threadTitles: new Map([["thread-2", "Launch plan"]]),
    botNames: new Map([["bot-2", "Iris"]]),
    policy: { canOperate: true, memoryEnabled: true, privateBotMemory: true },
    busyRootId: null,
    editing: null,
    confirmingDeleteRootId: null,
    onIntent: () => {},
    onStartEdit: () => {},
    onDraftChange: () => {},
    onCancelEdit: () => {},
    onRequestDelete: () => {},
    onCancelDelete: () => {},
    ...props,
  });
}

const labels = (tree: ReactNode) => buttons(tree).map((item) => item.props.children);

describe("DurableFactList", () => {
  it("shows scope, provenance, approval, times, and the replaced value", () => {
    const markup = renderToStaticMarkup(renderFactList({ facts: [listedFact()] }));
    expect(markup).toContain("Prefers detailed replies.");
    expect(markup).toContain("Prefers short replies.");
    expect(markup).toContain("Bot, about you");
    expect(markup).toContain("Waiting for approval, Pinned");
    expect(markup).toContain("this chat");
    expect(markup).toContain("this bot, Iris");
    expect(markup).not.toContain("revision");
    expect(markup).not.toContain("bot-2");
    expect(renderToStaticMarkup(renderFactList({ facts: [] }))).toContain(
      "No durable facts in this scope yet.",
    );
  });

  it("offers the actions each state allows and sends their intents", () => {
    const onIntent = vi.fn();
    const pending = listedFact();
    const tree = renderFactList({ facts: [pending], onIntent });
    expect(labels(tree)).toEqual([
      "Edit",
      "Unpin",
      "Move to this bot",
      "Share with project",
      "Approve",
      "Reject",
      "Forget",
      "Delete",
    ]);
    button(tree, "Unpin").props.onClick();
    button(tree, "Share with project").props.onClick();
    button(tree, "Approve").props.onClick();
    button(tree, "Reject").props.onClick();
    button(tree, "Forget").props.onClick();
    expect(onIntent.mock.calls.map(([, intent]) => intent)).toEqual([
      { action: "unpin" },
      { action: "move", scope: "project" },
      { action: "approve" },
      { action: "reject" },
      { action: "forget" },
    ]);

    const rejected = listedFact({ approvalState: "rejected", pinned: false });
    const rejectedTree = renderFactList({ facts: [rejected] });
    expect(labels(rejectedTree)).toContain("Pin");
    expect(labels(rejectedTree)).toContain("Approve");
    expect(labels(rejectedTree)).not.toContain("Reject");
    expect(renderToStaticMarkup(rejectedTree)).toContain("Rejected");

    const forgotten = listedFact({ approvalState: "approved", deletionState: "tombstoned" });
    const forgottenTree = renderFactList({ facts: [forgotten] });
    expect(labels(forgottenTree)).toEqual(["Delete"]);
    expect(renderToStaticMarkup(forgottenTree)).toContain("Forgotten");
  });

  it("names other chats and bots without their ids", () => {
    const markup = renderToStaticMarkup(
      renderFactList({
        facts: [
          listedFact({ rootId: "m1", sourceThreadId: "thread-2", affectedBotIds: ["bot-9"] }),
          listedFact({ rootId: "m2", sourceThreadId: "thread-9", affectedBotIds: [] }),
        ],
      }),
    );
    expect(markup).toContain("Launch plan");
    expect(markup).toContain("another bot");
    expect(markup).toContain("another chat");
    expect(markup).not.toContain("thread-9");
    expect(markup).not.toContain("bot-9");
  });

  it("omits the source chat row when a fact has no source chat", () => {
    const markup = renderToStaticMarkup(
      renderFactList({ facts: [listedFact({ sourceThreadId: null })] }),
    );
    expect(markup).not.toContain("Source chat");
    expect(markup).not.toContain("unknown chat");
    expect(markup).toContain("Bots");
    expect(renderToStaticMarkup(renderFactList({ facts: [listedFact()] }))).toContain(
      "Source chat",
    );
  });

  it("hides every action for a read-only connection or while Memory is off", () => {
    const open = { canOperate: true, memoryEnabled: true, privateBotMemory: true };
    expect(
      labels(renderFactList({ facts: [listedFact()], policy: { ...open, canOperate: false } })),
    ).toEqual([]);
    expect(
      labels(renderFactList({ facts: [listedFact()], policy: { ...open, memoryEnabled: false } })),
    ).toEqual([]);
  });

  it("offers no bot-private moves while private bot memory is off", () => {
    const tree = renderFactList({
      facts: [listedFact({ scope: "project" })],
      policy: { canOperate: true, memoryEnabled: true, privateBotMemory: false },
    });
    expect(labels(tree)).toEqual(["Edit", "Unpin", "Approve", "Reject", "Forget", "Delete"]);
  });

  it("edits a fact inline and saves only a changed draft", () => {
    const onStartEdit = vi.fn();
    const onIntent = vi.fn();
    const onCancelEdit = vi.fn();
    const fact = listedFact();
    button(renderFactList({ facts: [fact], onStartEdit }), "Edit").props.onClick();
    expect(onStartEdit).toHaveBeenCalledWith(fact);

    const unchanged = renderFactList({
      facts: [fact],
      editing: { rootId: "m1", draft: fact.fact },
      onIntent,
      onCancelEdit,
    });
    expect(labels(unchanged)).toEqual(["Save", "Cancel"]);
    expect(button(unchanged, "Save").props.disabled).toBe(true);
    button(unchanged, "Cancel").props.onClick();
    expect(onCancelEdit).toHaveBeenCalledOnce();

    const changed = renderFactList({
      facts: [fact],
      editing: { rootId: "m1", draft: "Prefers bullet points." },
      onIntent,
    });
    expect(button(changed, "Save").props.disabled).toBe(false);
    button(changed, "Save").props.onClick();
    expect(onIntent).toHaveBeenCalledWith(fact, {
      action: "edit",
      fact: "Prefers bullet points.",
    });
  });

  it("confirms before deleting and can back out", () => {
    const onRequestDelete = vi.fn();
    const onCancelDelete = vi.fn();
    const onIntent = vi.fn();
    const fact = listedFact();
    button(renderFactList({ facts: [fact], onRequestDelete, onIntent }), "Delete").props.onClick();
    expect(onRequestDelete).toHaveBeenCalledWith(fact);
    expect(onIntent).not.toHaveBeenCalled();

    const confirming = renderFactList({
      facts: [fact],
      confirmingDeleteRootId: "m1",
      onCancelDelete,
      onIntent,
    });
    expect(labels(confirming)).toEqual(["Delete for good", "Keep"]);
    expect(renderToStaticMarkup(confirming)).toContain("Delete this fact for good?");
    button(confirming, "Keep").props.onClick();
    expect(onCancelDelete).toHaveBeenCalledOnce();
    button(confirming, "Delete for good").props.onClick();
    expect(onIntent).toHaveBeenCalledWith(fact, { action: "delete" });
  });

  it("closes an open edit or delete confirmation once Memory turns off", () => {
    const off = { canOperate: true, memoryEnabled: false, privateBotMemory: true };
    const fact = listedFact();
    const editing = renderFactList({
      facts: [fact],
      policy: off,
      editing: { rootId: "m1", draft: "Prefers bullet points." },
    });
    expect(labels(editing)).toEqual([]);
    expect(renderToStaticMarkup(editing)).toContain("Prefers detailed replies.");
    const confirming = renderFactList({ facts: [fact], policy: off, confirmingDeleteRootId: "m1" });
    expect(labels(confirming)).toEqual([]);
  });

  it("disables actions while a change is in flight", () => {
    const tree = renderFactList({ facts: [listedFact()], busyRootId: "m1" });
    expect(buttons(tree).every((item) => item.props.disabled)).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(tree)).toContain("Saving…");
  });
});
