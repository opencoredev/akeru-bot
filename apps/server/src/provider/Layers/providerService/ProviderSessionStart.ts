import { ProviderSessionStartInput } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  providerMetricAttributes,
  providerSessionsTotal,
  withMetrics,
} from "../../../observability/Metrics.ts";
import * as ProviderAdapterRegistry from "../../Services/ProviderAdapterRegistry.ts";
import * as ProviderSessionDirectory from "../../Services/ProviderSessionDirectory.ts";
import type { createProviderMcpSessions } from "./ProviderMcpSessions.ts";
import type { createProviderSessionBindings } from "./ProviderSessionBindings.ts";
import type { createProviderSessionRecovery } from "./ProviderSessionRecovery.ts";
import {
  type ProviderServiceMethod,
  decodeInputOrValidationError,
  readPersistedCwd,
  toValidationError,
} from "./ProviderSessionMapping.ts";

type SessionBindings = ReturnType<typeof createProviderSessionBindings>;

type McpSessions = ReturnType<typeof createProviderMcpSessions>;

/**
 * Starts a provider session on the requested instance, reusing the persisted
 * resume cursor and cwd when the thread is already bound to that instance.
 */
export function createProviderSessionStart(deps: {
  readonly registry: ProviderAdapterRegistry.ProviderAdapterRegistryShape;
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectoryShape;
  readonly requireBindingInstanceId: SessionBindings["requireBindingInstanceId"];
  readonly upsertSessionBinding: SessionBindings["upsertSessionBinding"];
  readonly prepareMcpSession: McpSessions["prepareMcpSession"];
  readonly clearMcpSession: McpSessions["clearMcpSession"];
  readonly stopStaleSessionsForThread: ReturnType<
    typeof createProviderSessionRecovery
  >["stopStaleSessionsForThread"];
}) {
  const {
    registry,
    directory,
    requireBindingInstanceId,
    upsertSessionBinding,
    prepareMcpSession,
    clearMcpSession,
    stopStaleSessionsForThread,
  } = deps;

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );

      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });

      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;

        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }

        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };

        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in Akeru Bot settings.`,
          );
        }

        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));

        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);

        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);

        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId);

        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);

          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  return startSession;
}
