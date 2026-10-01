import type { AkeruMastraHarness } from "../../AkeruMastraHarness.ts";
import type { AgentControllerShape } from "../../Services/AgentController.ts";
import { ThreadIdBrand, toProviderSession } from "./Policy.ts";

import { type ProviderRuntimeEvent } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as PubSub from "effect/PubSub";

import * as Stream from "effect/Stream";

import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";

import { AgentControllerRuntimeError } from "../../Errors.ts";

import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import { type ResolvedEngine, type ActiveSession, type LegacyTurnMemoryState } from "./State.ts";
import { recordProviderAccessHealth } from "./ProviderAccess.ts";

export function createAuxiliaryOperations({
  bundle,
  runMastra,
  legacyProviderBridge,
  sessions,
  runtimeEvents,
  legacyHiddenWakeByTurn,
  legacyPending,
  subscriptionAuth,
  resolvedByThread,
  legacyBufferedTerminals,
  drainLegacyTerminals,
}: {
  readonly bundle: AkeruMastraHarness;
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError>;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly sessions: Map<string, ActiveSession>;
  readonly runtimeEvents: PubSub.PubSub<ProviderRuntimeEvent>;
  readonly legacyHiddenWakeByTurn: Map<string, boolean>;
  readonly legacyPending: (key: string) => LegacyTurnMemoryState[];
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly resolvedByThread: Map<string, ResolvedEngine>;
  readonly legacyBufferedTerminals: Map<string, Map<string, ProviderRuntimeEvent>>;
  readonly drainLegacyTerminals: (key: string) => Effect.Effect<void>;
}) {
  return {
    readConversationMemory: (threadId) =>
      bundle.readObservationalMemory
        ? runMastra("memory.read", () =>
            bundle.readObservationalMemory!(String(threadId), String(threadId)),
          )
        : Effect.fail(
            new AgentControllerRuntimeError({
              operation: "memory.read",
              detail: "Conversation memory is unavailable.",
            }),
          ),
    clearConversationMemory: (threadId) =>
      bundle.clearObservationalMemory
        ? runMastra("memory.clear", () =>
            bundle.clearObservationalMemory!(String(threadId), String(threadId)),
          )
        : Effect.fail(
            new AgentControllerRuntimeError({
              operation: "memory.clear",
              detail: "Conversation memory is unavailable.",
            }),
          ),
    restoreConversationMemory: (threadId, snapshot, expectedSnapshot) =>
      bundle.restoreObservationalMemory
        ? runMastra("memory.restore", () =>
            bundle.restoreObservationalMemory!(
              String(threadId),
              snapshot,
              String(threadId),
              expectedSnapshot,
            ),
          )
        : Effect.fail(
            new AgentControllerRuntimeError({
              operation: "memory.restore",
              detail: "Conversation memory restoration is unavailable.",
            }),
          ),
    listSessions: () =>
      Effect.map(legacyProviderBridge.listSessions(), (legacySessions) => [
        ...legacySessions,
        ...[...sessions.entries()].map(([threadId, active]) =>
          toProviderSession(ThreadIdBrand(threadId), active),
        ),
      ]),
    get streamEvents() {
      return Stream.merge(legacyProviderBridge.streamEvents, Stream.fromPubSub(runtimeEvents)).pipe(
        Stream.map((event) => {
          if (event.type !== "turn.started") return event;
          const key = String(event.threadId);

          const hiddenWake =
            event.turnId === undefined
              ? false
              : legacyHiddenWakeByTurn.get(`${key}:${String(event.turnId)}`) === true ||
                legacyPending(key).some(
                  (pending) => !pending.dispatchReturned && pending.hiddenWake,
                );

          return hiddenWake ? { ...event, payload: { ...event.payload, hiddenWake: true } } : event;
        }),
        Stream.tap((event) =>
          Effect.gen(function* () {
            const key = String(event.threadId);
            recordProviderAccessHealth(
              subscriptionAuth,
              event,
              resolvedByThread.get(key)?.modelSelection.model,
            );

            if (sessions.has(key)) return;
            const pendingTurns = legacyPending(key);

            if (pendingTurns.length === 0) return;

            const unseenPending = pendingTurns.filter(
              (pending) => !pending.seenEventIds.has(String(event.eventId)),
            );

            if (unseenPending.length === 0) return;

            for (const pending of unseenPending) {
              pending.seenEventIds.add(String(event.eventId));
            }

            if (event.type === "turn.completed" || event.type === "turn.aborted") {
              if (event.turnId) legacyHiddenWakeByTurn.delete(`${key}:${String(event.turnId)}`);

              if (!event.turnId) return;
              const terminals = legacyBufferedTerminals.get(key) ?? new Map();
              terminals.set(String(event.turnId), event);
              legacyBufferedTerminals.set(key, terminals);

              for (const pending of unseenPending) {
                if (!pending.dispatchReturned) {
                  pending.earlyEvents.push(event);
                }
              }

              yield* drainLegacyTerminals(key);

              return;
            }

            for (const pending of unseenPending) {
              if (!pending.dispatchReturned) {
                if (event.type === "content.delta") {
                  pending.earlyEvents.push(event);
                }

                continue;
              }

              if (!event.turnId || String(event.turnId) !== pending.turnId) continue;

              if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
                pending.assistant += event.payload.delta;
                continue;
              }
            }
          }),
        ),
      );
    },
  } satisfies Pick<
    AgentControllerShape,
    | "readConversationMemory"
    | "clearConversationMemory"
    | "restoreConversationMemory"
    | "listSessions"
    | "streamEvents"
  >;
}
