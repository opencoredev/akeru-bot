import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  type BotPermissionPolicy,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexInstanceId,
  codexSelection,
  codexThreadId,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const botId = BotId.make("bot-allow");

const push = {
  type: "tool_approval_required",
  toolCallId: "shell-push-1",
  toolName: "Shell",
  args: { command: "git push origin main" },
} as AgentControllerEvent;

/** Starts a full-access bot under `policy`, emits one Shell approval, and reports what followed. */
const approvalFor = (policy: BotPermissionPolicy) => {
  const bridge = makeBridge();
  const mastra = mastraHarnessFixture();

  return provideController(
    Effect.gen(function* () {
      const controller = yield* AgentController;
      const answered = yield* Deferred.make<unknown>();
      const events: ProviderRuntimeEvent[] = [];

      vi.mocked(mastra.session.respondToToolApproval).mockImplementation((answer) => {
        Deferred.doneUnsafe(answered, Exit.succeed(answer));
      });

      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        botId,
        botName: "Allow",
      });

      const opened = yield* Deferred.make<void>();
      yield* controller.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);

            if (event.type === "request.opened") Deferred.doneUnsafe(opened, Exit.void);
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* controller.sendTurn({ threadId: codexThreadId, input: "Push the branch." });
      yield* Effect.yieldNow;
      mastra.emit(push);

      // Whichever happens first: the controller answers on its own, or it opens a prompt.
      const outcome = yield* Effect.raceFirst(
        Deferred.await(answered).pipe(Effect.map((answer) => ({ answer }))),
        Deferred.await(opened).pipe(Effect.as({ answer: undefined })),
      );

      mastra.finishSend();

      return {
        outcome,
        opened: events.some((event) => event.type === "request.opened"),
      };
    }),
    bridge.service,
    mastra.factory,
  ).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
        projectionQueryFixture({
          getThreadRuntimeContext: (threadId: ThreadId) =>
            Effect.succeed(Option.some(providerRuntimeContext({ id: threadId, botId }))),
          getBotById: () =>
            Effect.succeed(
              Option.some(providerBotFixture({ id: botId, permissionPolicy: policy })),
            ),
          getGroupById: () => Effect.succeed(Option.none()),
          listThreadDelegations: () => Effect.succeed([]),
        }),
      ),
    ),
  );
};

describe("AgentControllerLive policy allow", () => {
  it.effect("approves a built-in tool the bot policy explicitly allows without asking", () =>
    approvalFor({ ...DEFAULT_BOT_PERMISSION_POLICY, toolOverrides: { Shell: "allow" } }).pipe(
      Effect.map(({ outcome, opened }) => {
        expect(outcome.answer).toEqual({ toolCallId: "shell-push-1", decision: "approve" });
        expect(opened).toBe(false);
      }),
    ),
  );

  it.effect("still asks the owner before an outside write under the default policy", () =>
    approvalFor(DEFAULT_BOT_PERMISSION_POLICY).pipe(
      Effect.map(({ outcome, opened }) => {
        expect(outcome.answer).toBeUndefined();
        expect(opened).toBe(true);
      }),
    ),
  );
});
