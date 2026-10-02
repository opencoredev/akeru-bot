/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ThreadId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import { increment, providerRuntimeEventsTotal } from "../../../observability/Metrics.ts";
import { ProviderValidationError } from "../../Errors.ts";

import * as ProviderSessionDirectory from "../../Services/ProviderSessionDirectory.ts";

import {
  toValidationError,
  toRuntimeStatus,
  toRuntimePayloadFromSession,
  correlateRuntimeEventWithInstance,
} from "./ProviderSessionMapping.ts";

export function createProviderSessionBindings(deps: {
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectoryShape;
  readonly publishRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}) {
  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );

      yield* deps.directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(deps.publishRuntimeEvent(canonicalEvent))),
      ),
    );

  return { requireBindingInstanceId, upsertSessionBinding, processRuntimeEvent };
}
