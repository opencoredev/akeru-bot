// @effect-diagnostics nodeBuiltinImport:off
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import {
  ClaudeAdapter,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
  completedTurn,
  usageLimitMessage,
  genericApiErrorMessage,
  rateLimitAssistant,
  rateLimitResult,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("completes with result usage without querying current context usage", () => {
    const harness = makeHarness();
    let getContextUsageCalls = 0;
    Object.assign(harness.query, {
      getContextUsage: async () => {
        getContextUsageCalls += 1;
        return {
          totalTokens: 999,
          maxTokens: 200000,
          isAutoCompactEnabled: true,
        };
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
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
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-1",
          role: "assistant",
          content: [],
          usage: { input_tokens: 80, output_tokens: 20 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-result-usage",
        uuid: "assistant-result-usage-2",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-result-usage-2",
          role: "assistant",
          content: [],
          usage: { input_tokens: 180, output_tokens: 20 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: { input_tokens: 400, output_tokens: 50 },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 200000, maxOutputTokens: 64000 },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(getContextUsageCalls, 0);
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload.usage, {
          usedTokens: 200,
          lastUsedTokens: 200,
          totalProcessedTokens: 450,
          inputTokens: 180,
          outputTokens: 20,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          maxTokens: 200000,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("preserves compacted usage when completion follows an older assistant frame", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
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
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-compacted-usage",
        uuid: "assistant-compacted-usage",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-compacted-usage",
          role: "assistant",
          content: [],
          usage: { input_tokens: 180, output_tokens: 20 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { pre_tokens: 200, post_tokens: 40 },
        session_id: "sdk-session-compacted-usage",
        uuid: "compact-boundary-usage",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 2,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-compacted-usage",
        usage: { input_tokens: 400, output_tokens: 50 },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 200000, maxOutputTokens: 64000 },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const finalUsageEvent = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload.usage, {
          usedTokens: 40,
          lastUsedTokens: 200,
          totalProcessedTokens: 450,
          maxTokens: 200000,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("fails a usage-limited turn with the limit it parked on", () => {
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
      const nowMs = yield* Clock.currentTimeMillis;
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.floor(nowMs / 1000) + 2 * 60 * 60,
        },
        session_id: "sdk-session-limit",
        uuid: "rate-limit-rejected",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "api_error",
        errors: [],
        session_id: "sdk-session-limit",
        uuid: "result-limit",
      } as unknown as SDKMessage);
      const payload = completedTurn(Array.from(yield* Fiber.join(runtimeEventsFiber)));
      assert.equal(payload.state, "failed");
      assert.equal(
        payload.errorMessage,
        "Claude usage limit reached. Send the message again once the limit resets.",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("resolves a usage-limit warning when Claude reports recovery", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "runtime.warning" && event.payload.resolved === true,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_800_000_000,
        },
        session_id: "sdk-session-limit-recovery",
        uuid: "rate-limit-rejected",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          resetsAt: 1_800_000_000,
        },
        session_id: "sdk-session-limit-recovery",
        uuid: "rate-limit-allowed",
      } as unknown as SDKMessage);

      const warnings = Array.from(yield* Fiber.join(runtimeEventsFiber)).filter(
        (event) => event.type === "runtime.warning",
      );
      assert.equal(warnings.length, 2);
      assert.equal(warnings[0]?.payload.key, "claude.rate-limit:five_hour");
      assert.equal(warnings[0]?.payload.resolved, undefined);
      assert.equal(warnings[1]?.payload.key, "claude.rate-limit:five_hour");
      assert.equal(warnings[1]?.payload.resolved, true);
      assert.equal(
        warnings[1]?.payload.message,
        "Claude usage limit recovered. Processing resumed.",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("names repeated usage limits without carrying them into a later turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      for (const [index, expected] of [
        usageLimitMessage,
        usageLimitMessage,
        genericApiErrorMessage,
      ].entries()) {
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
        if (index === 0) {
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
            session_id: "sdk-session-limit",
            uuid: "limit-rejected",
          } as unknown as SDKMessage);
        }
        if (index < 2) {
          harness.query.emit({
            ...rateLimitAssistant,
            uuid: `assistant-limit-${index}`,
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          ...rateLimitResult,
          uuid: `result-limit-${index}`,
        } as unknown as SDKMessage);
        const payload = completedTurn(Array.from(yield* Fiber.join(eventsFiber)));
        assert.equal(payload.state, "failed");
        assert.equal(payload.errorMessage, expected);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("emits thread token usage updates from Claude task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 321,
            lastUsedTokens: 321,
            toolUses: 2,
            durationMs: 654,
          },
        });
      }
      assert.equal(progressEvent?.type, "task.progress");
      if (usageEvent && progressEvent) {
        assert.notStrictEqual(usageEvent.eventId, progressEvent.eventId);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

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

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            cachedInputTokens: 21144,
            cacheCreationTokens: 2715,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("clamps oversized Claude usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

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

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
