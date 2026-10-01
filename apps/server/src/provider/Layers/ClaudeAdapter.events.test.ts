import { claudeMessage } from "./test-support/claudeMessages.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";
import {
  decodeClaudeSettings,
  ClaudeAdapter,
  makeHarness,
  makeDeterministicRandomService,
  THREAD_ID,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("retains Claude session startup causes without exposing their messages", () => {
    const cause = new Error("credential material that must remain in the cause chain");

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});

        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: () => {
            throw cause;
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

      const error = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderAdapterProcessError);
      assert.equal(error.detail, "Failed to start Claude runtime session.");
      assert.strictEqual(error.cause, cause);
      assert.notMatch(error.message, /credential material/u);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-1",
          uuid: "stream-0",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: "",
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-1",
          uuid: "stream-1",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Hi",
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-1",
          uuid: "stream-2",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 0,
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-1",
          uuid: "stream-3",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: {
                command: "ls",
              },
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-1",
          uuid: "stream-4",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 1,
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "assistant",
          session_id: "sdk-session-1",
          uuid: "assistant-1",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-1",
            content: [{ type: "text", text: "Hi" }],
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-1",
          uuid: "result-1",
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
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");

      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");

      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");

      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );

      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");

      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
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
          type: "stream_event",
          session_id: "sdk-session-tool-streams",
          uuid: "stream-thinking",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "thinking_delta",
              thinking: "Let",
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-tool-streams",
          uuid: "stream-tool-start",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-grep-1",
              name: "Grep",
              input: {},
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-tool-streams",
          uuid: "stream-tool-input-1",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: '{"pattern":"foo","path":"src"}',
            },
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "stream_event",
          session_id: "sdk-session-tool-streams",
          uuid: "stream-tool-stop",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 1,
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "user",
          session_id: "sdk-session-tool-streams",
          uuid: "user-tool-result",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-grep-1",
                content: "src/example.ts:1:foo",
              },
            ],
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-tool-streams",
          uuid: "result-tool-streams",
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
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );

      assert.equal(reasoningDelta?.type, "content.delta");

      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");

      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );

      assert.equal(toolInputUpdated?.type, "item.updated");

      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );

      assert.equal(toolResultUpdated?.type, "item.updated");

      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
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
            type: "assistant",
            session_id: "sdk-session-early-assistant",
            uuid: "assistant-early",
            parent_tool_use_id: null,
            message: {
              id: "assistant-message-early",
              content: [
                { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
              ],
            },
          }),
        );

        harness.query.emit(
          claudeMessage({
            type: "stream_event",
            session_id: "sdk-session-early-assistant",
            uuid: "stream-early",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: "Late text",
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
            session_id: "sdk-session-early-assistant",
            uuid: "result-early",
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
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");

        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
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
          type: "assistant",
          session_id: "sdk-session-fallback-text",
          uuid: "assistant-fallback",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-fallback",
            content: [{ type: "text", text: "Fallback hello" }],
          },
        }),
      );

      harness.query.emit(
        claudeMessage({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-fallback-text",
          uuid: "result-fallback",
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
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");

      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
