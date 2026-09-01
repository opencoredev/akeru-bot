import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AKERU_DELEGATION_MAX_CONCURRENCY,
  AKERU_DELEGATION_MAX_DEPTH,
  AkeruDelegationRecord,
  AkeruDelegationState,
} from "./akeruDelegation.ts";
import { OrchestrationCommand, OrchestrationEvent } from "./orchestration.ts";

const decodeDelegationRecord = Schema.decodeUnknownSync(AkeruDelegationRecord);
const decodeDelegationState = Schema.decodeUnknownSync(AkeruDelegationState);
const decodeOrchestrationCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const record = {
  delegationId: "delegation-1",
  parentDelegationId: null,
  parentBotId: "bot-parent",
  childBotId: "bot-child",
  parentThreadId: "thread-parent",
  childThreadId: "thread-child",
  parentTurnId: "turn-parent",
  childTurnId: "turn-child",
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
  state: "completed",
  billedBotId: "bot-child",
  result: {
    summary: "Compared the three requested flights.",
    childThreadId: "thread-child",
    childTurnId: "turn-child",
  },
  failure: null,
  keep: false,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:01:00.000Z",
  startedAt: "2026-08-31T00:00:10.000Z",
  completedAt: "2026-08-31T00:01:00.000Z",
} as const;

describe("Akeru delegation contracts", () => {
  it("decodes a durable delegation record", () => {
    expect(decodeDelegationRecord(record)).toMatchObject({
      delegationId: "delegation-1",
      billedBotId: "bot-child",
      result: { childThreadId: "thread-child" },
    });
  });

  it("decodes every lifecycle state", () => {
    expect(
      ["queued", "running", "blocked", "failed", "canceled", "completed"].map((state) =>
        decodeDelegationState(state),
      ),
    ).toEqual(["queued", "running", "blocked", "failed", "canceled", "completed"]);
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
  });
});
