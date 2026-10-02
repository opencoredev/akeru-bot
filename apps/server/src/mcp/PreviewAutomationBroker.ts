import {
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationTimeoutError,
  type PreviewAutomationError,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { stagePreviewSnapshot } from "./PreviewSnapshotCaptureBuffer.ts";
import { redactProviderVisiblePreviewResult } from "./PreviewSnapshotRedaction.ts";
import {
  type PreviewAutomationInvokeInput,
  type ClientConnection,
  type PendingRequest,
  type PreviewAutomationRequestErrorContext,
  type BrokerState,
} from "./PreviewAutomationState.ts";
import {
  removeConnectionFromState,
  hostAssignmentKey,
  supportsOperation,
} from "./PreviewAutomationRouting.ts";
import {
  selectorDiagnosticsFromInput,
  readResultTabId,
  classifyResponseError,
} from "./PreviewAutomationResponses.ts";

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
  }
>()("akeru-bot/mcp/PreviewAutomationBroker") {}

export const make = Effect.gen(function* PreviewAutomationBrokerMake() {
  const crypto = yield* Crypto.Crypto;

  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    pending: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnectionFromState(current, clientId, queue);

      return [removed.disconnected, removed.state] as const;
    });

    yield* closeConnection(queue, disconnected);
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });

    const connection: ClientConnection = {
      clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      focused: false,
      focusOrder: 0,
      queue,
    };

    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.clients.get(clientId);

      const removed = previousConnection
        ? removeConnectionFromState(current, clientId, previousConnection.queue)
        : { state: current, disconnected: [] };

      const clients = new Map(removed.state.clients);
      const focusSequence = removed.state.focusSequence + 1;
      const registeredConnection = { ...connection, focusOrder: focusSequence };
      clients.set(clientId, registeredConnection);

      return [
        {
          previousConnection,
          disconnected: removed.disconnected,
          registeredConnection,
        },
        { ...removed.state, clients, focusSequence },
      ] as const;
    });

    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.disconnected);
    }

    return registration.registeredConnection;
  });

  const connect: PreviewAutomationBroker["Service"]["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )((host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireConnection(host), (connection) =>
          disconnect(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const focusHost: PreviewAutomationBroker["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationBroker.focusHost",
  )(function* (host) {
    yield* SynchronizedRef.update(state, (current) => {
      const currentHost = current.clients.get(host.clientId);

      if (
        !currentHost ||
        currentHost.environmentId !== host.environmentId ||
        currentHost.connectionId !== host.connectionId
      ) {
        return current;
      }

      const clients = new Map(current.clients);
      const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
      clients.set(host.clientId, {
        ...currentHost,
        focused: host.focused,
        focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
      });

      return { ...current, clients, focusSequence };
    });
  });

  const respond: PreviewAutomationBroker["Service"]["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);

      if (
        !entry ||
        entry.context.clientId !== response.clientId ||
        entry.context.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }

      const next = new Map(current.pending);
      next.delete(response.requestId);

      return [entry, { ...current, pending: next }] as const;
    });

    if (!pending) return;

    if (response.ok) {
      yield* Effect.try({
        try: () => redactProviderVisiblePreviewResult(pending.context.operation, response.result),
        catch: () => new PreviewAutomationMalformedResponseError(pending.context),
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) => Deferred.fail(pending.deferred, error),
          onSuccess: (result) =>
            Effect.sync(() => {
              if (pending.context.operation === "snapshot") {
                stagePreviewSnapshot(pending.context.threadId, response.result);
              }
            }).pipe(Effect.andThen(Deferred.succeed(pending.deferred, result))),
        }),
      );
    } else {
      yield* Deferred.fail(
        pending.deferred,
        response.error
          ? classifyResponseError(pending.context, response.error)
          : new PreviewAutomationMalformedResponseError(pending.context),
      );
    }
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();

    const route = yield* SynchronizedRef.modify(state, (current) => {
      const assignments = new Map(
        Array.from(current.assignments).filter(([, assignment]) => {
          const connection = current.clients.get(assignment.clientId);

          return (
            connection?.connectionId === assignment.connectionId &&
            connection.queue === assignment.queue
          );
        }),
      );

      const assignmentKey = hostAssignmentKey(input.scope);
      const assigned = assignments.get(assignmentKey);
      const assignedConnection = assigned ? current.clients.get(assigned.clientId) : undefined;
      const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;

      // Keep one provider session on one physical desktop runtime so a
      // multi-step browser interaction cannot jump between independent
      // Electron cookie/DOM state. A live assignment that predates an
      // operation is not silently moved to a newer client: the caller gets a
      // capability failure and can deliberately start a fresh provider
      // session. A dead lease is pruned above and may fail over.
      const connection =
        hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
          ? assignedConnection
          : hasLiveAssignment
            ? undefined
            : Array.from(current.clients.values())
                .filter(
                  (host) =>
                    host.environmentId === input.scope.environmentId &&
                    supportsOperation(host, input.operation),
                )
                .sort(
                  (left, right) =>
                    right.supportedOperations.size - left.supportedOperations.size ||
                    Number(right.focused) - Number(left.focused) ||
                    right.focusOrder - left.focusOrder,
                )[0];

      if (!connection) {
        if (!hasLiveAssignment) assignments.delete(assignmentKey);

        return [undefined, { ...current, assignments }] as const;
      }

      const canReuseAssignedTab =
        assigned !== undefined &&
        assigned.connectionId === connection.connectionId &&
        assigned.queue === connection.queue;

      assignments.set(assignmentKey, {
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        queue: connection.queue,
        ...(canReuseAssignedTab && assigned.tabId !== undefined ? { tabId: assigned.tabId } : {}),
        ...(canReuseAssignedTab && assigned.tabSequence !== undefined
          ? { tabSequence: assigned.tabSequence }
          : {}),
      });

      const requestSequence = current.requestSequence;
      const requestId = `preview-${requestSequence}`;
      const tabId = input.tabId ?? (canReuseAssignedTab ? assigned.tabId : undefined);
      const selectorDiagnostics = selectorDiagnosticsFromInput(input.input);

      const context: PreviewAutomationRequestErrorContext = {
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        clientId: connection.clientId,
        connectionId: connection.connectionId,
        requestId,
        ...(tabId === undefined ? {} : { tabId }),
        timeoutMs,
        ...selectorDiagnostics,
      };

      const pending = new Map(current.pending);
      pending.set(requestId, { queue: connection.queue, deferred, context });

      return [
        { connection, requestId, requestContext: context, requestSequence },
        { ...current, assignments, pending, requestSequence: current.requestSequence + 1 },
      ] as const;
    });

    if (!route) {
      return yield* new PreviewAutomationNoAvailableHostError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
      });
    }

    const { connection, requestId, requestContext, requestSequence } = route;

    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);

      return { ...next, pending };
    });

    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* Queue.offer(connection.queue, {
        type: "request",
        connectionId: connection.connectionId,
        request: {
          requestId,
          threadId: input.scope.threadId,
          tabId: requestContext.tabId,
          tabIdExplicit: input.tabId !== undefined,
          operation: input.operation,
          input: input.input,
          timeoutMs,
        },
      });

      if (!offered) {
        const completion = yield* Deferred.poll(deferred);

        if (Option.isSome(completion)) {
          // SAFETY: The caller selects A for its operation; the browser host supplies the operation result through the correlated deferred.
          return (yield* completion.value) as A;
        }

        return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
      }

      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));

      // SAFETY: The caller selects A for its operation; the browser host supplies the operation result through the correlated deferred.
      return yield* Option.match(result, {
        onNone: () => Effect.fail(new PreviewAutomationTimeoutError(requestContext)),
        onSome: (value) => Effect.succeed(value as A),
      });
    });

    const result = yield* awaitResponse().pipe(Effect.ensuring(removePending));
    const responseTabId = readResultTabId(result);
    const resultTabId = responseTabId === undefined ? input.tabId : responseTabId;

    if (resultTabId === undefined) return result;
    const assignmentKey = hostAssignmentKey(input.scope);
    yield* SynchronizedRef.update(state, (current) => {
      const assignment = current.assignments.get(assignmentKey);

      if (
        !assignment ||
        assignment.connectionId !== connection.connectionId ||
        assignment.queue !== connection.queue ||
        (assignment.tabSequence ?? -1) > requestSequence
      ) {
        return current;
      }

      const assignments = new Map(current.assignments);

      if (resultTabId === null) {
        const { tabId: _tabId, ...withoutTabId } = assignment;
        assignments.set(assignmentKey, { ...withoutTabId, tabSequence: requestSequence });
      } else {
        assignments.set(assignmentKey, {
          ...assignment,
          ...(resultTabId === undefined ? {} : { tabId: resultTabId }),
          tabSequence: requestSequence,
        });
      }

      return { ...current, assignments };
    });

    return result;
  });

  return PreviewAutomationBroker.of({ connect, focusHost, respond, invoke });
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const layer = Layer.effect(PreviewAutomationBroker, make);

export type { PreviewAutomationInvokeInput } from "./PreviewAutomationState.ts";
