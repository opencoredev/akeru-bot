import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AKERU_DELEGATION_MAX_CONCURRENCY,
  AKERU_DELEGATION_MAX_DEPTH,
  AkeruDelegationContextTooLongError,
  AkeruDelegationRecord,
  AkeruDelegationPhase,
  acknowledgeAkeruDelegation,
  isAkeruDelegationResultPending,
  isThreadWaitingOnChildren,
} from "./akeruDelegation.ts";
import { OrchestrationCommand, OrchestrationEvent } from "./orchestration.ts";

const decodeDelegationRecord = Schema.decodeUnknownSync(AkeruDelegationRecord);
const encodeDelegationRecord = Schema.encodeSync(AkeruDelegationRecord);
const decodeDelegationPhase = Schema.decodeUnknownSync(AkeruDelegationPhase);
const decodeOrchestrationCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const encodeOrchestrationEvent = Schema.encodeUnknownSync(OrchestrationEvent);

const record = {
  delegationId: "delegation-1",
  parentDelegationId: null,
  parentBotId: "bot-parent",
  childBotId: "bot-child",
  parentThreadId: "thread-parent",
  parentTurnId: "turn-parent",
  ancestorBotIds: ["bot-parent"],
  depth: 1,
  task: "Compare three flights.",
  expectedResult: "A short comparison with sources.",
  deadline: null,
  access: {
    allowedToolIds: ["Read"],
    memoryScopes: ["project"],
    sandbox: "daytona",
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: ["email"],
    approvalCeiling: "send",
  },
  billedBotId: "bot-child",
  phase: {
    _tag: "Completed",
    startedAt: "2026-08-31T00:00:10.000Z",
    completedAt: "2026-08-31T00:01:00.000Z",
    childThreadId: "thread-child",
    childTurnId: "turn-child",
    acknowledgedAt: null,
    result: {
      summary: "Compared the three requested flights.",
      childThreadId: "thread-child",
      childTurnId: "turn-child",
    },
  },
  keep: false,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:01:00.000Z",
} as const;

describe("Akeru delegation contracts", () => {
  it("decodes a durable delegation record", () => {
    expect(decodeDelegationRecord(record)).toMatchObject({
      delegationId: "delegation-1",
      billedBotId: "bot-child",
      phase: { _tag: "Completed", result: { childThreadId: "thread-child" } },
    });
  });

  it("exposes every lifecycle phase", () => {
    expect(Object.keys(AkeruDelegationPhase.cases)).toEqual([
      "Queued",
      "Running",
      "Blocked",
      "Completed",
      "Failed",
      "Canceled",
    ]);
  });

  it("caps delegation depth and publishes the concurrency limit", () => {
    expect(() =>
      decodeDelegationRecord({
        ...record,
        depth: AKERU_DELEGATION_MAX_DEPTH + 1,
      }),
    ).toThrow();
    expect(AKERU_DELEGATION_MAX_CONCURRENCY).toBe(3);
  });

  it("lifts legacy event records into the tagged phase without changing identity", () => {
    const { phase, ...base } = record;
    const legacy = {
      ...base,
      state: "completed",
      result: phase.result,
      failure: null,
      childThreadId: "thread-child",
      childTurnId: "turn-child",
      startedAt: "2026-08-31T00:00:10.000Z",
      completedAt: "2026-08-31T00:01:00.000Z",
    };
    const decoded = decodeDelegationRecord(legacy);
    expect(decoded.delegationId).toBe(record.delegationId);
    expect(decoded).not.toHaveProperty("state");
    expect(decoded.phase).toEqual({ ...phase, result: phase.result });
  });

  it("encodes tagged records with the previous client's flat wire fields", () => {
    const tagged = decodeDelegationRecord(record);
    const encoded = encodeDelegationRecord(tagged);
    expect(encoded).toMatchObject({
      state: "completed",
      childThreadId: "thread-child",
      childTurnId: "turn-child",
      result: record.phase.result,
      failure: null,
      startedAt: record.phase.startedAt,
      completedAt: record.phase.completedAt,
    });
    expect(encoded).not.toHaveProperty("phase");
    expect(decodeDelegationRecord(encoded)).toEqual(tagged);
  });

  it("keeps phase details through the flat wire form", () => {
    const { phase: _phase, ...base } = decodeDelegationRecord(record);
    const phases = [
      {
        _tag: "Running",
        childThreadId: "thread-child",
        childTurnId: null,
        startedAt: "2026-08-31T00:00:00.000Z",
        progress: "Reading the logs.",
      },
      {
        _tag: "Blocked",
        childThreadId: "thread-child",
        childTurnId: null,
        startedAt: "2026-08-31T00:00:00.000Z",
        reason: "Needs repository access.",
      },
      {
        _tag: "Canceled",
        childThreadId: "thread-child",
        childTurnId: null,
        startedAt: "2026-08-31T00:00:00.000Z",
        completedAt: "2026-08-31T00:01:00.000Z",
        canceledBy: "parent-bot",
      },
    ];
    for (const phase of phases) {
      const tagged = decodeDelegationRecord({
        ...encodeDelegationRecord({ ...base, phase } as never),
      });
      expect(tagged.phase).toEqual(phase);
    }
  });

  it("defaults anchor, retry, and trigger on records written before them", () => {
    expect(decodeDelegationRecord(record)).toMatchObject({
      anchorMessageId: null,
      retryOfDelegationId: null,
      trigger: "bot",
    });
  });

  it("carries anchor, retry, and trigger through tagged and legacy records", () => {
    const fields = {
      anchorMessageId: "message-user-1",
      retryOfDelegationId: "delegation-0",
      trigger: "scheduled",
    } as const;
    expect(decodeDelegationRecord({ ...record, ...fields })).toMatchObject(fields);

    const { phase, ...base } = record;
    const legacy = {
      ...base,
      ...fields,
      state: "completed",
      result: phase.result,
      failure: null,
      childThreadId: "thread-child",
      childTurnId: "turn-child",
      startedAt: "2026-08-31T00:00:10.000Z",
      completedAt: "2026-08-31T00:01:00.000Z",
    };
    const decoded = decodeDelegationRecord(legacy);
    expect(decoded).toMatchObject({ ...fields, phase: { _tag: "Completed" } });
    expect(decoded).not.toHaveProperty("state");
  });

  it("rejects an unknown trigger", () => {
    expect(() => decodeDelegationRecord({ ...record, trigger: "webhook" })).toThrow();
  });

  it("lifts legacy queued and failed records", () => {
    const { phase: _phase, ...base } = record;
    const legacy = {
      ...base,
      childThreadId: null,
      childTurnId: null,
      result: null,
      failure: null,
      startedAt: null,
      completedAt: null,
    };
    expect(decodeDelegationRecord({ ...legacy, state: "queued" }).phase).toEqual({
      _tag: "Queued",
    });
    expect(
      decodeDelegationRecord({
        ...legacy,
        state: "failed",
        failure: { failureCode: "timeout", message: "Timed out." },
        completedAt: "2026-08-31T00:01:00.000Z",
      }).phase,
    ).toMatchObject({ _tag: "Failed", failure: { failureCode: "timeout" } });
  });

  it("rejects a completed result without childTurnId", () => {
    expect(() =>
      decodeDelegationRecord({
        ...record,
        phase: {
          ...record.phase,
          result: { summary: "Done.", childThreadId: "thread-child" },
        },
      }),
    ).toThrow();
  });

  it("decodes delegation commands and events", () => {
    expect(
      [
        decodeOrchestrationCommand({
          type: "delegation.create",
          commandId: "command-create",
          delegation: record,
        }),
        decodeOrchestrationCommand({
          type: "delegation.state.set",
          commandId: "command-update",
          delegation: record,
        }),
        decodeOrchestrationCommand({
          type: "delegation.cancel",
          commandId: "command-cancel",
          delegationId: "delegation-1",
          createdAt: "2026-08-31T00:01:00.000Z",
        }),
      ].map((command) => command.type),
    ).toEqual(["delegation.create", "delegation.state.set", "delegation.cancel"]);

    const eventBase = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "delegation",
      aggregateId: "delegation-1",
      occurredAt: "2026-08-31T00:00:00.000Z",
      commandId: "command-create",
      causationEventId: null,
      correlationId: "command-create",
      metadata: {},
      payload: { delegation: record },
    };
    expect(
      [
        decodeOrchestrationEvent({ ...eventBase, type: "delegation.created" }),
        decodeOrchestrationEvent({ ...eventBase, eventId: "event-2", type: "delegation.updated" }),
      ].map((event) => event.type),
    ).toEqual(["delegation.created", "delegation.updated"]);
    expect(
      encodeOrchestrationEvent(
        decodeOrchestrationEvent({ ...eventBase, eventId: "event-2", type: "delegation.updated" }),
      ),
    ).toMatchObject({
      type: "delegation.updated",
      payload: { delegation: { state: "completed", childThreadId: "thread-child" } },
    });
  });

  it("defaults acknowledgedAt on failed records written before acknowledgment existed", () => {
    const decoded = decodeDelegationRecord({
      ...record,
      phase: {
        _tag: "Failed",
        childThreadId: "thread-child",
        childTurnId: "turn-child",
        startedAt: "2026-08-31T00:00:10.000Z",
        completedAt: "2026-08-31T00:01:00.000Z",
        failure: { failureCode: "child_failed", message: "The bot stopped." },
      },
    });
    expect(decoded.phase).toMatchObject({ _tag: "Failed", acknowledgedAt: null });
  });

  it("tracks pending results and acknowledges them once", () => {
    const decoded = decodeDelegationRecord(record);
    expect(isAkeruDelegationResultPending(decoded)).toBe(true);
    const acknowledged = acknowledgeAkeruDelegation(decoded, "2026-08-31T00:02:00.000Z");
    expect(acknowledged.phase).toMatchObject({
      _tag: "Completed",
      acknowledgedAt: "2026-08-31T00:02:00.000Z",
    });
    expect(acknowledged.updatedAt).toBe("2026-08-31T00:02:00.000Z");
    expect(isAkeruDelegationResultPending(acknowledged)).toBe(false);
    expect(acknowledgeAkeruDelegation(acknowledged, "2026-08-31T00:03:00.000Z")).toBe(acknowledged);

    const canceled = decodeDelegationRecord({
      ...record,
      phase: {
        _tag: "Canceled",
        childThreadId: "thread-child",
        childTurnId: "turn-child",
        startedAt: "2026-08-31T00:00:10.000Z",
        completedAt: "2026-08-31T00:01:00.000Z",
        canceledBy: "user",
      },
    });
    expect(isAkeruDelegationResultPending(canceled)).toBe(false);
  });

  it("derives the waiting-on-children flag from non-terminal children", () => {
    const completed = decodeDelegationRecord(record);
    const running = decodeDelegationRecord({
      ...record,
      delegationId: "delegation-2",
      phase: {
        _tag: "Running",
        childThreadId: "thread-child-2",
        childTurnId: null,
        startedAt: "2026-08-31T00:00:10.000Z",
        progress: null,
      },
    });
    const parent = completed.parentThreadId;
    expect(isThreadWaitingOnChildren([completed], parent)).toBe(false);
    expect(isThreadWaitingOnChildren([completed, running], parent)).toBe(true);
    expect(
      isThreadWaitingOnChildren(
        [running],
        running.phase._tag === "Running" ? running.phase.childThreadId : parent,
      ),
    ).toBe(false);
  });

  it("names the context cap in its typed error", () => {
    const error = new AkeruDelegationContextTooLongError({ length: 9_000, maxLength: 8_000 });
    expect(error._tag).toBe("AkeruDelegationContextTooLongError");
    expect(error.message).toContain("8000");
  });

  it("decodes acknowledged delegation ids on turn start requests", () => {
    const event = decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-turn",
      aggregateKind: "thread",
      aggregateId: "thread-parent",
      occurredAt: "2026-08-31T00:02:00.000Z",
      commandId: "command-turn",
      causationEventId: null,
      correlationId: "command-turn",
      metadata: {},
      type: "thread.turn-start-requested",
      payload: {
        threadId: "thread-parent",
        messageId: "message-1",
        acknowledgedDelegationIds: ["delegation-1"],
        createdAt: "2026-08-31T00:02:00.000Z",
      },
    });
    expect(
      event.type === "thread.turn-start-requested" && event.payload.acknowledgedDelegationIds,
    ).toEqual(["delegation-1"]);
  });
});
