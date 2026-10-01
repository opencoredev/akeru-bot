import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";
import { ApprovalRequestId, ProviderDriverKind, ThreadId } from "@akeru/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";
import {
  OpenCodeAdapter,
  asThreadId,
  providerSessionDirectoryTestLayer,
  openCodeAdapterTestSettings,
  advanceTestClock,
  makeOpenCodeAdapterHarness,
} from "./test-support/openCodeAdapterHarness.ts";

const { runtimeMock, OpenCodeRuntimeTestDouble, OpenCodeAdapterTestLayer } =
  makeOpenCodeAdapterHarness();

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("passes the thread title to session.create when provided", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-provided");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        title: "Investigate reconnect failures",
      });

      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal(
        runtimeMock.state.sessionCreateInputs[0]?.title,
        "Investigate reconnect failures",
      );
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("does not mirror OpenCode's default placeholder session titles", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-placeholder-title");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "New session - 2026-08-09T10:20:30.456Z",
            },
          },
        },
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate reconnect failures",
            },
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

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const metadataUpdated = events.filter((event) => event.type === "thread.metadata.updated");
      NodeAssert.equal(metadataUpdated.length, 1);

      if (metadataUpdated[0]?.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated[0].payload.name, "Investigate reconnect failures");
      }
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];

      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);

          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });

        yield* advanceTestClock(10);

        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);

        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect.each([
    {
      label: "wrapped 404",
      cause: new Error("Question not found", {
        cause: { status: 404, body: { name: "NotFoundError" } },
      }),
      retryable: false,
    },
    {
      label: "SDK QuestionNotFoundError body",
      cause: {
        _tag: "QuestionNotFoundError",
        requestID: "que_expired",
        message: "Question not found",
      },
      retryable: false,
    },
    {
      label: "temporary network failure",
      cause: new Error("Network unavailable"),
      retryable: true,
    },
    {
      label: "non-404 response containing a not-found body",
      cause: { status: 503, body: { _tag: "QuestionNotFoundError" } },
      retryable: true,
    },
  ])("handles question reply failure: $label", ({ cause, retryable }) =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-expired-question");
      runtimeMock.state.questionReplyError = cause;
      runtimeMock.state.subscribedEvents = [
        {
          type: "question.asked",
          properties: {
            id: "que_expired",
            sessionID: "http://127.0.0.1:9999/session",
            questions: [
              {
                question: "Which file?",
                header: "File",
                options: [{ label: "a.ts", description: "The first file" }],
              },
            ],
          },
        },
      ];

      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "user-input.requested",
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* Fiber.join(openedFiber).pipe(Effect.timeout("1 second"));

      const first = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("que_expired"), { File: "a.ts" })
        .pipe(Effect.flip);

      NodeAssert.ok(first._tag === "ProviderAdapterRequestError");
      NodeAssert.equal(first.retryable === true, retryable);

      if (!retryable) {
        NodeAssert.equal(first.detail, "Unknown pending user-input request: que_expired");
      }

      const second = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("que_expired"), { File: "a.ts" })
        .pipe(Effect.flip);

      NodeAssert.ok(second._tag === "ProviderAdapterRequestError");
      NodeAssert.equal(second.retryable === true, retryable);

      if (!retryable) {
        NodeAssert.equal(second.detail, "Unknown pending user-input request: que_expired");
      }

      NodeAssert.deepEqual(
        runtimeMock.state.questionReplyCalls,
        retryable ? ["que_expired", "que_expired"] : ["que_expired"],
      );

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("aborts a timed-out auto-reply before opening the fallback dialog", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-full-access-auto-reply-timeout");
      let startReply!: () => void;

      const replyStarted = new Promise<void>((resolve) => {
        startReply = resolve;
      });

      let aborted = false;
      runtimeMock.state.permissionReplyImplementation = (_requestID, _reply, signal) =>
        new Promise<void>((_resolve, reject) => {
          startReply();
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("permission reply aborted"));
            },
            { once: true },
          );
        });
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: "per_timeout",
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
      yield* Effect.promise(() => replyStarted);
      yield* TestClock.adjust("10 seconds");
      const opened = Option.getOrThrow(yield* Fiber.join(openedFiber));
      NodeAssert.equal(opened.requestId, "per_timeout");
      NodeAssert.equal(aborted, true);
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_timeout", reply: "once" },
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );
});
