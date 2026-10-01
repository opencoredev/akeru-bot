import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MessageId } from "./baseSchemas.ts";
import {
  decodeThreadTurnStartCommand,
  decodeThreadTurnStartRequestedPayload,
  decodeOrchestrationLatestTurn,
  decodeOrchestrationProposedPlan,
  decodeOrchestrationCommand,
  decodeDispatchCommandError,
} from "./orchestration.test-support.ts";

it.effect("decodes a dispatch error after its bootstrap thread was deleted", () =>
  Effect.gen(function* () {
    const error = yield* decodeDispatchCommandError({
      _tag: "OrchestrationDispatchCommandError",
      message: "Failed to create worktree.",
      bootstrapThreadDisposition: "deleted",
    });

    assert.strictEqual(error.bootstrapThreadDisposition, "deleted");
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "t3code/example",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.startFromOrigin, true);
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("drops the retired title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.ok(!("titleSeed" in parsed));
  }),
);

it.effect("accepts a title regeneration intent in thread.meta.update", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.meta.update",
      commandId: "cmd-title-regenerate",
      threadId: "thread-1",
      regenerateTitle: true,
    });

    assert.strictEqual(parsed.type, "thread.meta.update");

    if (parsed.type === "thread.meta.update") {
      assert.strictEqual(parsed.regenerateTitle, true);
    }
  }),
);

it.effect("accepts a linked pull request in thread.meta.update", () =>
  Effect.gen(function* () {
    const linkedPullRequest = {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
    };

    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.meta.update",
      commandId: "cmd-link-pull-request",
      threadId: "thread-1",
      linkedPullRequest,
    });

    assert.strictEqual(parsed.type, "thread.meta.update");

    if (parsed.type === "thread.meta.update") {
      assert.deepStrictEqual(parsed.linkedPullRequest, linkedPullRequest);
    }
  }),
);

it.effect("accepts an internal title regeneration completion", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.title.regeneration.complete",
      commandId: "cmd-title-regeneration-complete",
      threadId: "thread-1",
      requestId: "cmd-title-regenerate",
      title: "Updated title",
    });

    assert.strictEqual(parsed.type, "thread.title.regeneration.complete");

    if (parsed.type === "thread.title.regeneration.complete") {
      assert.strictEqual(parsed.requestId, "cmd-title-regenerate");
      assert.strictEqual(parsed.title, "Updated title");
    }
  }),
);

it.effect("rejects an explicit title combined with title regeneration", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.meta.update",
        commandId: "cmd-title-regenerate-with-title",
        threadId: "thread-1",
        title: "Explicit title",
        regenerateTitle: true,
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("drops the retired title seed from thread.turn-start-requested events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.ok(!("titleSeed" in parsed));
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestMessageId: "msg-2",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });

    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
    assert.strictEqual(parsed.requestMessageId, MessageId.make("msg-2"));
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);
