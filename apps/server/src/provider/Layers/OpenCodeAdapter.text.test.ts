import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { beforeEach } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";
import {
  OpenCodeAdapter,
  asThreadId,
  providerSessionDirectoryTestLayer,
  openCodeAdapterTestSettings,
  makeOpenCodeAdapterHarness,
} from "./test-support/openCodeAdapterHarness.ts";

const { runtimeMock, OpenCodeRuntimeTestDouble, OpenCodeAdapterTestLayer } =
  makeOpenCodeAdapterHarness();

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect(
    "forks the resumed session into the requested directory instead of losing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-cwd");
        // The persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set("ses_otherdir", "/some/other/worktree");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_otherdir" },
        });

        // A cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_otherdir"]);
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_otherdir");
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, "string");
        // Permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_otherdir_fork");
        // Durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "ses_otherdir_fork",
        });

        yield* adapter.stopSession(threadId);
      }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("keeps private memory context out of user-authored prompt parts", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-private-memory-context");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "  visible user text  ",
        persistentMemoryContext: "private memory context",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        system: "private memory context",
        parts: [{ type: "text", text: "  visible user text  " }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reverts the first removed assistant message and returns only retained turns", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        { info: { id: "user-1", role: "user" }, parts: [] },
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [{ id: "part-1", type: "text", text: "first answer" }],
        },
        { info: { id: "user-2", role: "user" }, parts: [] },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [{ id: "part-2", type: "text", text: "second answer" }],
        },
      ];

      for (const numTurns of [0, 1, 2, 3]) {
        runtimeMock.state.revertMessageID = undefined;
        runtimeMock.state.revertCalls.length = 0;
        const snapshot = yield* adapter.rollbackThread(threadId, numTurns);
        NodeAssert.deepEqual(
          runtimeMock.state.revertCalls,
          numTurns === 0
            ? []
            : [
                {
                  sessionID: "http://127.0.0.1:9999/session",
                  messageID: numTurns === 1 ? "assistant-2" : "assistant-1",
                },
              ],
        );
        NodeAssert.deepEqual(
          snapshot.turns.map((turn) => turn.id),
          ["assistant-1", "assistant-2"].slice(0, Math.max(0, 2 - numTurns)),
        );
      }
      runtimeMock.state.revertMessageID = undefined;
      for (const remaining of [1, 0]) {
        const snapshot = yield* adapter.rollbackThread(threadId, 1);
        NodeAssert.equal(snapshot.turns.length, remaining);
        NodeAssert.deepEqual((yield* adapter.readThread(threadId)).turns, snapshot.turns);
      }
      NodeAssert.deepEqual(
        runtimeMock.state.revertCalls.slice(-2).map((call) => call.messageID),
        ["assistant-2", "assistant-1"],
      );
      runtimeMock.state.revertMessageID = undefined;
      runtimeMock.state.messages = runtimeMock.state.messages.filter(
        (entry) => entry.info.id !== "user-2",
      );
      const sharedUserSnapshot = yield* adapter.rollbackThread(threadId, 1);
      NodeAssert.equal(runtimeMock.state.revertMessageID, "user-1");
      NodeAssert.deepEqual(sharedUserSnapshot.turns, []);
      NodeAssert.deepEqual((yield* adapter.readThread(threadId)).turns, []);

      runtimeMock.state.messages = [];
      runtimeMock.state.revertCalls.length = 0;
      const emptySnapshot = yield* adapter.rollbackThread(threadId, 1);
      NodeAssert.deepEqual(runtimeMock.state.revertCalls, []);
      NodeAssert.deepEqual(emptySnapshot.turns, []);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("applies late assistant metadata without scanning historical tool parts", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-text-index");
      const sessionID = "http://127.0.0.1:9999/session";
      const toolEvents = Array.from({ length: 24 }, (_, index) => ({
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: `tool-${index}`,
            messageID: "msg-tools",
            type: "tool",
            tool: "bash",
            callID: `call-${index}`,
            state: {
              status: "completed",
              output: "x".repeat(1024),
              time: { start: 1, end: 2 },
            },
          },
        },
      }));
      runtimeMock.state.subscribedEvents = [
        ...toolEvents,
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: "text-1",
              messageID: "msg-assistant",
              type: "text",
              text: "Hello",
              time: { start: 1 },
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id: "msg-assistant", role: "assistant" },
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "content.delta"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const delta = Option.getOrThrow(
        yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(delta.type, "content.delta");
      if (delta.type === "content.delta") {
        NodeAssert.equal(delta.payload.delta, "Hello");
      }
      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("does not re-emit an individually removed text part", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-removed-text-part");
      const sessionID = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id: "msg-assistant", role: "assistant" },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: "removed-text-part",
              messageID: "msg-assistant",
              type: "text",
              text: "stale text that was removed",
              time: { start: 1 },
            },
          },
        },
        {
          type: "message.part.removed",
          properties: {
            sessionID,
            messageID: "msg-assistant",
            partID: "removed-text-part",
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id: "msg-assistant", role: "assistant" },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: "retained-text-part",
              messageID: "msg-assistant",
              type: "text",
              text: "replacement text",
              time: { start: 2 },
            },
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "content.delta"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const deltas = Array.from(
        yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")),
      ).map((event) => (event.type === "content.delta" ? event.payload.delta : undefined));
      NodeAssert.deepEqual(deltas, ["stale text that was removed", "replacement text"]);
      yield* adapter.stopSession(threadId);
    }),
  );
});
