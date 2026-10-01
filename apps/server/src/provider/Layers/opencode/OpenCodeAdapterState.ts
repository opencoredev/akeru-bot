import { ProviderDriverKind, type ProviderSession, ThreadId, TurnId } from "@akeru/contracts";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { type OpenCodeServerConnection } from "../../opencodeRuntime.ts";

export const PROVIDER = ProviderDriverKind.make("opencode");

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION).
 */
export const OPENCODE_RESUME_VERSION = 1 as const;

export interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

export type OpenCodeAskedRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "permission.asked" | "question.asked" }
>;

export type OpenCodeTerminalRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "permission.replied" | "question.replied" | "question.rejected" }
>;

export type OpenCodeRoutedRequestEvent = OpenCodeAskedRequestEvent | OpenCodeTerminalRequestEvent;

export interface OpenCodeRequestRelationRetry {
  warned: boolean;
  fiber?: Fiber.Fiber<void, never>;
  event: OpenCodeRoutedRequestEvent;
  terminalEvent?: OpenCodeTerminalRequestEvent;
}

export type OpenCodeTextPart = Extract<Part, { readonly type: "text" | "reasoning" }>;

export type OpenCodeTextPartState = Pick<OpenCodeTextPart, "id" | "messageID" | "type" | "time"> & {
  text: string | undefined;
  emittedText: string | undefined;
  completed: boolean;
};

export interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly resolvedRequestIds: Set<string>;
  readonly autoRepliedRequestIds: Set<string>;
  readonly requestRelationRetries: Map<string, OpenCodeRequestRelationRetry>;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  // OpenCode permits edits to completed parts. Keep text for snapshot comparison
  // until native removal or session teardown, but do not retain other part payloads.
  readonly textPartsByMessageId: Map<string, Map<string, OpenCodeTextPartState>>;
  readonly textPartById: Map<string, OpenCodeTextPartState>;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

export type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

export interface OpenCodeNativeLogRecord {
  readonly observedAt: string;
  readonly event: {
    readonly provider: ProviderSession["provider"];
    readonly threadId: ThreadId;
    readonly providerThreadId: string;
    readonly type: string;
    readonly turnId?: TurnId;
    readonly payload: OpenCodeSubscribedEvent;
  };
}
