import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { CommandId, ProviderInstanceId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { gitRefExists } from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import {
  withHarness,
  seedProjectAndThread,
  runtimeBase,
  CLAUDE_AGENT_PROVIDER,
  THREAD_ID,
  FIXTURE_TURN_ID,
  startTurn,
  nowIso,
  assertNoRevertFailure,
} from "./test-support/OrchestrationScenario.ts";

it.live("reverts claudeAgent turns and rolls back provider conversation state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-1",
                "2026-02-24T10:14:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-2",
                "2026-02-24T10:14:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v2\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-3",
                "2026-02-24T10:14:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-1",
          messageId: "msg-user-claude-revert-1",
          text: "First Claude edit",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.latestTurn !== null && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-4",
                "2026-02-24T10:14:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-5",
                "2026-02-24T10:14:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v3\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-6",
                "2026-02-24T10:14:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-2",
          messageId: "msg-user-claude-revert-2",
          text: "Second Claude edit",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn !== null &&
            entry.checkpoints.length === 2 &&
            entry.session?.providerName === "claudeAgent",
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-claude"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: nowIso(),
        });

        const revertedThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
        );

        assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
          true,
        );
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
          false,
        );
        assertNoRevertFailure(revertedThread);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);
