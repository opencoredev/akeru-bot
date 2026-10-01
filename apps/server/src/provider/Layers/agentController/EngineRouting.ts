import { ProviderDriverKind } from "@akeru/contracts";
import { ProviderInstanceId } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Semaphore from "effect/Semaphore";

import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";
import { mastraModelId } from "../../AkeruMastraHarness.ts";

import {
  AgentControllerRuntimeError,
  AgentControllerUnsupportedEngineError,
  ProviderValidationError,
} from "../../Errors.ts";
import { type AgentControllerShape } from "../../Services/AgentController.ts";
import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import { type ResolvedEngine, type ActiveSession } from "./State.ts";
import { subscriptionProviderForDriver, mastraConnectionIssue } from "./ProviderAccess.ts";

export function createEngineRouting(deps: {
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly usesMastraCode: (provider: ProviderDriverKind) => boolean;
  readonly disabledProviderError: (
    operation: string,
    providerInstanceId: ProviderInstanceId,
  ) => ProviderValidationError;
  readonly modelConnections: Map<
    string,
    {
      readonly environment: NodeJS.ProcessEnv;
      readonly instanceEnvironment: NodeJS.ProcessEnv;
      readonly useSavedCredential: boolean;
    }
  >;
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly mutationLock: Semaphore.Semaphore;
  readonly resolvedByThread: Map<string, ResolvedEngine>;
  readonly sessions: Map<string, ActiveSession>;
  readonly mastraModelOptions: (
    resolved: ResolvedEngine,
  ) => { serviceTier?: string; reasoningEffort?: string } | undefined;
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
}) {
  const inspectEngine: AgentControllerShape["inspectEngine"] = Effect.fn(
    "AgentController.inspectEngine",
  )(function* (modelSelection) {
    const provider = String(modelSelection.instanceId);
    const model = modelSelection.model;

    const unavailable = (cause: unknown) =>
      new AgentControllerUnsupportedEngineError({
        provider,
        model,
        detail: `Provider instance '${provider}' is not available.`,
        cause,
      });

    const routing = yield* deps.legacyProviderBridge
      .getInstanceInfo(modelSelection.instanceId)
      .pipe(Effect.mapError(unavailable));

    if (deps.usesMastraCode(routing.driverKind) && !routing.enabled) {
      return yield* deps.disabledProviderError(
        "AgentController.inspectEngine",
        modelSelection.instanceId,
      );
    }

    // Fail closed on a model the instance's snapshot does not advertise.
    // The bot engine is applied after ws-level preflight ran against the
    // command's own selection, so this check is the only validation a
    // bot-owned thread ever sees. An empty snapshot is not evidence the
    // model is unknown — the first probe may still be running.
    // Only a settled probe is authoritative: pending snapshots still carry
    // the built-in catalog, and probe fallbacks do too, so neither proves the
    // saved model is gone.
    if (
      deps.usesMastraCode(routing.driverKind) &&
      routing.instanceSnapshot !== undefined &&
      routing.instanceSnapshot.status === "ready"
    ) {
      const advertised = routing.instanceSnapshot.models;

      if (advertised.length > 0 && !advertised.some((entry) => entry.slug === model)) {
        const name = routing.instanceSnapshot.displayName ?? routing.driverKind;

        return yield* new AgentControllerUnsupportedEngineError({
          provider,
          model,
          detail: `Model '${model}' is not available for ${name}.`,
        });
      }
    }

    if (routing.mastraConnection) {
      deps.modelConnections.set(String(modelSelection.instanceId), routing.mastraConnection);
    } else {
      deps.modelConnections.delete(String(modelSelection.instanceId));
    }

    if (deps.usesMastraCode(routing.driverKind)) {
      const subscriptionProvider = subscriptionProviderForDriver(routing.driverKind);

      const issue = mastraConnectionIssue(
        routing.driverKind,
        routing.mastraConnection,
        subscriptionProvider
          ? deps.subscriptionAuth.isConnected(subscriptionProvider, modelSelection.instanceId)
          : false,
      );

      if (issue) return yield* unavailable(new Error(issue));
    }

    const capabilities = deps.usesMastraCode(routing.driverKind)
      ? { sessionModelSwitch: "in-session" as const }
      : yield* deps.legacyProviderBridge
          .getCapabilities(modelSelection.instanceId)
          .pipe(Effect.mapError(unavailable));

    return { modelSelection, routing, capabilities };
  });

  const resolveEngine: AgentControllerShape["resolveEngine"] = (input) =>
    deps.mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const modelSelection =
          input.engine === null
            ? input.fallback
            : {
                instanceId: ProviderInstanceId.make(input.engine.provider),
                model: input.engine.model,
                ...(input.engine.options ? { options: input.engine.options } : {}),
              };

        const inspected = yield* inspectEngine(modelSelection);
        const previous = deps.resolvedByThread.get(String(input.threadId));

        const resolved: ResolvedEngine = {
          modelSelection,
          provider: inspected.routing.driverKind,
          providerInstanceId: modelSelection.instanceId,
          mastraModelId: mastraModelId(inspected.routing.driverKind, modelSelection.model),
          botConversation: input.botConversation,
          ...(previous?.botName ? { botName: previous.botName } : {}),
          ...(previous?.personalityTone !== undefined
            ? { personalityTone: previous.personalityTone }
            : {}),
        };

        deps.resolvedByThread.set(String(input.threadId), resolved);
        const active = deps.sessions.get(String(input.threadId));

        if (active && deps.usesMastraCode(resolved.provider)) {
          const { modelOptions: _priorModelOptions, ...activeState } = active.session.state.get();
          const nextModelOptions = deps.mastraModelOptions(resolved);
          yield* deps.runMastra("state.set", () =>
            active.session.state.set({
              ...activeState,
              providerInstanceId: String(resolved.providerInstanceId),
              ...(nextModelOptions ? { modelOptions: nextModelOptions } : {}),
            }),
          );
          yield* deps.runMastra("model.switch", () =>
            active.session.model.switch({ modelId: resolved.mastraModelId }),
          );
          active.model = modelSelection.model;
        }

        return { ...inspected, mode: "default" };
      }),
    );

  return { inspectEngine, resolveEngine };
}
