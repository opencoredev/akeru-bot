import {
  BotId,
  DelegationId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentDelegation, threadDelegations } from "./delegationPresentation.ts";

const NOW = "2026-09-25T12:00:00.000Z";
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_THREAD_ID = ThreadId.make("thread-child");
const CHILD_TURN_ID = TurnId.make("turn-child");

function makeDelegation(
  phase: AkeruDelegationRecord["phase"],
  parentThreadId = PARENT_THREAD_ID,
): AkeruDelegationRecord {
  return {
    delegationId: DelegationId.make(`delegation-${phase._tag}-${parentThreadId}`),
    parentDelegationId: null,
    parentBotId: BotId.make("bot-parent"),
    childBotId: BotId.make("bot-child"),
    parentThreadId,
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
    billedBotId: BotId.make("bot-child"),
    keep: false,
    createdAt: NOW,
    updatedAt: NOW,
    phase,
  };
}

const running = {
  _tag: "Running",
  childThreadId: CHILD_THREAD_ID,
  childTurnId: CHILD_TURN_ID,
  startedAt: NOW,
  progress: null,
} as const;

function completed(acknowledgedAt: string | null): AkeruDelegationRecord["phase"] {
  return {
    _tag: "Completed",
    childThreadId: CHILD_THREAD_ID,
    childTurnId: CHILD_TURN_ID,
    startedAt: NOW,
    completedAt: NOW,
    acknowledgedAt,
    result: { summary: "Flight B.", childThreadId: CHILD_THREAD_ID, childTurnId: CHILD_TURN_ID },
  };
}

describe("presentDelegation", () => {
  it("shows a finished result as pending until the parent bot receives it", () => {
    expect(presentDelegation(makeDelegation(completed(null)))).toEqual({
      state: "completed",
      terminal: true,
      outcome: { kind: "result", text: "Flight B." },
      delivery: "pending",
    });
    expect(presentDelegation(makeDelegation(completed(NOW)))).toMatchObject({
      delivery: "delivered",
    });
  });

  it("has no delivery state for running or canceled work", () => {
    expect(presentDelegation(makeDelegation(running))).toMatchObject({
      state: "running",
      terminal: false,
      outcome: null,
      delivery: null,
    });
    expect(
      presentDelegation(
        makeDelegation({
          _tag: "Canceled",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: NOW,
          canceledBy: "user",
        }),
      ),
    ).toMatchObject({ state: "canceled", terminal: true, delivery: null });
  });

  it("carries the reason blocked work is waiting", () => {
    expect(
      presentDelegation(
        makeDelegation({
          _tag: "Blocked",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          reason: "Waiting for approval.",
        }),
      ),
    ).toMatchObject({
      state: "blocked",
      terminal: false,
      outcome: { kind: "blocked", text: "Waiting for approval." },
      delivery: null,
    });
  });
});

describe("threadDelegations", () => {
  it("keeps one chat's delegations and waits while any of them works", () => {
    const other = makeDelegation(running, ThreadId.make("thread-other"));
    const done = makeDelegation(completed(null));
    expect(threadDelegations([other, done], PARENT_THREAD_ID)).toEqual({
      delegations: [done],
      waitingOnChildren: false,
    });
    const working = makeDelegation(running);
    expect(threadDelegations([done, working], PARENT_THREAD_ID).waitingOnChildren).toBe(true);
  });
});
