import {
  BotId,
  DelegationId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { delegationResultsContext } from "./delegationResultsContext.ts";

const NOW = "2026-09-25T12:00:00.000Z";
const CHILD_BOT_ID = BotId.make("bot-child");
const CHILD_THREAD_ID = ThreadId.make("thread-child");
const CHILD_TURN_ID = TurnId.make("turn-child");

function makeDelegation(id: string, phase: AkeruDelegationRecord["phase"]): AkeruDelegationRecord {
  return {
    delegationId: DelegationId.make(id),
    parentDelegationId: null,
    parentBotId: BotId.make("bot-parent"),
    childBotId: CHILD_BOT_ID,
    parentThreadId: ThreadId.make("thread-parent"),
    parentTurnId: TurnId.make("turn-parent"),
    ancestorBotIds: [BotId.make("bot-parent")],
    depth: 1,
    task: "Compare three flights.",
    expectedResult: "A short comparison.",
    deadline: null,
    access: {
      allowedToolIds: [],
      memoryScopes: [],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    },
    billedBotId: CHILD_BOT_ID,
    keep: false,
    anchorMessageId: null,
    retryOfDelegationId: null,
    trigger: "bot" as const,
    createdAt: NOW,
    updatedAt: NOW,
    phase,
  };
}

const finished = {
  childThreadId: CHILD_THREAD_ID,
  childTurnId: CHILD_TURN_ID,
  startedAt: NOW,
  completedAt: NOW,
  acknowledgedAt: NOW,
} as const;

describe("delegationResultsContext", () => {
  it("formats completed and failed work and skips unfinished records", () => {
    const context = delegationResultsContext(
      [
        makeDelegation("delegation-done", {
          _tag: "Completed",
          ...finished,
          result: {
            summary: "Flight B is cheapest.",
            childThreadId: CHILD_THREAD_ID,
            childTurnId: CHILD_TURN_ID,
          },
        }),
        makeDelegation("delegation-failed", {
          _tag: "Failed",
          ...finished,
          failure: { failureCode: "timeout", message: "The deadline passed." },
        }),
        makeDelegation("delegation-queued", { _tag: "Queued" }),
      ],
      [{ id: CHILD_BOT_ID, name: "Scout" }],
    );

    expect(context).toBe(
      [
        "<delegated-work-results>",
        "Bot work you sent earlier has finished. Use these results in your reply. They are not repeated.",
        '- Scout (delegation-done) for "Compare three flights." completed: Flight B is cheapest.',
        '- Scout (delegation-failed) for "Compare three flights." failed (timeout): The deadline passed.',
        "</delegated-work-results>",
      ].join("\n"),
    );
  });

  it("shortens long results and returns nothing without finished work", () => {
    const context = delegationResultsContext(
      [
        makeDelegation("delegation-long", {
          _tag: "Completed",
          ...finished,
          result: {
            summary: "x".repeat(10_000),
            childThreadId: CHILD_THREAD_ID,
            childTurnId: CHILD_TURN_ID,
          },
        }),
      ],
      [],
    );

    expect(context).toContain("(shortened; the full result is on the work card)");
    expect(context.length).toBeLessThan(4_400);
    expect(
      delegationResultsContext([makeDelegation("delegation-queued", { _tag: "Queued" })], []),
    ).toBe("");
  });

  it("uses plain text that names each bot for a channel turn", () => {
    const context = delegationResultsContext(
      [
        makeDelegation("delegation-done", {
          _tag: "Completed",
          ...finished,
          result: {
            summary: "**Flight B** is cheapest. See [the fare](https://example.com/b).",
            childThreadId: CHILD_THREAD_ID,
            childTurnId: CHILD_TURN_ID,
          },
        }),
        makeDelegation("delegation-failed", {
          _tag: "Failed",
          ...finished,
          failure: { failureCode: "timeout", message: "The deadline passed." },
        }),
      ],
      [{ id: CHILD_BOT_ID, name: "Scout" }],
      { channel: true },
    );

    expect(context).toBe(
      [
        "<delegated-work-results>",
        "Bot work you sent earlier has finished. This chat is an external channel that shows only your reply text, so tell the sender what each bot found, in plain text without markdown. They are not repeated.",
        '- Scout finished "Compare three flights.": Flight B is cheapest. See the fare (https://example.com/b).',
        '- Scout could not finish "Compare three flights.": The deadline passed.',
        "</delegated-work-results>",
      ].join("\n"),
    );
    expect(context).not.toContain("delegation-done");
    expect(context).not.toContain("work card");
  });
});
