import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  ApprovalRequestId,
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  RoutineId,
  type BotPermissionPolicy,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { assert, describe } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { codexThreadId } from "./test-support/agentControllerFixtures.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  openRoutineReview,
  provideRoutineController,
} from "./test-support/agentControllerLayers.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const botId = BotId.make("bot-routines");

describe("AgentControllerLive routine permissions", () => {
  it.effect("does not create a routine whose permission was revoked during review", () => {
    const mastra = mastraHarnessFixture();
    const events: Array<ProviderRuntimeEvent> = [];
    let policy: BotPermissionPolicy = DEFAULT_BOT_PERMISSION_POLICY;
    let dispatched = 0;

    return provideRoutineController(
      Effect.gen(function* () {
        const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);

        policy = {
          ...DEFAULT_BOT_PERMISSION_POLICY,
          toolOverrides: { [AKERU_CREATE_ROUTINE_TOOL_NAME]: "deny" },
        };
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make(requestId),
          decision: "accept",
        });

        const result = yield* Fiber.join(toolCall);
        assert.isTrue(Exit.isFailure(result));
        assert.strictEqual(dispatched, 0);
        yield* Effect.yieldNow;
        const resolved = events.filter((event) => event.type === "request.resolved");
        assert.deepStrictEqual(
          resolved.map((event) => event.payload),
          [{ requestType: "dynamic_tool_call", decision: "accept", outcome: "failed" }],
        );
        mastra.finishSend();
      }),
      mastra,
      {
        createApprovedForThread: () =>
          Effect.sync(() => {
            dispatched += 1;

            return {
              routineId: RoutineId.make("routine-created"),
              sequence: 1,
              status: "approved" as const,
            };
          }),
      },
    ).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.succeed(Option.some(providerRuntimeContext({ id: threadId, botId }))),
            getBotById: () =>
              Effect.sync(() =>
                Option.some(providerBotFixture({ id: botId, permissionPolicy: policy })),
              ),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: () => Effect.succeed([]),
          }),
        ),
      ),
    );
  });
});
