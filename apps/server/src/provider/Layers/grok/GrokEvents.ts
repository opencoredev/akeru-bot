// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import { EventId, type ProviderRuntimeEvent, type ThreadId, TurnId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";

// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Pure ACP event builder; it has no contextual service or Layer.
import { makeAcpPlanUpdatedEvent } from "../../acp/AcpCoreRuntimeEvents.ts";

import { type EventNdjsonLogger } from "../logging/EventLogTypes.ts";
import { PROVIDER, type GrokSessionContext } from "./GrokAdapterState.ts";
import { encodeJsonStringForDiagnostics } from "./GrokProtocol.ts";

export function createGrokEvents(deps: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly nowIso: Effect.Effect<string, never, never>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
}) {
  const logNative = (
    threadId: ThreadId,
    method: string,
    payload: NonNullable<ProviderRuntimeEvent["raw"]>["payload"],
  ) =>
    Effect.gen(function* () {
      if (!deps.nativeEventLogger) return;
      const observedAt = yield* deps.nowIso;
      yield* deps.nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* deps.randomUUIDv4,
            kind: "notification",
            provider: PROVIDER,
            createdAt: observedAt,
            method,
            threadId,
            payload,
          },
        },
        threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to write native Grok notification log.", {
          cause,
          threadId,
          method,
        }),
      ),
    );

  const emitPlanUpdate = (
    ctx: GrokSessionContext,
    turnId: TurnId | undefined,
    stamp: { readonly eventId: EventId; readonly createdAt: string },
    payload: {
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    },
    rawPayload: NonNullable<ProviderRuntimeEvent["raw"]>["payload"],
    method: string,
  ) =>
    Effect.gen(function* () {
      const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;

      if (ctx.lastPlanFingerprint === fingerprint) {
        return;
      }

      ctx.lastPlanFingerprint = fingerprint;
      yield* deps.offerRuntimeEvent(
        makeAcpPlanUpdatedEvent({
          stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload,
          source: "acp.jsonrpc",
          method,
          rawPayload,
        }),
      );
    });

  return { logNative, emitPlanUpdate };
}
