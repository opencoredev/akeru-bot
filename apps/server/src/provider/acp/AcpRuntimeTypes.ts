import * as Duration from "effect/Duration";
import type * as EffectAcpSchema from "effect-acp/schema";

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpToolCallData {
  toolCallId?: string;
  kind?: string;
  command?: string;
  rawInput?: EffectAcpSchema.ToolCall["rawInput"];
  rawOutput?: EffectAcpSchema.ToolCall["rawOutput"];
  content?: AcpToolCallUpdate["content"];
  locations?: AcpToolCallUpdate["locations"];
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: AcpToolCallData;
}

export interface AcpPlanUpdate {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface AcpPermissionRequest {
  readonly kind: string | "unknown";
  readonly detail?: string;
  readonly toolCall?: AcpToolCallState;
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: "ModeChanged";
      readonly modeId: string;
    }
  | {
      readonly _tag: "AssistantItemStarted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "AssistantItemCompleted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "PlanUpdated";
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdated";
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ContentDelta";
      readonly itemId?: string;
      readonly text: string;
      readonly rawPayload: unknown;
    };

export type AcpSessionSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

export type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

export interface AcpToolCallEmitDecisionInput {
  readonly previous: AcpToolCallState | undefined;
  readonly next: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

export interface AcpToolCallEmitDecision {
  readonly emit: boolean;
  readonly skippedSinceEmit: number;
}

export interface SessionLoadGate {
  readonly active: boolean;
  readonly lastActivityAtMillis: number | undefined;
  readonly idleGap: Duration.Duration;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
}
