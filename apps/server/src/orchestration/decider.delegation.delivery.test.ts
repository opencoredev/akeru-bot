import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  acknowledgeAkeruDelegation,
  releaseAkeruDelegationAcknowledgement,
  CommandId,
  DelegationId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@akeru/contracts";
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
  decideOne,
  makeReadModel,
  PARENT_THREAD_ID,
  OTHER_BOT_ID,
} from "./test-support/DelegationDeciderFixtures.ts";

it.layer(NodeServices.layer)("delegation decider", (it) => {
  it.effect("lets a result be acknowledged once without other same-phase changes", () =>
    Effect.gen(function* () {
      const completed = makeDelegation({
        phase: {
          _tag: "Completed",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: LATER,
          acknowledgedAt: null,
          result: { summary: "Done.", childThreadId: CHILD_THREAD_ID, childTurnId: CHILD_TURN_ID },
        },
        updatedAt: LATER,
      });

      const ACK = "2026-08-31T12:05:00.000Z";
      const acknowledged = acknowledgeAkeruDelegation(completed, ACK);

      const event = yield* decideOne(makeReadModel([completed]), {
        type: "delegation.state.set",
        commandId: CommandId.make("command-ack"),
        delegation: acknowledged,
      });

      expect(event.payload.delegation.phase).toMatchObject({ acknowledgedAt: ACK });

      const rewritten = yield* decideOrchestrationCommand({
        readModel: makeReadModel([completed]),
        command: {
          type: "delegation.state.set",
          commandId: CommandId.make("command-ack-rewrite"),
          delegation: {
            ...acknowledged,
            phase: Predicate.isTagged(acknowledged.phase, "Completed")
              ? {
                  ...acknowledged.phase,
                  result: { ...acknowledged.phase.result, summary: "Rewritten." },
                }
              : acknowledged.phase,
          },
        },
      }).pipe(Effect.flip);

      expect(String(rewritten)).toContain("without a state transition");

      const reacknowledged = yield* decideOrchestrationCommand({
        readModel: makeReadModel([acknowledged]),
        command: {
          type: "delegation.state.set",
          commandId: CommandId.make("command-ack-again"),
          delegation: acknowledgeAkeruDelegation(completed, "2026-08-31T12:06:00.000Z"),
        },
      }).pipe(Effect.flip);

      expect(String(reacknowledged)).toContain("without a state transition");
    }),
  );

  it.effect("lets an acknowledged result return to pending without other changes", () =>
    Effect.gen(function* () {
      const completed = makeDelegation({
        phase: {
          _tag: "Completed",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: LATER,
          acknowledgedAt: null,
          result: { summary: "Done.", childThreadId: CHILD_THREAD_ID, childTurnId: CHILD_TURN_ID },
        },
        updatedAt: LATER,
      });

      const acknowledged = acknowledgeAkeruDelegation(completed, "2026-08-31T12:05:00.000Z");
      const released = releaseAkeruDelegationAcknowledgement(acknowledged);

      const event = yield* decideOne(makeReadModel([acknowledged]), {
        type: "delegation.state.set",
        commandId: CommandId.make("command-release"),
        delegation: released,
      });

      expect(event.payload.delegation.phase).toMatchObject({ acknowledgedAt: null });

      const rewritten = yield* decideOrchestrationCommand({
        readModel: makeReadModel([acknowledged]),
        command: {
          type: "delegation.state.set",
          commandId: CommandId.make("command-release-rewrite"),
          delegation: {
            ...released,
            phase: Predicate.isTagged(released.phase, "Completed")
              ? { ...released.phase, result: { ...released.phase.result, summary: "Rewritten." } }
              : released.phase,
          },
        },
      }).pipe(Effect.flip);

      expect(String(rewritten)).toContain("without a state transition");
    }),
  );

  it.effect("injects finished child work into only the next parent turn", () =>
    Effect.gen(function* () {
      const completed = makeDelegation({
        phase: {
          _tag: "Completed",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: LATER,
          acknowledgedAt: null,
          result: { summary: "Done.", childThreadId: CHILD_THREAD_ID, childTurnId: CHILD_TURN_ID },
        },
        updatedAt: LATER,
      });

      const failed = makeDelegation({
        delegationId: DelegationId.make("delegation-failed"),
        phase: {
          _tag: "Failed",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: LATER,
          failure: { failureCode: "child_failed", message: "Stopped." },
          acknowledgedAt: null,
        },
        updatedAt: LATER,
      });

      const running = makeDelegation({
        delegationId: DelegationId.make("delegation-running"),
        phase: {
          _tag: "Running",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: null,
          startedAt: NOW,
          progress: null,
        },
      });

      let readModel = makeReadModel([completed, failed, running]);

      const turn = (index: number) =>
        Effect.gen(function* () {
          const decided = yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "thread.turn.start",
              commandId: CommandId.make(`command-turn-${index}`),
              threadId: PARENT_THREAD_ID,
              message: {
                messageId: MessageId.make(`message-${index}`),
                role: "user",
                text: "What did you find?",
                attachments: [],
              },
              interactionMode: "default",
              runtimeMode: "approval-required",
              createdAt: `2026-08-31T12:1${index}:00.000Z`,
            },
          });

          const events = Array.isArray(decided) ? decided : [decided];

          for (const event of events) {
            readModel = yield* projectEvent(readModel, {
              ...event,
              sequence: readModel.snapshotSequence + 1,
            } as OrchestrationEvent);
          }

          const requested = events.find((event) => event.type === "thread.turn-start-requested");

          return {
            ids:
              requested?.type === "thread.turn-start-requested"
                ? requested.payload.acknowledgedDelegationIds
                : "missing",
            acknowledgementEvents: events.filter((event) => event.type === "delegation.updated")
              .length,
          };
        });

      expect(yield* turn(1)).toEqual({
        ids: [completed.delegationId, failed.delegationId],
        acknowledgementEvents: 2,
      });
      expect(yield* turn(2)).toEqual({ ids: undefined, acknowledgementEvents: 0 });
      const byId = new Map(readModel.delegations.map((record) => [record.delegationId, record]));
      expect(byId.get(completed.delegationId)?.phase).toMatchObject({
        acknowledgedAt: "2026-08-31T12:11:00.000Z",
      });
      expect(byId.get(running.delegationId)?.phase._tag).toBe("Running");
    }),
  );

  it.effect("leaves another bot's results pending when it does not respond", () =>
    Effect.gen(function* () {
      const completed = makeDelegation({
        parentBotId: OTHER_BOT_ID,
        ancestorBotIds: [OTHER_BOT_ID],
        phase: {
          _tag: "Completed",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: CHILD_TURN_ID,
          startedAt: NOW,
          completedAt: LATER,
          acknowledgedAt: null,
          result: { summary: "Done.", childThreadId: CHILD_THREAD_ID, childTurnId: CHILD_TURN_ID },
        },
        updatedAt: LATER,
      });

      const decided = yield* decideOrchestrationCommand({
        readModel: makeReadModel([completed]),
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-turn-other"),
          threadId: PARENT_THREAD_ID,
          message: {
            messageId: MessageId.make("message-other"),
            role: "user",
            text: "Hello",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: "2026-08-31T12:10:00.000Z",
        },
      });

      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.some((event) => event.type === "delegation.updated")).toBe(false);
    }),
  );

  it.effect("never lets a delegated child thread carry a channel origin", () =>
    Effect.gen(function* () {
      const base = makeReadModel();

      const readModel: OrchestrationReadModel = {
        ...base,
        threads: base.threads.map((thread) =>
          thread.id === CHILD_THREAD_ID ? { ...thread, parentThreadId: PARENT_THREAD_ID } : thread,
        ),
      };

      const start = (threadId: ThreadId) =>
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make(`command-channel-${threadId}`),
            threadId,
            message: {
              messageId: MessageId.make(`message-channel-${threadId}`),
              role: "user",
              text: "Hello from Telegram",
              attachments: [],
              channelOrigin: { provider: "telegram", externalThreadId: "chat-1" },
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            createdAt: LATER,
          },
        });

      const rejected = yield* Effect.flip(start(CHILD_THREAD_ID));
      expect(String(rejected)).toContain("cannot receive channel messages");
      const accepted = yield* start(PARENT_THREAD_ID);
      const events = Array.isArray(accepted) ? accepted : [accepted];
      expect(events.some((event) => event.type === "thread.message-sent")).toBe(true);
    }),
  );
});
