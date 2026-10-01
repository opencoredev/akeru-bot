import * as Match from "effect/Match";
import {
  makeBroker,
  scope,
  makeHost,
  snapshotResult,
  recordingResult,
  type RoutedRequest,
  requestsFrom,
} from "./testUtils/previewAutomationBroker.ts";
import { expect, it } from "@effect/vitest";
import {
  PreviewAutomationClientDisconnectedError,
  PreviewTabId,
  type PreviewAutomationStreamEvent,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

it.effect("targets multiple tabs explicitly while retaining a default tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const appTabId = PreviewTabId.make("tab-web-app");
      const simulatorTabId = PreviewTabId.make("tab-ios-simulator");
      const openedTabIds = [appTabId, simulatorTabId];
      let openIndex = 0;
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);

        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { available: true, tabId: openedTabIds[openIndex++] }
              : snapshotResult,
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: { reuseExistingTab: false } });
      yield* broker.invoke({ scope, operation: "open", input: { reuseExistingTab: false } });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {}, tabId: appTabId });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests).toHaveLength(5);
      expect(routedRequests[0]?.tabId).toBeUndefined();
      expect(routedRequests[1]?.tabId).toBe(appTabId);
      expect(routedRequests[2]?.tabId).toBe(simulatorTabId);
      expect(routedRequests[2]?.tabIdExplicit).toBe(false);
      expect(routedRequests[3]?.tabId).toBe(appTabId);
      expect(routedRequests[3]?.tabIdExplicit).toBe(true);
      expect(routedRequests[4]?.tabId).toBe(appTabId);
    }),
  ),
);

it.effect("tracks the tab returned by a targeted recording stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const browsingTabId = PreviewTabId.make("tab-session-b");
      const recordingTabId = PreviewTabId.make("tab-session-a-recording");
      const routedRequests: RoutedRequest[] = [];
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) => {
        routedRequests.push(request);

        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: Match.value(request).pipe(
            Match.when({ operation: "open" }, (_request) => ({
              available: true,
              tabId: browsingTabId,
            })),
            Match.when({ operation: "recordingStop" }, (_request) =>
              recordingResult(recordingTabId),
            ),
            Match.orElse((_request) => snapshotResult),
          ),
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* broker.invoke({ scope, operation: "open", input: {} });
      yield* broker.invoke({ scope, operation: "recordingStop", input: {} });
      yield* broker.invoke({ scope, operation: "snapshot", input: {} });

      expect(routedRequests.at(-1)?.tabId).toBe(recordingTabId);
    }),
  ),
);

it.effect("announces a live replacement stream before delivering requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const events = yield* broker.connect(makeHost());
      const receivedTypes: PreviewAutomationStreamEvent["type"][] = [];

      const consumer = yield* events.pipe(
        Stream.take(2),
        Stream.runForEach((event) => {
          receivedTypes.push(event.type);

          return event.type === "connected"
            ? Effect.void
            : broker.respond({
                clientId: "client-1",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: "ready",
              });
        }),
        Effect.forkScoped,
      );

      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      yield* Fiber.join(consumer);

      expect(receivedTypes).toEqual(["connected", "request"]);
      expect(result).toBe("ready");
    }),
  ),
);

it.effect("keeps a replacement stream authoritative when the old stream finalizes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let firstConnectionId = "";
      let replacementConnectionId = "";

      const firstRequests = requestsFrom(yield* broker.connect(makeHost()), (connectionId) => {
        firstConnectionId = connectionId;
      });

      yield* Stream.runDrain(firstRequests).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const replacementRequests = requestsFrom(
        yield* broker.connect(makeHost()),
        (connectionId) => {
          replacementConnectionId = connectionId;
        },
      );

      yield* Stream.runForEach(replacementRequests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(replacementConnectionId).not.toBe(firstConnectionId);
      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      expect(result).toBe("replacement");
    }),
  ),
);

it.effect("does not carry a tab id across a replacement automation stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const openedTabId = PreviewTabId.make("tab-first-webcontents");
      const firstRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(firstRequests, (request) =>
        broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "open"
              ? { host: "first", tabId: openedTabId }
              : { host: "first" },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke({ scope, operation: "open", input: {} })).toEqual({
        host: "first",
        tabId: openedTabId,
      });

      const routedRequests: RoutedRequest[] = [];
      const replacementRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(replacementRequests, (request) => {
        routedRequests.push(request);

        return broker.respond({
          clientId: "client-1",
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: "replacement",
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      expect(yield* broker.invoke<string>({ scope, operation: "status", input: {} })).toBe(
        "replacement",
      );
      expect(routedRequests.at(-1)?.tabId).toBeUndefined();
    }),
  ),
);

it.effect("fails requests assigned to the stream that is replaced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(requests).pipe(Effect.forkScoped);

      const pending = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.yieldNow;

      const replacementRequests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runDrain(replacementRequests).pipe(Effect.forkScoped);

      const error = yield* Fiber.join(pending);
      expect(error).toBeInstanceOf(PreviewAutomationClientDisconnectedError);
      expect(error).toMatchObject({
        operation: "status",
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
        clientId: "client-1",
        requestId: "preview-0",
        timeoutMs: 15_000,
      });
    }),
  ),
);

it.effect("accepts responses only from the host that received the request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const requests = requestsFrom(yield* broker.connect(makeHost()));
      yield* Stream.runForEach(requests, (request) =>
        Effect.gen(function* () {
          yield* broker.respond({
            clientId: "client-foreign",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: "foreign",
          });
          yield* broker.respond({
            clientId: "client-1",
            connectionId: "connection-stale",
            requestId: request.requestId,
            ok: true,
            result: "stale",
          });
          yield* broker.respond({
            clientId: "client-1",
            connectionId: request.connectionId,
            requestId: request.requestId,
            ok: true,
            result: "owner",
          });
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* broker.invoke<string>({ scope, operation: "status", input: {} });
      expect(result).toBe("owner");
    }),
  ),
);
