// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { CommandId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import { gitRefExists, gitShowFileAtRef } from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import {
  withHarness,
  seedProjectAndThread,
  runtimeBase,
  THREAD_ID,
  FIXTURE_TURN_ID,
  startTurn,
  nowIso,
  assertNoRevertFailure,
} from "./test-support/OrchestrationScenario.ts";

it.live("runs a single turn end-to-end and persists checkpoint state in sqlite + git", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });

      const finalizedReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }

      assert.equal(finalizedReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ) &&
          entry.checkpoints.length === 1,
      );

      assert.equal(thread.checkpoints[0]?.status, "ready");
      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });

      assert.equal(checkpointRows.length, 1);
      assert.equal(checkpointRows[0]?.checkpointTurnCount, 1);
      assert.equal(checkpointRows[0]?.status, "ready");
      assert.deepEqual(checkpointRows[0]?.files, []);

      const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
      const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
      assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
      assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
    }),
  ),
);

it.live("runs multi-turn file edits and persists checkpoint diffs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-1", "2026-02-24T10:01:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-multi-2", "2026-02-24T10:01:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-multi-3", "2026-02-24T10:01:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-4", "2026-02-24T10:01:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-5", "2026-02-24T10:01:00.400Z"),
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
        commandId: "cmd-turn-start-multi-1",
        messageId: "msg-user-multi-1",
        text: "Make first edit",
      });
      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.checkpoints.length === 1 && entry.session?.threadId === "thread-1",
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-6", "2026-02-24T10:02:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-7", "2026-02-24T10:02:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-8", "2026-02-24T10:02:00.200Z"),
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
        commandId: "cmd-turn-start-multi-2",
        messageId: "msg-user-multi-2",
        text: "Make second edit",
      });

      const secondReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      if (secondReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }

      assert.equal(secondReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      const secondTurnThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn !== null &&
          entry.checkpoints.length === 2 &&
          entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 2),
      );

      const secondCheckpoint = secondTurnThread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === 2,
      );

      assert.equal(
        secondCheckpoint?.files.some((file) => file.path === "README.md"),
        true,
      );

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });

      assert.deepEqual(
        checkpointRows.map((row) => row.checkpointTurnCount),
        [1, 2],
      );

      const incrementalDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 1),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });

      assert.equal(incrementalDiff.includes("README.md"), true);

      const fullDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 0),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });

      assert.equal(fullDiff.includes("README.md"), true);

      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 1),
          "README.md",
        ),
        "v2\n",
      );
      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 2),
          "README.md",
        ),
        "v3\n",
      );
    }),
  ),
);

it.live("records failed turn runtime state and checkpoint status as error", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-failure-1", "2026-02-24T10:04:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "content.delta",
            ...runtimeBase("evt-failure-2", "2026-02-24T10:04:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              streamKind: "assistant_text",
              delta: "Partial output before failure.\n",
            },
          },
          {
            type: "runtime.error",
            ...runtimeBase("evt-failure-3", "2026-02-24T10:04:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              message: "Sandbox command failed.",
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-failure-4", "2026-02-24T10:04:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              state: "failed",
              errorMessage: "Sandbox command failed.",
            },
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-failure",
        messageId: "msg-user-failure",
        text: "Run risky command",
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.lastError === "Sandbox command failed." &&
          entry.activities.some((activity) => activity.kind === "runtime.error") &&
          entry.checkpoints.length === 1,
      );

      assert.equal(thread.session?.status, "error");
      assert.equal(thread.checkpoints[0]?.status, "error");

      const checkpointRow = yield* harness.checkpointRepository.getByThreadAndTurnCount({
        threadId: THREAD_ID,
        checkpointTurnCount: 1,
      });

      assert.equal(Option.isSome(checkpointRow), true);

      if (Option.isSome(checkpointRow)) {
        assert.equal(checkpointRow.value.status, "error");
      }

      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
        true,
      );
    }),
  ),
);

it.live("reverts to an earlier checkpoint and trims checkpoint projections + git refs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-1", "2026-02-24T10:05:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-1-tool-started", "2026-02-24T10:05:00.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-1-tool-completed", "2026-02-24T10:05:00.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-1a", "2026-02-24T10:05:00.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-2", "2026-02-24T10:05:00.100Z"),
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
        commandId: "cmd-turn-start-revert-1",
        messageId: "msg-user-revert-1",
        text: "First edit",
        createdAt: "2026-02-24T10:04:59.900Z",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.threadId === "thread-1" && entry.checkpoints.length === 1,
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-3", "2026-02-24T10:05:01.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-3-tool-started", "2026-02-24T10:05:01.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-3-tool-completed", "2026-02-24T10:05:01.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-3a", "2026-02-24T10:05:01.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-4", "2026-02-24T10:05:01.100Z"),
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
        commandId: "cmd-turn-start-revert-2",
        messageId: "msg-user-revert-2",
        text: "Second edit",
        createdAt: "2026-02-24T10:05:00.900Z",
      });

      const beforeRevert = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn !== null &&
          entry.checkpoints.length === 2 &&
          entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 2),
        8000,
      );

      // Mastra-backed providers assign their own turn ids, so read them back.
      const turnIdAt = (turnCount: number) =>
        beforeRevert.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === turnCount)
          ?.turnId;

      const firstTurnId = turnIdAt(1);
      const secondTurnId = turnIdAt(2);

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-checkpoint-revert"),
        threadId: THREAD_ID,
        turnCount: 1,
        createdAt: nowIso(),
      });

      yield* harness.waitForDomainEvent((event) => event.type === "thread.reverted");

      const revertedThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
      );

      assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.deepEqual(
        revertedThread.messages.map((message) => ({ role: message.role, text: message.text })),
        [
          { role: "user", text: "First edit" },
          { role: "assistant", text: "Updated README to v2.\n" },
        ],
      );
      assert.equal(
        revertedThread.activities.some((activity) => activity.turnId === secondTurnId),
        false,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === firstTurnId && activity.kind === "tool.started",
        ),
        true,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === firstTurnId && activity.kind === "tool.completed",
        ),
        true,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(harness.workspaceDir, "README.md"), "utf8"),
        "v2\n",
      );
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
        false,
      );
      // Mastra-backed bots cannot rewind their own transcript; the revert still
      // completes instead of stopping after the workspace restore.
      assertNoRevertFailure(revertedThread);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });

      assert.equal(checkpointRows.length, 1);
    }),
  ),
);

it.live(
  "appends checkpoint.revert.failed activity when revert is requested without an active session",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-no-session"),
          threadId: THREAD_ID,
          turnCount: 0,
          createdAt: nowIso(),
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some(
            (activity) =>
              activity.kind === "checkpoint.revert.failed" &&
              typeof activity.payload === "object" &&
              activity.payload !== null,
          ),
        );

        const failureActivity = thread.activities.find(
          (activity) => activity.kind === "checkpoint.revert.failed",
        );

        assert.equal(failureActivity !== undefined, true);
        assert.equal(
          String(
            (failureActivity?.payload as { readonly detail?: string } | undefined)?.detail,
          ).includes("No active provider session"),
          true,
        );
      }),
    ),
);
