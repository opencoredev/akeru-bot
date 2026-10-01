import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";
import { ProviderDriverKind } from "@akeru/contracts";
import {
  OpenCodeAdapter,
  asThreadId,
  OpenCodePermissionReplyTimeoutError,
  makeOpenCodeAdapterHarness,
} from "./test-support/openCodeAdapterHarness.ts";

const { runtimeMock, OpenCodeAdapterTestLayer } = makeOpenCodeAdapterHarness();

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("re-applies the current runtimeMode permissions when resuming", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-perms");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        // A different runtimeMode than the original create — resume must not
        // leave the upstream session on stale permissions.
        runtimeMode: "approval-required",
        threadId,
        resumeCursor: { schemaVersion: 1, sessionId: "ses_perms" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_perms"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_perms");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("routes child-session permission asks onto the parent thread", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-permission");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.created",
          properties: {
            sessionID: "ses_child",
            info: { id: "ses_child", parentID: rootSessionId },
          },
        },
        {
          type: "permission.asked",
          properties: {
            id: "per_child",
            sessionID: "ses_child",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: [],
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const opened = Option.getOrThrow(
        yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened.type, "request.opened");
      if (opened.type === "request.opened") {
        NodeAssert.equal(opened.requestId, "per_child");
        NodeAssert.equal(opened.payload.requestType, "command_execution_approval");
        NodeAssert.equal(opened.payload.detail, "git status");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("ignores permission asks from unrelated OpenCode sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-unrelated-permission");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "per_unrelated",
            sessionID: "ses_unrelated",
            permission: "bash",
            patterns: ["rm -rf /"],
            metadata: {},
            always: [],
          },
        },
      ];
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.timeoutOption("50 millis"),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* TestClock.adjust("5 seconds");
      const opened = yield* Fiber.join(openedFiber);
      NodeAssert.equal(Option.isNone(opened), true);

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("recovers a child permission after session ancestry lookup", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-ancestry");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.sessionParentById.set("ses_nested_child", rootSessionId);
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "per_nested",
            sessionID: "ses_nested_child",
            permission: "edit",
            patterns: ["src/app.ts"],
            metadata: {},
            always: [],
          },
        },
      ];
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* TestClock.adjust("250 millis");
      const opened = Option.getOrThrow(
        yield* Fiber.join(openedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened.requestId, "per_nested");

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("forwards a child permission reply that arrives while ancestry is still unknown", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-reply-during-retry");
      const rootSessionId = "http://127.0.0.1:9999/session";
      let releaseChildGet: (() => void) | undefined;
      const childGetGate = new Promise<void>((resolve) => {
        releaseChildGet = resolve;
      });
      runtimeMock.state.sessionParentById.set("ses_child", rootSessionId);
      runtimeMock.state.sessionGetHold = async (sessionID) => {
        if (sessionID === "ses_child") {
          await childGetGate;
        }
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "per_child",
            sessionID: "ses_child",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: [],
          },
        },
        {
          type: "permission.replied",
          properties: {
            sessionID: "ses_child",
            requestID: "per_child",
            reply: "once",
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      releaseChildGet?.();
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["request.opened", "request.resolved"],
      );
      NodeAssert.equal(events[0]?.requestId, "per_child");
      NodeAssert.equal(events[1]?.requestId, "per_child");

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("auto-replies full-access permission asks once without opening a dialog", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-full-access-auto-reply");
      let markReplyCompleted!: () => void;
      const replyCompleted = new Promise<void>((resolve) => {
        markReplyCompleted = resolve;
      });
      runtimeMock.state.permissionReplyImplementation = async () => {
        markReplyCompleted();
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "per_full",
            sessionID: "http://127.0.0.1:9999/session",
            permission: "bash",
            patterns: ["git status"],
            metadata: {},
            always: [],
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => replyCompleted).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () =>
            Effect.fail(
              new OpenCodePermissionReplyTimeoutError({
                message: "OpenCode permission reply did not complete",
              }),
            ),
        }),
        TestClock.withLive,
      );
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_full", reply: "once" },
      ]);
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("falls back to a permission dialog when full-access auto-reply fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-full-access-auto-reply-fail");
      runtimeMock.state.permissionReplyError = new Error("reply failed");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "per_fail",
            sessionID: "http://127.0.0.1:9999/session",
            permission: "edit",
            patterns: ["src/app.ts"],
            metadata: {},
            always: [],
          },
        },
      ];
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const opened = Option.getOrThrow(
        yield* Fiber.join(openedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened.requestId, "per_fail");

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
