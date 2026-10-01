import { CommandId, ProviderInstanceId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  MASTRA_PROVIDERS,
  withHarness,
  seedProjectAndThread,
  mastraFixture,
  startTurn,
  modelFor,
  THREAD_ID,
  runtimeBase,
  FIXTURE_TURN_ID,
  asApprovalRequestId,
  nowIso,
  observeAfterProviderDrain,
} from "./test-support/OrchestrationScenario.ts";

for (const provider of MASTRA_PROVIDERS) {
  const label = String(provider);

  it.live(`${label} custom harness covers tool turn and model switch`, () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(harness);
          yield* harness.adapterHarness!.queueTurnResponseForNextSession(
            mastraFixture(provider, label),
          );
          yield* startTurn({
            harness,
            commandId: `cmd-${label}-turn-1`,
            messageId: `msg-${label}-turn-1`,
            text: "run fixture tool",
            modelSelection: {
              instanceId: ProviderInstanceId.make(label),
              model: modelFor(provider, "a"),
            },
          });

          const first = yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.session?.providerName === label && entry.latestTurn?.state === "completed",
          );

          const firstTurnId = first.latestTurn!.turnId;
          const switchesAfterFirstTurn = harness.mastraHarness!.getModelSwitches(THREAD_ID).length;

          yield* harness.adapterHarness!.queueTurnResponseForNextSession(
            mastraFixture(provider, `${label}-second`),
          );
          yield* startTurn({
            harness,
            commandId: `cmd-${label}-turn-2`,
            messageId: `msg-${label}-turn-2`,
            text: "switch model",
            modelSelection: {
              instanceId: ProviderInstanceId.make(label),
              model: modelFor(provider, "b"),
            },
          });
          yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.latestTurn !== null &&
              entry.latestTurn.turnId !== firstTurnId &&
              entry.latestTurn.state === "completed",
          );

          // A turn's model reaches the Mastra session, not the persisted
          // thread selection, which only thread.meta.update changes.
          // Some providers use one model id for "a" and "b", so require a new
          // switch from turn 2 rather than reading turn 1's.
          const secondTurnSwitches = harness
            .mastraHarness!.getModelSwitches(THREAD_ID)
            .slice(switchesAfterFirstTurn);

          assert.equal(secondTurnSwitches.at(-1)?.endsWith(modelFor(provider, "b")), true);
        }),
      provider,
    ),
  );

  it.live(`${label} custom harness denies approval and cancels pending turn`, () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(harness);
          const approvalId = `${label}-approval`;
          yield* harness.adapterHarness!.queueTurnResponseForNextSession({
            events: [
              {
                type: "turn.started",
                ...runtimeBase(`evt-${label}-approval-start`, "2026-05-01T00:01:00.000Z", provider),
                threadId: String(THREAD_ID),
                turnId: FIXTURE_TURN_ID,
              },
              {
                type: "approval.requested",
                ...runtimeBase(`evt-${label}-approval`, "2026-05-01T00:01:00.050Z", provider),
                threadId: String(THREAD_ID),
                turnId: FIXTURE_TURN_ID,
                requestId: approvalId,
                requestKind: "command",
                detail: "Approve fixture command",
              },
              {
                type: "turn.completed",
                ...runtimeBase(`evt-${label}-approval-done`, "2026-05-01T00:01:00.100Z", provider),
                threadId: String(THREAD_ID),
                turnId: FIXTURE_TURN_ID,
                status: "completed",
              },
            ],
          });
          yield* startTurn({
            harness,
            commandId: `cmd-${label}-approval`,
            messageId: `msg-${label}-approval`,
            text: "ask approval",
            modelSelection: {
              instanceId: ProviderInstanceId.make(label),
              model: modelFor(provider, "a"),
            },
          });
          yield* harness.waitForPendingApproval(approvalId, (row) => row.status === "pending");
          yield* harness.engine.dispatch({
            type: "thread.approval.respond",
            commandId: CommandId.make(`cmd-${label}-deny`),
            threadId: THREAD_ID,
            requestId: asApprovalRequestId(approvalId),
            decision: "decline",
            createdAt: nowIso(),
          });
          // Resolution deletes the pending row, so the approval.resolved
          // activity and the harness spy are the durable signal.
          yield* harness.waitForThread(THREAD_ID, (entry) =>
            entry.activities.some(
              (activity) =>
                activity.kind === "approval.resolved" &&
                String(
                  (activity.payload as { readonly requestId?: string } | undefined)?.requestId,
                ) === approvalId,
            ),
          );

          const approvalResponses = yield* observeAfterProviderDrain(
            harness,
            () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
            (responses) => responses.length === 1,
            `${label} approval response`,
          );

          assert.equal(approvalResponses[0]?.decision, "decline");

          yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
            events: [
              {
                type: "turn.started",
                ...runtimeBase(`evt-${label}-cancel`, "2026-05-01T00:02:00.000Z", provider),
                threadId: String(THREAD_ID),
                turnId: FIXTURE_TURN_ID,
              },
            ],
          });
          yield* startTurn({
            harness,
            commandId: `cmd-${label}-cancel`,
            messageId: `msg-${label}-cancel`,
            text: "cancel turn",
          });
          yield* harness.waitForThread(THREAD_ID, (entry) => entry.session?.providerName === label);
          yield* harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`cmd-${label}-interrupt`),
            threadId: THREAD_ID,
            createdAt: nowIso(),
          });

          const interrupts = yield* observeAfterProviderDrain(
            harness,
            () => harness.adapterHarness!.getInterruptCalls(THREAD_ID),
            (calls) => calls.length >= 1,
            `${label} cancellation`,
          );

          assert.equal(interrupts.length >= 1, true);
        }),
      provider,
    ),
  );

  it.live(`${label} custom harness recovers after restart`, () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* seedProjectAndThread(harness);
          yield* harness.adapterHarness!.queueTurnResponseForNextSession(
            mastraFixture(provider, `${label}-before`),
          );
          yield* startTurn({
            harness,
            commandId: `cmd-${label}-restart-1`,
            messageId: `msg-${label}-restart-1`,
            text: "before restart",
            modelSelection: {
              instanceId: ProviderInstanceId.make(label),
              model: modelFor(provider, "a"),
            },
          });
          yield* harness.waitForThread(THREAD_ID, (entry) => entry.latestTurn !== null);
          yield* harness.adapterHarness!.adapter.stopAll();
          yield* harness.adapterHarness!.queueTurnResponseForNextSession(
            mastraFixture(provider, `${label}-after`),
          );
          yield* startTurn({
            harness,
            commandId: `cmd-${label}-restart-2`,
            messageId: `msg-${label}-restart-2`,
            text: "after restart",
          });

          const starts = yield* observeAfterProviderDrain(
            harness,
            () => harness.adapterHarness!.getStartCount(),
            (count) => count === 2,
            `${label} recovery start`,
          );

          assert.equal(starts, 2);

          const recovered = yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.session?.providerName === label &&
              entry.messages.some(
                (message) =>
                  message.role === "assistant" && message.text.includes(`${label}-after response`),
              ),
          );

          assert.equal(recovered.session?.providerName, label);
        }),
      provider,
    ),
  );
}
