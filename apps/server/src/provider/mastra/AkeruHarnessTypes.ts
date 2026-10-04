import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { type ToolsInput } from "@mastra/core/agent";
import {
  AgentController as MastraAgentController,
  type MastraDBMessage,
  type Session,
} from "@mastra/core/agent-controller";
import {
  type AkeruConversationMemorySnapshot,
  type BotPersonalityTone,
  type AkeruCreateRoutineInput as AkeruCreateRoutineInputValue,
} from "@akeru/contracts";
import * as Duration from "effect/Duration";
import type { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import type { AkeruOpenCodeGoAccess } from "../AkeruOpenCodeGoProvider.ts";
import { type AkeruKimiAccess } from "../AkeruKimiProvider.ts";
import type { AkeruToolRuntime, AkeruToolResult } from "../tools/AkeruToolTypes.ts";
import {
  type AkeruRoutineListResult,
  type AkeruRoutineDeleteResult,
} from "./AkeruRoutineSchemas.ts";

import type { AkeruModelOptions } from "../ReasoningOptions.ts";

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
  readonly modelOptions?: AkeruModelOptions;
}

export type AkeruMastraSession = Session<AkeruMastraState>;

/** Session methods used by Akeru's injected controller boundary. */
export type AkeruControllerSession = Pick<
  AkeruMastraSession,
  | "subscribe"
  | "sendMessage"
  | "grantTool"
  | "abort"
  | "respondToToolApproval"
  | "respondToToolSuspension"
> & {
  readonly stream: Pick<AkeruMastraSession["stream"], "isActive" | "waitForTeardown">;
  readonly run: Pick<AkeruMastraSession["run"], "getRunId" | "waitForTeardown">;
  readonly state: Pick<AkeruMastraSession["state"], "get" | "set">;
  readonly mode: Pick<AkeruMastraSession["mode"], "get" | "switch">;
  readonly model: Pick<AkeruMastraSession["model"], "get" | "switch">;
  readonly permissions: Pick<AkeruMastraSession["permissions"], "setForCategory" | "setForTool">;
};

export interface AkeruMastraHarnessOptions {
  readonly authStorage: AuthStorage;
  readonly getKimiAccess?: (
    instanceId?: string,
    threadId?: string,
  ) => Promise<AkeruKimiAccess | undefined>;
  readonly getOpenCodeGoApiKey?: (
    instanceId?: string,
    threadId?: string,
  ) => Promise<AkeruOpenCodeGoAccess | undefined>;
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
  ) => Promise<AkeruToolResult>;
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

export type AkeruControllerHarness = AkeruMastraHarness<AkeruControllerSession>;

export interface AkeruMastraHarness<SessionType = AkeruMastraSession> {
  readonly rebuildConversation?: (
    threadId: string,
    messages: ReadonlyArray<MastraDBMessage>,
  ) => Promise<() => Promise<void>>;
  readonly controller: Pick<MastraAgentController<AkeruMastraState>, "init" | "deleteSession"> & {
    createSession(
      ...args: Parameters<MastraAgentController<AkeruMastraState>["createSession"]>
    ): Promise<SessionType>;
  };
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
