import { BotId, DelegationId, ThreadId, TurnId } from "@t3tools/contracts";
import type { AkeruDelegationRecord, OrchestrationBot } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Text: "span",
  View: "div",
  Pressable: "button",
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => createElement("span", null, props.children),
}));

vi.mock("../../components/BotAvatarView", () => ({
  BotAvatarView: () => createElement("span", { "data-avatar": true }),
  seededBlobAvatar: () => ({ kind: "blob", shape: "circle", color: "#8E8E93" }),
}));

vi.mock("../../lib/i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useMobileI18n: () => ({ ...translator, t: translator.translate }) };
});

import { delegationActions } from "@t3tools/client-runtime/delegation-presentation";

import { ThreadDelegationCard } from "./ThreadDelegationCard";

const delegation = (phase: AkeruDelegationRecord["phase"]): AkeruDelegationRecord => ({
  delegationId: DelegationId.make("d-1"),
  parentDelegationId: null,
  parentBotId: BotId.make("bot-parent"),
  childBotId: BotId.make("bot-child"),
  parentThreadId: ThreadId.make("thread-parent"),
  parentTurnId: TurnId.make("turn-1"),
  ancestorBotIds: [BotId.make("bot-parent")],
  depth: 1,
  task: "Compare three flights.",
  expectedResult: "A short comparison.",
  deadline: null,
  access: {
    allowedToolIds: [],
    memoryScopes: [],
    sandbox: null,
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "none",
  },
  billedBotId: BotId.make("bot-child"),
  keep: false,
  anchorMessageId: null,
  retryOfDelegationId: null,
  trigger: "bot",
  createdAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  phase,
});

const bot = (id: string, name: string): OrchestrationBot =>
  ({ id: BotId.make(id), name, archivedAt: null, avatar: null }) as unknown as OrchestrationBot;

const markup = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("ThreadDelegationCard", () => {
  it("shows the child bot, task, and running state", () => {
    const html = markup(
      createElement(ThreadDelegationCard, {
        delegation: delegation({
          _tag: "Running",
          childThreadId: ThreadId.make("thread-child"),
          childTurnId: null,
          startedAt: "2026-09-25T10:00:30.000Z",
          progress: null,
        }),
        childBot: bot("bot-child", "Scout"),
        parentBot: bot("bot-parent", "Boss"),
      }),
    );

    expect(html).toContain("Scout");
    expect(html).toContain("Compare three flights.");
    expect(html).toContain("running");
    expect(html).not.toContain("allowedToolIds");
  });

  it("shows a delivered result against the parent bot", () => {
    const html = markup(
      createElement(ThreadDelegationCard, {
        delegation: delegation({
          _tag: "Completed",
          childThreadId: ThreadId.make("thread-child"),
          childTurnId: null,
          startedAt: "2026-09-25T10:00:30.000Z",
          completedAt: "2026-09-25T10:05:00.000Z",
          result: {
            summary: "Flight B wins on price.",
            childThreadId: ThreadId.make("thread-child"),
            childTurnId: null,
          },
          acknowledgedAt: "2026-09-25T10:06:00.000Z",
        }),
        childBot: bot("bot-child", "Scout"),
        parentBot: bot("bot-parent", "Boss"),
      }),
    );

    expect(html).toContain("Flight B wins on price.");
    expect(html).toContain("Result delivered to Boss");
  });

  it("marks a pending result as waiting on the next reply", () => {
    const html = markup(
      createElement(ThreadDelegationCard, {
        delegation: delegation({
          _tag: "Failed",
          childThreadId: null,
          childTurnId: null,
          startedAt: null,
          completedAt: "2026-09-25T10:05:00.000Z",
          failure: { failureCode: "child_failed", message: "Child crashed." },
          acknowledgedAt: null,
        }),
        childBot: null,
        parentBot: null,
      }),
    );

    expect(html).toContain("Child crashed.");
    expect(html).toContain("Result waiting for the next reply");
    expect(html).toContain("Unknown bot");
  });

  describe("actions", () => {
    const phases: Record<string, AkeruDelegationRecord["phase"]> = {
      queued: { _tag: "Queued" },
      running: {
        _tag: "Running",
        childThreadId: ThreadId.make("thread-child"),
        childTurnId: null,
        startedAt: "2026-09-25T10:00:30.000Z",
        progress: null,
      },
      failed: {
        _tag: "Failed",
        childThreadId: null,
        childTurnId: null,
        startedAt: null,
        completedAt: "2026-09-25T10:05:00.000Z",
        failure: { failureCode: "child_failed", message: "Child crashed." },
        acknowledgedAt: null,
      },
      canceled: {
        _tag: "Canceled",
        childThreadId: null,
        childTurnId: null,
        startedAt: null,
        completedAt: "2026-09-25T10:05:00.000Z",
        canceledBy: "user",
      },
      completed: {
        _tag: "Completed",
        childThreadId: ThreadId.make("thread-child"),
        childTurnId: null,
        startedAt: "2026-09-25T10:00:30.000Z",
        completedAt: "2026-09-25T10:05:00.000Z",
        result: {
          summary: "Done.",
          childThreadId: ThreadId.make("thread-child"),
          childTurnId: null,
        },
        acknowledgedAt: null,
      },
    };
    const labels = ["Let it finish", "Cancel", "Try again"] as const;
    const rendered = (record: AkeruDelegationRecord, all: ReadonlyArray<AkeruDelegationRecord>) => {
      const html = markup(
        createElement(ThreadDelegationCard, {
          delegation: record,
          childBot: bot("bot-child", "Scout"),
          parentBot: bot("bot-parent", "Boss"),
          actions: delegationActions(record, all),
          onAction: () => Promise.resolve(),
        }),
      );
      return labels.filter((label) => html.includes(`>${label}</span>`));
    };

    it.each([
      ["queued", ["Let it finish", "Cancel"]],
      ["running", ["Let it finish", "Cancel"]],
      ["failed", ["Try again"]],
      ["canceled", ["Try again"]],
      ["completed", []],
    ] as const)("shows the %s buttons", (state, expected) => {
      const record = delegation(phases[state]!);
      expect(rendered(record, [record])).toEqual(expected);
    });

    it("drops Let it finish once the work is kept", () => {
      const record = { ...delegation(phases.running!), keep: true };
      expect(rendered(record, [record])).toEqual(["Cancel"]);
    });

    it("drops Try again once a later card retries the work", () => {
      const original = delegation(phases.failed!);
      const retry = {
        ...delegation(phases.running!),
        delegationId: DelegationId.make("d-2"),
        retryOfDelegationId: original.delegationId,
      };
      expect(rendered(original, [original, retry])).toEqual([]);
    });

    it("shows no buttons when the card cannot run commands", () => {
      const record = delegation(phases.running!);
      const html = markup(
        createElement(ThreadDelegationCard, {
          delegation: record,
          childBot: null,
          parentBot: null,
          actions: delegationActions(record, [record]),
        }),
      );
      expect(html).not.toContain("Let it finish");
      expect(html).not.toContain(">Cancel<");
    });
  });
});
