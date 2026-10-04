import { ProviderDriverKind, ThreadId } from "@akeru/contracts";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { type CodexSessionRuntimeShape } from "./CodexRuntimeState.ts";

export const PROVIDER = ProviderDriverKind.make("codex");

export interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  stopped: boolean;
}

export type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

export type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

export interface CodexTurnTokenUsage {
  readonly threadTotalTokens: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}
