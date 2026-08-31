import type {
  BotEngine,
  ModelSelection,
  ProviderInteractionMode,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { AgentControllerError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

export interface AgentControllerAvailableEngine {
  readonly modelSelection: ModelSelection;
  readonly routing: ProviderInstanceRoutingInfo;
  readonly capabilities: ProviderAdapterCapabilities;
}

export interface AgentControllerEngineSelection extends AgentControllerAvailableEngine {
  readonly mode: ProviderInteractionMode;
}

export interface AgentControllerShape {
  /** Resolve a thread's selected mode and model to an available Akeru provider instance. */
  readonly resolveEngine: (input: {
    readonly threadId: ThreadId;
    readonly engine: BotEngine | null;
    readonly fallback: ModelSelection;
    readonly mode: ProviderInteractionMode;
  }) => Effect.Effect<AgentControllerEngineSelection, AgentControllerError>;

  /** Read routing metadata without changing the thread's active runtime session. */
  readonly inspectEngine: (
    modelSelection: ModelSelection,
  ) => Effect.Effect<AgentControllerAvailableEngine, AgentControllerError>;

  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, AgentControllerError>;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, AgentControllerError>;

  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, AgentControllerError>;

  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, AgentControllerError>;

  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, AgentControllerError>;

  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, AgentControllerError>;

  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, AgentControllerError>;

  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, AgentControllerError>;

  /**
   * Codex events are normalized from Mastra controller sessions. Other provider
   * adapters already produce the canonical event contract. Runtime ingestion
   * consumes the merged stream once.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

export class AgentController extends Context.Service<AgentController, AgentControllerShape>()(
  "akeru-bot/provider/Services/AgentController",
) {}
