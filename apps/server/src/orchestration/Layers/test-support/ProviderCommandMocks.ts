import { type Mock } from "vite-plus/test";
import { createObservationHistory } from "../../test-support/Observations.ts";
import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@akeru/contracts";
import { ThreadId, TurnId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { TextGenerationError } from "@akeru/contracts";
import {
  AgentControllerUnsupportedEngineError,
  ProviderAdapterRequestError,
  ProviderValidationError,
} from "../../../provider/Errors.ts";
import { type AgentControllerShape } from "../../../provider/Services/AgentController.ts";
import { type TextGenerationShape } from "../../../textGeneration/TextGeneration.ts";
import { type ComposioServiceShape } from "../../../composio/ComposioService.ts";
import { asTurnId } from "./ProviderCommandFixtures.ts";

export type ProviderCommandHarnessOptions = {
  readonly baseDir?: string;
  readonly threadModelSelection?: ModelSelection;
  readonly sessionModelSwitch?: "unsupported" | "in-session";
  readonly requiresNewThreadForModelChange?: boolean;
  readonly titleRegenerationCompletionDispatchFailures?: number;
  readonly titleRegenerationBeforeStart?: "one" | "two";
  readonly turnStartBeforeReactor?: boolean;
  readonly runningTurnBeforeReactor?: boolean;
  readonly resumeBeforeReactor?: boolean;
  readonly delegatedChild?: boolean;
  readonly replayPersistedResumeOnSubscribe?: boolean;
  readonly commitDuringSequenceRead?: 1 | 2;
  readonly titleUpdatesBeforeStartupCommit?: number;
  readonly failStartupReplay?: boolean;
  readonly pendingRequestBeforeReactor?: "approval" | "user-input";
  readonly interruptTurnEffect?: (
    input?: Parameters<AgentControllerShape["interruptTurn"]>[0],
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly interruptTurnRemovesSession?: boolean;
  readonly respondToRequestEffect?: (
    input: Parameters<AgentControllerShape["respondToRequest"]>[0],
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly stopSessionEffect?: () => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly startSessionEffect?: (
    session: ProviderSession,
  ) => Effect.Effect<ProviderSession, ProviderAdapterRequestError>;
  readonly sendTurnEffect?: () => Effect.Effect<
    { readonly threadId: ThreadId; readonly turnId: TurnId },
    ProviderAdapterRequestError
  >;
  readonly botEngine?: { readonly provider: string; readonly model: string } | null;
  readonly secondBot?: {
    readonly engine: { readonly provider: string; readonly model: string };
    readonly modelSelection?: ModelSelection;
  };
  readonly botUsageCap?: { readonly unit: "tokens"; readonly limit: number } | null;
  readonly bindTurnFailure?: boolean;
  readonly unavailableEngine?: boolean | "missing-login";
  readonly disabledEngine?: boolean;
  readonly composioResolveRuntimeMcpServer?: ComposioServiceShape["resolveRuntimeMcpServer"];
  readonly enableAgentBrowserAccess?: boolean;
  readonly startReactor?: boolean;
  readonly dispatchDelegation?: AgentControllerShape["dispatchDelegation"];
};

export function createProviderCommandMocks(
  input: ProviderCommandHarnessOptions | undefined,
  now: string,
) {
  const observations = createObservationHistory<void>();
  const notify = () => Effect.runSync(observations.publish(undefined));

  function observeMock<Args extends Array<unknown>, Result>(mock: Mock<(...args: Args) => Result>) {
    return new Proxy(mock, {
      apply(target, receiver, args: Args) {
        try {
          return target.apply(receiver, args);
        } finally {
          notify();
        }
      },
    });
  }

  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  let nextSessionIndex = 1;

  const runtimeSessions: Array<ProviderSession> = [];

  const modelSelection = input?.threadModelSelection ?? {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  };

  const startSessionEffect = input?.startSessionEffect;

  const startSession = observeMock(
    vi.fn(
      (
        _: Parameters<AgentControllerShape["startSession"]>[0],
        input: Parameters<AgentControllerShape["startSession"]>[1],
      ) => {
        notify();
        const sessionIndex = nextSessionIndex++;
        const resumeCursor = input.resumeCursor;
        const threadId = input.threadId ?? ThreadId.make(`thread-${sessionIndex}`);
        const inputModelSelection = input.modelSelection;
        const providerInstanceId = input.providerInstanceId ?? inputModelSelection?.instanceId;

        const provider =
          input.provider ??
          ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);

        const session: ProviderSession = {
          provider,
          ...(providerInstanceId ? { providerInstanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode ?? "full-access",
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...((inputModelSelection?.model ?? modelSelection.model)
            ? { model: inputModelSelection?.model ?? modelSelection.model }
            : {}),
          threadId,
          resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
          createdAt: now,
          updatedAt: now,
        };

        return (startSessionEffect?.(session) ?? Effect.succeed(session)).pipe(
          Effect.tap((startedSession) =>
            Effect.sync(() => {
              runtimeSessions.push(startedSession);
            }),
          ),
        );
      },
    ),
  );

  const sendTurn = observeMock(
    vi.fn((_: Parameters<AgentControllerShape["sendTurn"]>[0]) => {
      notify();

      return input?.sendTurnEffect
        ? input.sendTurnEffect()
        : Effect.succeed({
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId("turn-1"),
          });
    }),
  );

  const interruptTurn = observeMock(
    vi.fn((interruptInput: Parameters<AgentControllerShape["interruptTurn"]>[0]) => {
      notify();

      return (input?.interruptTurnEffect?.(interruptInput) ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (input?.interruptTurnRemovesSession !== true) {
              return;
            }

            const threadId = interruptInput.threadId;

            if (!threadId) {
              return;
            }

            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);

            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      );
    }),
  );

  const respondToRequest = observeMock(
    vi.fn<AgentControllerShape["respondToRequest"]>((request) => {
      notify();

      return input?.respondToRequestEffect?.(request) ?? Effect.void;
    }),
  );

  const respondToUserInput = observeMock(
    vi.fn<AgentControllerShape["respondToUserInput"]>(() => {
      notify();

      return Effect.void;
    }),
  );

  const stopSession = observeMock(
    vi.fn((stopInput: Parameters<AgentControllerShape["stopSession"]>[0]) => {
      notify();

      return (input?.stopSessionEffect?.() ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const threadId = stopInput.threadId;

            if (!threadId) {
              return;
            }

            const index = runtimeSessions.findIndex((session) => session.threadId === threadId);

            if (index >= 0) {
              runtimeSessions.splice(index, 1);
            }
          }),
        ),
      );
    }),
  );

  const renameBranch = observeMock(
    vi.fn((input: { readonly newBranch: string }) => {
      notify();

      return Effect.succeed({
        branch: input.newBranch,
      });
    }),
  );

  const pruneWorktrees = observeMock(
    vi.fn((_: { readonly cwd: string }) => {
      notify();

      return Effect.void;
    }),
  );

  const createWorktree = observeMock(
    vi.fn((input: { readonly refName: string; readonly path: string | null }) => {
      notify();

      return Effect.succeed({ worktree: { path: input.path ?? "", refName: input.refName } });
    }),
  );

  const generateBranchName = observeMock(
    vi.fn<TextGenerationShape["generateBranchName"]>((_) => {
      notify();

      return Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      );
    }),
  );

  const generateThreadTitle = observeMock(
    vi.fn<TextGenerationShape["generateThreadTitle"]>((_) => {
      notify();

      return Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      );
    }),
  );

  const providerSnapshots = [
    {
      instanceId: modelSelection.instanceId,
      ...(input?.requiresNewThreadForModelChange === true
        ? { requiresNewThreadForModelChange: true }
        : {}),
    },
  ];

  const inspectEngine: AgentControllerShape["inspectEngine"] = (selected) => {
    const raw = String(selected.instanceId);

    const driverKind = ProviderDriverKind.make(
      raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
    );

    return Effect.succeed({
      modelSelection: selected,
      routing: {
        instanceId: selected.instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey:
            driverKind === ProviderDriverKind.make("codex")
              ? "codex:home:/shared-codex"
              : `${driverKind}:instance:${selected.instanceId}`,
        },
      },
      capabilities: {
        sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
      },
    });
  };

  const resolveEngine = observeMock(
    vi.fn<AgentControllerShape["resolveEngine"]>(({ engine, fallback, mode }) => {
      notify();

      if (input?.unavailableEngine === "missing-login" && engine !== null) {
        return Effect.fail(
          new AgentControllerUnsupportedEngineError({
            provider: engine.provider,
            model: engine.model,
            detail: "Connect Claude in Settings.",
            unavailability: "missing-login",
          }),
        );
      }

      if (input?.unavailableEngine === true && engine !== null) {
        return Effect.fail(
          new AgentControllerUnsupportedEngineError({
            provider: engine.provider,
            model: engine.model,
            detail: `Provider instance '${engine.provider}' is not available.`,
          }),
        );
      }

      if (input?.disabledEngine === true && engine !== null) {
        return Effect.fail(
          new ProviderValidationError({
            operation: "AgentController.inspectEngine",
            issue: `Provider instance '${engine.provider}' is disabled in Akeru Bot settings.`,
          }),
        );
      }

      const selected =
        engine === null
          ? fallback
          : {
              instanceId: ProviderInstanceId.make(engine.provider),
              model: engine.model,
            };

      return inspectEngine(selected).pipe(Effect.map((result) => ({ ...result, mode })));
    }),
  );

  const failDelegation = observeMock(
    vi.fn<NonNullable<AgentControllerShape["failDelegation"]>>(() => {
      notify();

      return Effect.void;
    }),
  );

  const service: AgentControllerShape = {
    authenticateMcpServer: () => Effect.die("unused"),
    resolveEngine,
    inspectEngine,
    startSession: startSession,
    sendTurn: sendTurn,
    interruptTurn: interruptTurn,
    respondToRequest: respondToRequest,
    respondToUserInput: respondToUserInput,
    stopSession: stopSession,
    listSessions: () => Effect.succeed(runtimeSessions),
    ...(input?.dispatchDelegation ? { dispatchDelegation: input.dispatchDelegation } : {}),
    failDelegation,
    rollbackConversation: () => Effect.die("unused"),
    uploadFeedback: () => Effect.die("unused"),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return {
    observations,
    runtimeSessions,
    modelSelection,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    renameBranch,
    pruneWorktrees,
    createWorktree,
    generateBranchName,
    generateThreadTitle,
    providerSnapshots,
    resolveEngine,
    failDelegation,
    service,
  };
}
