import {
  BotId,
  DelegationId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  delegationActions,
  delegationElapsedMs,
  isDelegationSuperseded,
  presentDelegation,
  threadDelegations,
} from "./delegationPresentation.ts";

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
    anchorMessageId: null,
    retryOfDelegationId: null,
    trigger: "bot",
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
      childThreadId: CHILD_THREAD_ID,
      trigger: "bot",
      retried: false,
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

describe("presentDelegation card labels", () => {
  it("marks scheduled and retried work and has no child chat while queued", () => {
    const queued = {
      ...makeDelegation({ _tag: "Queued" }),
      trigger: "scheduled" as const,
      retryOfDelegationId: DelegationId.make("delegation-original"),
    };
    expect(presentDelegation(queued)).toMatchObject({
      childThreadId: null,
      trigger: "scheduled",
      retried: true,
    });
  });
});

describe("delegationElapsedMs", () => {
  const later = Date.parse(NOW) + 42_000;

  it("counts live work up to now and finished work up to its end", () => {
    expect(delegationElapsedMs(makeDelegation(running), later)).toBe(42_000);
    expect(
      delegationElapsedMs(
        makeDelegation({
          _tag: "Canceled",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: "2026-09-25T12:00:05.000Z",
          canceledBy: "user",
        }),
        later,
      ),
    ).toBe(5_000);
  });

  it("counts queued work from creation and rejects a clock behind the start", () => {
    expect(delegationElapsedMs(makeDelegation({ _tag: "Queued" }), later)).toBe(42_000);
    expect(delegationElapsedMs(makeDelegation(running), Date.parse(NOW) - 1)).toBeNull();
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

describe("presentDelegation failure text", () => {
  it("shows only the readable line of a failure stored with a server stack", () => {
    const failed = makeDelegation({
      _tag: "Failed",
      childThreadId: CHILD_THREAD_ID,
      childTurnId: CHILD_TURN_ID,
      startedAt: NOW,
      completedAt: NOW,
      acknowledgedAt: null,
      failure: {
        failureCode: "internal",
        message:
          "ProviderValidationError: Provider instance 'codex' is disabled in Akeru Bot settings.\n" +
          "    at disabledProviderError (file:///srv/akeru/apps/server/src/provider/Layers/AgentController.ts:584:10)",
      },
    });
    expect(presentDelegation(failed).outcome).toEqual({
      kind: "failure",
      text: "Provider instance 'codex' is disabled in Akeru Bot settings.",
    });
  });
});

describe("delegationActions", () => {
  it("offers let it finish and cancel for live work", () => {
    expect(delegationActions(makeDelegation({ _tag: "Queued" }), [])).toEqual(["keep", "cancel"]);
    expect(delegationActions(makeDelegation(running), [])).toEqual(["keep", "cancel"]);
  });

  it("drops let it finish once the work is kept", () => {
    expect(delegationActions({ ...makeDelegation(running), keep: true }, [])).toEqual(["cancel"]);
  });

  it("offers retry for failed and canceled work and nothing for completed work", () => {
    const failed = makeDelegation({
      _tag: "Failed",
      childThreadId: CHILD_THREAD_ID,
      childTurnId: CHILD_TURN_ID,
      startedAt: NOW,
      completedAt: NOW,
      acknowledgedAt: null,
      failure: { failureCode: "child_failed", message: "The site was down." },
    });
    const canceled = makeDelegation({
      _tag: "Canceled",
      childThreadId: null,
      childTurnId: null,
      startedAt: null,
      completedAt: NOW,
      canceledBy: "user",
    });
    expect(delegationActions(failed, [failed])).toEqual(["retry"]);
    expect(delegationActions(canceled, [canceled])).toEqual(["retry"]);
    expect(delegationActions(makeDelegation(completed(null)), [])).toEqual([]);
  });

  it("offers no retry once a later record retries the work", () => {
    const canceled = makeDelegation({
      _tag: "Canceled",
      childThreadId: null,
      childTurnId: null,
      startedAt: null,
      completedAt: NOW,
      canceledBy: "user",
    });
    const retry = {
      ...makeDelegation({ _tag: "Queued" }),
      delegationId: DelegationId.make("delegation-retry"),
      retryOfDelegationId: canceled.delegationId,
    };
    expect(isDelegationSuperseded(canceled, [canceled, retry])).toBe(true);
    expect(isDelegationSuperseded(retry, [canceled, retry])).toBe(false);
    expect(delegationActions(canceled, [canceled, retry])).toEqual([]);
    expect(delegationActions(retry, [canceled, retry])).toEqual(["keep", "cancel"]);
  });
});
