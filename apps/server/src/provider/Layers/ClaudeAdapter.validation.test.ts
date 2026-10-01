import { claudeMessage } from "./test-support/claudeMessages.ts";
import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProviderDriverKind, ProviderRuntimeEvent } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";
import {
  decodeClaudeSettings,
  ClaudeAdapter,
  FakeClaudeQuery,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
  RESUME_THREAD_ID,
  completedTurn,
  usageLimitMessage,
  genericApiErrorMessage,
  rateLimitAssistant,
  rateLimitResult,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");

      if (!Predicate.isTagged(result, "Failure")) {
        return;
      }

      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          stop_reason: "tool_use",
          session_id: "sdk-session-abort",
          uuid: "result-abort",
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
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");

      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("treats aborted_tools results as interrupted and hides ede_diagnostic errors", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Exact shape the CLI emits when Stop lands mid-tool-call: is_error
      // is true and the only error is internal diagnostic telemetry.
      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
          stop_reason: "tool_use",
          terminal_reason: "aborted_tools",
          session_id: "sdk-session-abort-tools",
          uuid: "result-abort-tools",
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
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");

      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect.each([
    {
      name: "an assistant-only rate limit",
      messages: [rateLimitAssistant],
      expected: usageLimitMessage,
    },
    {
      name: "a normal parent response after a rate limit",
      messages: [rateLimitAssistant, { ...rateLimitAssistant, error: undefined }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a server error after a rate limit",
      messages: [rateLimitAssistant, { ...rateLimitAssistant, error: "server_error" }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a subagent rate limit",
      messages: [{ ...rateLimitAssistant, parent_tool_use_id: "nested-tool" }],
      expected: genericApiErrorMessage,
    },
    {
      name: "a subagent response after a parent rate limit",
      messages: [
        rateLimitAssistant,
        { ...rateLimitAssistant, error: undefined, parent_tool_use_id: "nested-tool" },
      ],
      expected: usageLimitMessage,
    },
  ])("classifies the terminal API failure after $name", ({ messages, expected }) => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const eventsFiber = yield* adapter.streamEvents.pipe(
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

      for (const [index, message] of messages.entries()) {
        harness.query.emit(claudeMessage({ ...message, uuid: `assistant-${index}` }));
      }

      harness.query.emit(claudeMessage(rateLimitResult));
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const errors = events.filter((event) => event.type === "runtime.error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.payload.message, expected);
      assert.equal(completedTurn(events).state, "failed");
      assert.equal(completedTurn(events).errorMessage, expected);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("keeps the session available when process close fails", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.closeError = new Error("close failed");

      const result = yield* adapter.interruptTurn(session.threadId).pipe(Effect.result);

      assert.equal(result._tag, "Failure");

      if (Predicate.isTagged(result, "Failure")) {
        assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      }

      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("stopAll attempts every session when one process close fails", () => {
    const queries: FakeClaudeQuery[] = [];

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});

        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);

            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const firstQuery = queries[0];

      if (!firstQuery) {
        return;
      }

      firstQuery.closeError = new Error("close failed");

      const result = yield* adapter.stopAll().pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(yield* adapter.hasSession(RESUME_THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("keeps a resumed replacement session after interrupt cleanup", () => {
    const queries: FakeClaudeQuery[] = [];

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});

        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);

            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type.startsWith("session.")),
        Stream.take(7),
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: firstSession.threadId,
        input: "hello",
        attachments: [],
      });

      yield* adapter.interruptTurn(firstSession.threadId);
      assert.equal(queries[0]?.closeCalls, 1);

      const replacement = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const activeSessions = yield* adapter.listSessions();
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(queries.length, 2);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, replacement.resumeCursor);
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type.startsWith("session."))
          .map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.exited",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");

      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("keeps Claude stream failure events structural", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("credential material that must stay in the cause chain"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");

      if (runtimeError?.type === "runtime.error") {
        assert.equal(runtimeError.payload.message, "Claude runtime stream failed.");
        assert.deepEqual(runtimeError.payload.detail, {
          failureCount: 1,
          failureTags: ["ProviderAdapterProcessError"],
        });
      }

      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");

      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, "Claude runtime stream failed.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("closes the previous session before replacing an existing thread session", () => {
    const queries: FakeClaudeQuery[] = [];

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});

        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);

            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const activeSessions = yield* adapter.listSessions();

      assert.equal(queries.length, 2);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, secondSession.resumeCursor);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });
});
