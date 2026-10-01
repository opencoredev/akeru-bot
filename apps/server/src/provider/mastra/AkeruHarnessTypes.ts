// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { type ToolsInput } from "@mastra/core/agent";
import { AgentController as MastraAgentController, type MastraDBMessage, type Session } from "@mastra/core/agent-controller";
import { type AkeruConversationMemorySnapshot, type BotPersonalityTone, type AkeruCreateRoutineInput as AkeruCreateRoutineInputValue } from "@akeru/contracts";
import * as Duration from "effect/Duration";
import type { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import { type AkeruKimiAccess } from "../AkeruKimiProvider.ts";
import type { AkeruToolRuntime } from "../tools/AkeruToolTypes.ts";
import { type AkeruRoutineListResult, type AkeruRoutineDeleteResult } from "./AkeruRoutineSchemas.ts";

export interface AkeruMastraState {
  readonly providerInstanceId?: string;
  // Undefined clears a previous directory when a reused session loses its cwd.
  readonly projectPath?: string | undefined;
  readonly yolo?: boolean;
  readonly botConversation?: boolean;
  readonly botName?: string;
  readonly personalityTone?: BotPersonalityTone;
  readonly persistentMemoryContext?: string;
  readonly mcpInstructions?: string;
  readonly modelOptions?: {
    readonly reasoningEffort?: string;
    readonly serviceTier?: string;
  };
}

export type AkeruMastraSession = Session<AkeruMastraState>;

export interface AkeruMastraHarnessOptions {
  readonly authStorage: AuthStorage;
  readonly getKimiAccess?: (instanceId?: string) => Promise<AkeruKimiAccess | undefined>;
  readonly getOpenCodeGoApiKey?: (instanceId?: string) => Promise<string | undefined>;
  readonly getSubscriptionApiKey?: SubscriptionAuthService["getApiKeyCredential"];
  readonly getSubscriptionOAuth?: SubscriptionAuthService["getOAuthCredential"];
  readonly getSubscriptionAccessToken?: SubscriptionAuthService["getAccessToken"];
  readonly getModelConnection?: (providerInstanceId: string) =>
    | {
        readonly environment: NodeJS.ProcessEnv;
        readonly instanceEnvironment: NodeJS.ProcessEnv;
        readonly useSavedCredential: boolean;
        readonly instanceId?: string;
      }
    | undefined;
  readonly memoryDbPath: string;
  /**
   * How long closing the harness waits for admitted memory work before it
   * interrupts that work. Defaults to five seconds.
   */
  readonly observationCloseGrace?: Duration.Input;
  readonly startMemoryCall?: (input: {
    readonly threadId: string;
    readonly category: "observer" | "reflector";
  }) => Promise<string | undefined>;
  readonly finishMemoryCall?: (input: {
    readonly callId: string;
    readonly category: "observer" | "reflector";
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly totalTokens?: number;
    };
    readonly error?: Error;
  }) => Promise<void>;
  readonly getThreadTools: (threadId: string) => ToolsInput;
  readonly syncThreadToolApproval?: (
    threadId: string,
    toolName: string,
    protectedAction: boolean,
  ) => Promise<void>;
  readonly toolRuntime: AkeruToolRuntime;
  readonly createRoutine?: (
    threadId: string,
    input: AkeruCreateRoutineInputValue,
  ) => Promise<unknown>;
  readonly listRoutines?: (threadId: string) => Promise<AkeruRoutineListResult>;
  readonly deleteRoutines?: (
    threadId: string,
    routineIds: ReadonlyArray<string>,
  ) => Promise<AkeruRoutineDeleteResult>;
  readonly onObservationDropped?: (input: {
    /** Stable queue-row id; retried notices reuse it. */
    readonly observationId: string;
    readonly threadId: string;
    readonly turnId?: string;
    readonly resourceId: string;
    readonly modelId: string;
    readonly attempts: number;
    readonly error: Error;
  }) => Promise<void> | void;
}

export interface AkeruMastraHarness {
  readonly rebuildConversation?: (
    threadId: string,
    messages: ReadonlyArray<MastraDBMessage>,
  ) => Promise<() => Promise<void>>;
  readonly controller: Pick<
    MastraAgentController<AkeruMastraState>,
    "init" | "createSession" | "deleteSession"
  >;
  readonly clearObservationalMemory?: (threadId: string, resourceId?: string) => Promise<void>;
  readonly readObservationalMemory?: (
    threadId: string,
    resourceId?: string,
  ) => Promise<AkeruConversationMemorySnapshot>;
  readonly restoreObservationalMemory?: (
    threadId: string,
    snapshot: AkeruConversationMemorySnapshot,
    resourceId?: string,
    expectedSnapshot?: AkeruConversationMemorySnapshot,
  ) => Promise<void>;
  readonly observeAfterTurn?: (input: AkeruBackgroundObservationInput) => Promise<void>;
  readonly observeExternalTurn?: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly modelId: string;
    readonly userMessages: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly assistant: string;
    readonly createdAt: string;
  }) => Promise<void>;
  readonly drainObservationQueue?: () => Promise<void>;
}

export interface AkeruBackgroundObservationInput {
  readonly threadId: string;
  readonly resourceId?: string;
  readonly modelId: string;
  /** Routes the observer to this instance's own credentials. */
  readonly providerInstanceId?: string;
  readonly turnId?: string;
}

export type AkeruMastraToolOptions = Pick<
  AkeruMastraHarnessOptions,
  | "authStorage"
  | "getKimiAccess"
  | "getOpenCodeGoApiKey"
  | "getThreadTools"
  | "syncThreadToolApproval"
  | "toolRuntime"
  | "createRoutine"
  | "listRoutines"
  | "deleteRoutines"
>;
