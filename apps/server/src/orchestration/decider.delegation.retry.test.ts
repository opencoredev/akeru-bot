import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DelegationId } from "@akeru/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import {
  makeDelegation,
  CHILD_THREAD_ID,
  CHILD_TURN_ID,
  NOW,
  LATER,
  makeReadModel,
  PARENT_THREAD_ID,
} from "./test-support/DelegationDeciderFixtures.ts";

it.layer(NodeServices.layer)("delegation decider", (it) => {
  it.effect("requests a retry of failed or canceled work without touching the original", () =>
    Effect.gen(function* () {
      const failed = makeDelegation({
        phase: {
          _tag: "Failed",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: LATER,
          failure: { failureCode: "child_failed", message: "The child failed." },
          acknowledgedAt: null,
        },
        updatedAt: LATER,
      });
      const readModel = makeReadModel([failed]);
      const decided = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "delegation.retry",
          commandId: CommandId.make("command-retry"),
          delegationId: failed.delegationId,
          createdAt: LATER,
        },
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "delegation.retry-requested",
        aggregateKind: "delegation",
        aggregateId: failed.delegationId,
        payload: { delegationId: failed.delegationId, parentThreadId: PARENT_THREAD_ID },
      });
      const projected = yield* projectEvent(readModel, {
        ...events[0]!,
        sequence: readModel.snapshotSequence + 1,
      });
      expect(projected.delegations).toEqual([failed]);
    }),
  );

  it.effect("refuses retrying open work, retrying past the cap, and retrying twice", () =>
    Effect.gen(function* () {
      const running = makeDelegation({
        phase: {
          _tag: "Running",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: null,
          startedAt: NOW,
          progress: null,
        },
      });
      const openError = yield* decideOrchestrationCommand({
        readModel: makeReadModel([running]),
        command: {
          type: "delegation.retry",
          commandId: CommandId.make("command-retry-open"),
          delegationId: running.delegationId,
          createdAt: LATER,
        },
      }).pipe(Effect.flip);
      expect(String(openError)).toContain("Only failed or canceled bot work can be retried.");

      const canceled = makeDelegation({
        delegationId: DelegationId.make("delegation-canceled"),
        phase: {
          _tag: "Canceled",
          childThreadId: null,
          childTurnId: null,
          startedAt: null,
          completedAt: LATER,
          canceledBy: "user",
        },
      });
      const active = [1, 2, 3].map((index) =>
        makeDelegation({ delegationId: DelegationId.make(`delegation-active-${index}`) }),
      );
      const capError = yield* decideOrchestrationCommand({
        readModel: makeReadModel([canceled, ...active]),
        command: {
          type: "delegation.retry",
          commandId: CommandId.make("command-retry-cap"),
          delegationId: canceled.delegationId,
          createdAt: LATER,
        },
      }).pipe(Effect.flip);
      expect(String(capError)).toContain(
        "This bot already has 3 bot work items running. Wait for one to finish, then retry.",
      );

      const successor = makeDelegation({
        delegationId: DelegationId.make("delegation-retry-of-canceled"),
        retryOfDelegationId: canceled.delegationId,
      });
      const supersededError = yield* decideOrchestrationCommand({
        readModel: makeReadModel([canceled, successor]),
        command: {
          type: "delegation.retry",
          commandId: CommandId.make("command-retry-superseded"),
          delegationId: canceled.delegationId,
          createdAt: LATER,
        },
      }).pipe(Effect.flip);
      expect(String(supersededError)).toContain(
        "This bot work was already retried. Use the newer card instead.",
      );
    }),
  );
});
