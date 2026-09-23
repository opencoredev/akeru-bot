import type { DurableMemoryFact } from "@t3tools/client-runtime/durable-memory";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Text: "span",
  TextInput: "input",
  View: "div",
  Pressable: "button",
}));

import { DurableFactsCard } from "./DurableFactsCard";

const fact = {
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
} as unknown as DurableMemoryFact;

type CardProps = Parameters<typeof DurableFactsCard>[0];

const OPEN = { canOperate: true, memoryEnabled: true, privateBotMemory: true };

const cardProps = (overrides: Partial<CardProps> = {}): CardProps => ({
  scope: "bot",
  onScopeChange: () => {},
  facts: [fact],
  error: null,
  isPending: false,
  currentThreadId: "thread-1",
  currentBotId: "bot-1",
  threadTitles: new Map([["thread-2", "Launch plan"]]),
  botNames: new Map([["bot-2", "Iris"]]),
  policy: OPEN,
  failure: null,
  busyRootId: null,
  editing: null,
  onIntent: () => {},
  onStartEdit: () => {},
  onDraftChange: () => {},
  onCancelEdit: () => {},
  onRequestDelete: () => {},
  ...overrides,
});

function render(overrides: Partial<CardProps> = {}) {
  return renderToStaticMarkup(createElement(DurableFactsCard, cardProps(overrides)));
}

describe("mobile durable facts", () => {
  it("renders each fact with scope, provenance, approval, times, and the replaced value", () => {
    const tree = render();
    for (const text of [
      "Durable facts",
      "This chat",
      "This bot",
      "This project",
      "Prefers detailed replies.",
      "Replaced: Prefers short replies.",
      "Bot, about you · Waiting for approval, Pinned",
      "this chat",
      "this bot, Iris",
      "Created ",
      "Updated ",
      "Export or import durable facts from the desktop or web app.",
      "Unpin",
      "Share with project",
      "Approve",
      "Reject",
      "Forget",
      "Delete",
    ]) {
      expect(tree).toContain(text);
    }
    expect(tree).not.toContain("All memory");
    expect(tree).not.toContain("bot-2");
    expect(tree).not.toContain("revision");
  });

  it("names other chats and bots without their ids", () => {
    const tree = render({
      facts: [
        { ...fact, rootId: "m1", sourceThreadId: "thread-2", affectedBotIds: ["bot-9"] },
        { ...fact, rootId: "m2", sourceThreadId: "thread-9", affectedBotIds: [] },
        { ...fact, rootId: "m3", sourceThreadId: null, affectedBotIds: [] },
      ] as unknown as DurableMemoryFact[],
    });
    expect(tree).toContain("From Launch plan · Bots: another bot");
    expect(tree).toContain("From another chat · Bots: none");
    expect(tree).not.toContain("unknown chat");
    expect(tree).not.toContain("thread-9");
    expect(tree).not.toContain("bot-9");
  });

  it("renders loading, empty, and failed states without stale facts", () => {
    expect(render({ facts: null, isPending: true })).toContain("Loading durable facts…");
    expect(render({ facts: [] })).toContain("No durable facts in this scope yet.");
    const failed = render({ error: "socket closed" });
    expect(failed).toContain("Durable facts unavailable.");
    expect(failed).not.toContain("Prefers detailed replies.");
  });

  it("reports the scope a user picks", () => {
    const onScopeChange = vi.fn();
    const tree = DurableFactsCard(cardProps({ onScopeChange, facts: [], currentBotId: null }));
    const tabs = (
      tree.props.children as ReadonlyArray<{
        props?: { children?: ReadonlyArray<{ props: { onPress: () => void } }> };
      }>
    )[2]!.props!.children!;
    tabs[2]!.props.onPress();
    expect(onScopeChange).toHaveBeenCalledWith("project");
  });
});

type ActionElement = { props: { label: string; disabled: boolean; onPress: () => void } };

// The card holds no state, so its element tree exposes every action handler directly.
function actions(node: ReactNode): ActionElement[] {
  if (Array.isArray(node)) return node.flatMap(actions);
  if (!isValidElement<{ children?: ReactNode; label?: string }>(node)) return [];
  if (typeof node.props.label === "string") return [node as unknown as ActionElement];
  return actions(node.props.children);
}

describe("mobile durable fact actions", () => {
  it("sends intents and asks the screen to confirm a delete", () => {
    const onIntent = vi.fn();
    const onRequestDelete = vi.fn();
    const onStartEdit = vi.fn();
    const tree = DurableFactsCard(cardProps({ onIntent, onStartEdit, onRequestDelete }));
    const byLabel = new Map(actions(tree).map((item) => [item.props.label, item]));
    expect([...byLabel.keys()]).toEqual([
      "Edit",
      "Unpin",
      "Move to this bot",
      "Share with project",
      "Approve",
      "Reject",
      "Forget",
      "Delete",
    ]);
    byLabel.get("Unpin")!.props.onPress();
    byLabel.get("Share with project")!.props.onPress();
    byLabel.get("Approve")!.props.onPress();
    byLabel.get("Edit")!.props.onPress();
    byLabel.get("Delete")!.props.onPress();
    expect(onIntent.mock.calls.map(([, intent]) => intent)).toEqual([
      { action: "unpin" },
      { action: "move", scope: "project" },
      { action: "approve" },
    ]);
    expect(onStartEdit).toHaveBeenCalledWith(fact);
    expect(onRequestDelete).toHaveBeenCalledWith(fact);
  });

  it("offers only Delete for a forgotten fact and shows its state", () => {
    const tree = render({
      facts: [{ ...fact, approvalState: "approved", deletionState: "tombstoned", pinned: false }],
    });
    expect(tree).toContain("Approved, Forgotten");
    expect(tree).toContain("Delete");
    expect(tree).not.toContain("Edit");
    expect(tree).not.toContain("Forget<");
  });

  it("shows the edit draft and the last failure", () => {
    const tree = render({
      editing: { rootId: "m1", draft: "Prefers bullet points." },
      failure: "This fact changed somewhere else. The latest version is shown now.",
    });
    expect(tree).toContain('value="Prefers bullet points."');
    expect(tree).toContain("Save");
    expect(tree).toContain("Cancel");
    expect(tree).not.toContain("Unpin");
    expect(tree).toContain("This fact changed somewhere else.");
  });

  it("hides every mutation control for a read-only connection and says why", () => {
    const readOnly = cardProps({ policy: { ...OPEN, canOperate: false } });
    expect(actions(DurableFactsCard(readOnly))).toEqual([]);
    const forgotten = cardProps({
      policy: { ...OPEN, canOperate: false },
      facts: [{ ...fact, deletionState: "tombstoned" }],
    });
    expect(actions(DurableFactsCard(forgotten))).toEqual([]);
    const tree = render({ policy: { ...OPEN, canOperate: false } });
    expect(tree).toContain("This connection can read memory but not change it.");
    expect(tree).toContain("Prefers detailed replies.");
  });

  it("hides every action while Memory is off and says why", () => {
    const off = cardProps({ policy: { ...OPEN, memoryEnabled: false } });
    expect(actions(DurableFactsCard(off))).toEqual([]);
    expect(render({ policy: { ...OPEN, memoryEnabled: false } })).toContain(
      "Memory is off. Turn it on in settings to change facts.",
    );
  });

  it("shows no actions or reason while access is still resolving", () => {
    expect(actions(DurableFactsCard(cardProps({ policy: null })))).toEqual([]);
    const tree = render({ policy: null });
    expect(tree).not.toContain("can read memory");
    expect(tree).not.toContain("Memory is off");
  });

  it("offers no bot-private moves while private bot memory is off", () => {
    const tree = DurableFactsCard(
      cardProps({
        facts: [{ ...fact, scope: "project" }],
        policy: { ...OPEN, privateBotMemory: false },
      }),
    );
    expect(actions(tree).map((item) => item.props.label)).toEqual([
      "Edit",
      "Unpin",
      "Approve",
      "Reject",
      "Forget",
      "Delete",
    ]);
  });

  it("marks only the fact that is saving", () => {
    const other = { ...fact, rootId: "m2", fact: "Uses metric units." } as DurableMemoryFact;
    const tree = render({ facts: [fact, other], busyRootId: "m2" });
    expect(tree.match(/Saving…/g)).toHaveLength(1);
    expect(tree.indexOf("Saving…")).toBeGreaterThan(tree.indexOf("Uses metric units."));
  });
});
