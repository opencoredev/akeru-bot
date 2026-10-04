import { claudeMessage } from "./test-support/claudeMessages.ts";
import * as Predicate from "effect/Predicate";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import {
  ClaudeAdapter,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
  RESUME_THREAD_ID,
  encodeUnknownJsonString,
  completedTurn,
  AUTH_FAILURE_ASSISTANT,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect.each([
    {
      name: "an api_error terminal reason",
      result: { subtype: "success", is_error: false, terminal_reason: "api_error", errors: [] },
      state: "failed",
      errorMessage: /claude auth login/,
    },
    {
      name: "an is_error success with no terminal reason",
      result: { subtype: "success", is_error: true, errors: [] },
      state: "failed",
      errorMessage: /claude auth login/,
    },
    {
      name: "a terminal reason of its own",
      result: {
        subtype: "success",
        is_error: false,
        terminal_reason: "prompt_too_long",
        errors: [],
      },
      state: "failed",
      errorMessage: /prompt exceeds the model's context window/,
    },
    {
      name: "a listed tool failure",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool execution failed: EACCES"],
      },
      state: "failed",
      errorMessage: /EACCES/,
    },
    {
      name: "a user interrupt",
      result: {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: [],
      },
      state: "interrupted",
      errorMessage: undefined,
    },
    {
      name: "a cancellation",
      result: { subtype: "error_during_execution", is_error: true, errors: ["cancelled"] },
      state: "cancelled",
      errorMessage: /cancelled/,
    },
  ])(
    "reports the real cause when an expired login is followed by $name",
    ({ result, state, errorMessage }) => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        harness.query.emit(AUTH_FAILURE_ASSISTANT);
        harness.query.emit(
          claudeMessage({
            type: "result",
            ...result,
            session_id: "sdk-session-auth",
            uuid: "result-auth",
          }),
        );
        const payload = completedTurn(Array.from(yield* Fiber.join(runtimeEventsFiber)));
        assert.equal(payload.state, state);

        if (errorMessage === undefined) {
          assert.equal(payload.errorMessage, undefined);
        } else {
          assert.match(payload.errorMessage ?? "", errorMessage);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect.each([
    { homePath: "./synthetic config's $literal", inherited: undefined },
    { homePath: "", inherited: ".synthetic config's $literal" },
    { homePath: "", inherited: " /synthetic/path with edge spaces " },
  ])(
    "reports the same Claude config and cwd used by the spawned query ($homePath, $inherited)",
    ({ homePath, inherited }) => {
      const harness = makeHarness({
        claudeConfig: { homePath },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: inherited },
      });

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const cwd = NodePath.resolve("/tmp/synthetic-audit-project");

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          cwd,
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "synthetic",
          attachments: [],
        });
        harness.query.emit(AUTH_FAILURE_ASSISTANT);
        harness.query.emit(
          claudeMessage({
            type: "result",
            subtype: "success",
            is_error: false,
            terminal_reason: "api_error",
            errors: [],
            session_id: "sdk-session-auth",
            uuid: "result-auth",
          }),
        );
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.at(-1);
        assert(completed?.type === "turn.completed");
        const actualQuery = harness.getLastCreateQueryInput();
        assert(actualQuery !== undefined);
        const expectedConfigDir = homePath ? NodePath.resolve(homePath) : inherited;
        assert(expectedConfigDir !== undefined);
        assert.equal(actualQuery.options.env?.CLAUDE_CONFIG_DIR, expectedConfigDir);
        assert.equal(actualQuery.options.cwd, cwd);
        assert(
          completed.payload.errorMessage?.includes(
            `CLAUDE_CONFIG_DIR set to ${encodeUnknownJsonString(expectedConfigDir)}`,
          ),
        );
        assert(completed.payload.errorMessage?.includes(`from ${encodeUnknownJsonString(cwd)}`));
        assert(!completed.payload.errorMessage?.includes("CLAUDE_CONFIG_DIR="));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-thread-real",
          uuid: "stream-thread-real",
          parent_tool_use_id: null,
          event: {
            type: "message_start",
            message: {
              id: "msg-thread-real",
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-thread-real",
          uuid: "result-thread-real",
        }),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");

      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");

      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit(
        claudeMessage({
          type: "system",
          subtype: "hook_started",
          hook_id: "resume-hook-1",
          hook_name: "SessionStart:resume",
          hook_event: "SessionStart",
          session_id: transientHookSessionId,
          uuid: "resume-hook-started",
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "system",
          subtype: "hook_response",
          hook_id: "resume-hook-1",
          hook_name: "SessionStart:resume",
          hook_event: "SessionStart",
          output: "",
          stdout: "",
          stderr: "",
          outcome: "success",
          session_id: transientHookSessionId,
          uuid: "resume-hook-response",
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "system",
          subtype: "init",
          apiKeySource: "none",
          claude_code_version: "test",
          cwd: "/tmp/claude-adapter-test",
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-4-5",
          permissionMode: "bypassPermissions",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          session_id: durableSessionId,
          uuid: "resume-init",
        }),
      );

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");

      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();

      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;

      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();

      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };

      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.isTrue(Predicate.isString(sessionResumeCursor.resume));
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect(
    "supports rollbackThread by trimming in-memory turns and preserving earlier turns",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit(
          claudeMessage({
            type: "result",
            subtype: "success",
            is_error: false,
            errors: [],
            session_id: "sdk-session-rollback",
            uuid: "result-first",
          }),
        );

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");

        if (
          Predicate.isTagged(firstCompleted, "Some") &&
          firstCompleted.value.type === "turn.completed"
        ) {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit(
          claudeMessage({
            type: "result",
            subtype: "success",
            is_error: false,
            errors: [],
            session_id: "sdk-session-rollback",
            uuid: "result-second",
          }),
        );

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");

        if (
          Predicate.isTagged(secondCompleted, "Some") &&
          secondCompleted.value.type === "turn.completed"
        ) {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1);
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(rolledBack.turns[0]?.id, firstTurn.turnId);

        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 1);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({ instanceId: customInstanceId });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "200k" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]", "claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
