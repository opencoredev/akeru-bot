import {
  BotId,
  ChannelConnectionId,
  MessageId,
  type ProjectId,
  ThreadId,
  type TurnId,
  type ChannelBinding,
  type ChannelFailureCategory,
  type ChannelProvider,
  type ClientOrchestrationCommand,
  type OrchestrationEvent,
  type ServerSettingsError,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ServerSecretStore, type SecretStoreError } from "../auth/ServerSecretStore.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { type ChannelDeliveryStoreShape } from "./ChannelDeliveryStore.ts";
import { type ChannelFollowStoreShape } from "./ChannelFollowStore.ts";
import {
  ChannelPostRejectedError,
  ChannelRuntimeError,
  ChannelTransportError,
} from "./ChannelErrors.ts";
import { type InboundDispatchInput } from "./ChannelInbound.ts";

/** Promise-shaped transport handle. Injected transports return this; the runtime adapts it. */
export interface ChannelTransportRuntime {
  readonly post: (externalThreadId: string, text: string) => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly webhook?: (request: Request) => Promise<Response>;
  readonly react?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Promise<void>;
  readonly removeReaction?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Promise<void>;
  readonly isHealthy?: () => boolean;
  /** Resolves when a long-lived listener stops on its own or during shutdown. */
  readonly settled?: Promise<void>;
}

/** Ways a running transport can fail. */
export type ChannelTransportFailure =
  | ChannelTransportError
  | ChannelPostRejectedError
  | ChannelRuntimeError;

/** Everything a channel operation can fail with. */
export type ChannelOperationError =
  | ChannelTransportFailure
  | OrchestrationDispatchError
  | SecretStoreError
  | ServerSettingsError
  | Schema.SchemaError
  | PlatformError.PlatformError;

export interface ChannelRuntimeEntry {
  readonly post: (
    externalThreadId: string,
    text: string,
  ) => Effect.Effect<void, ChannelTransportFailure>;
  readonly shutdown: Effect.Effect<void, ChannelTransportFailure>;
  readonly webhook?: (request: Request) => Effect.Effect<Response, ChannelTransportFailure>;
  readonly react?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Effect.Effect<void, ChannelTransportFailure>;
  readonly removeReaction?: (
    externalThreadId: string,
    externalMessageId: string,
    emoji: string,
  ) => Effect.Effect<void, ChannelTransportFailure>;
  readonly clearThreadStatus?: (threadId: ThreadId) => Effect.Effect<void>;
  readonly isHealthy?: () => boolean;
  /** Completes when a long-lived listener stops, so the binding can be marked for reconnect. */
  readonly settled?: Effect.Effect<void>;
}

export interface StartedTransport {
  readonly externalIdentity: string;
  readonly runtime: ChannelRuntimeEntry;
  /** A problem the connected binding shows as its error, such as a missing Slack scope. */
  readonly warning?: string;
}

export interface StartedChannel {
  readonly binding: ChannelBinding;
  readonly runtime: ChannelRuntimeEntry;
}

export interface InboundChannelMessage {
  readonly externalThreadId: string;
  readonly externalMessageId?: string;
  readonly externalSenderId?: string;
  readonly externalSenderName?: string;
  readonly text: string;
}

/** SDK callback that hands an inbound message to the runtime that owns the transport. */
export type InboundCallback = (input: InboundChannelMessage) => Promise<void>;

/**
 * What the platform says about a sender's workspace. `missing-permission` means the bot's
 * credentials cannot look anyone up, such as a Slack token without `users:read`.
 */
export type ChannelSenderMembership =
  | { readonly kind: "member"; readonly workspaceId: string }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "missing-permission" };

/** The person behind an inbound platform message, as the access check sees them. */
export interface ChannelSender {
  readonly userId: string;
  readonly displayName?: string | undefined;
  /**
   * The workspace the platform confirms the sender belongs to, such as the Slack team from
   * `users.info`. Only `member` admits anyone. The access check calls it only for senders it
   * might admit, so strangers cost no lookup.
   */
  readonly verifiedWorkspace: () => Promise<ChannelSenderMembership>;
}

/** How a message reached the bot: a DM, a message that mentions it, or a reply in a thread. */
export type ChannelInboundKind = "direct" | "mention" | "thread";

/** What the access check reads about one message. It runs before any subscribe or history read. */
export interface ChannelGateInput {
  readonly kind: ChannelInboundKind;
  readonly externalThreadId: string;
  readonly externalMessageId: string;
  readonly sender: ChannelSender;
  /** The message text without the bot's own mention. */
  readonly text: string;
  /** Platform user IDs the message tags, other than this bot. */
  readonly mentionedUserIds: ReadonlyArray<string>;
  /** The workspace the connected bot belongs to (a Slack team ID). */
  readonly homeWorkspaceId?: string | undefined;
}

export type ChannelGateDecision =
  | { readonly type: "ignore"; readonly unsubscribe?: boolean }
  | { readonly type: "reply"; readonly text: string; readonly unsubscribe?: boolean }
  | { readonly type: "turn" };

/** Decides whether a message may reach the bot. Never fails; a failed check ignores the message. */
export type ChannelGate = (input: ChannelGateInput) => Promise<ChannelGateDecision>;

/** A link code the owner can send the bot once before it expires. */
export interface PendingChannelLinkCode {
  readonly botId: BotId;
  readonly provider: ChannelProvider;
  /** The connection the bot's channel used when the code was made; a code dies with it. */
  readonly connectionId: ChannelConnectionId | undefined;
  readonly expiresAt: number;
}

export interface ChannelTransportContext {
  readonly botName: string;
  readonly subscribedThreadIds: ReadonlyArray<string>;
  readonly onMention: InboundCallback;
  readonly onSubscribedMessage: InboundCallback;
  /** Owner and allowlist check for Slack and Discord messages. */
  readonly gate: ChannelGate;
  /** HTTP client for credential probes. Defaults to the fetch-backed client. */
  readonly httpClient?: HttpClient.HttpClient;
}

export type LiveProvider = ChannelProvider;

export type ChannelConnectInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.connect" }
>;

export type ChannelLinkCodeCreateInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.link-code.create" }
>;

export type ChannelOwnerRemoveInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.owner.remove" }
>;

export type ChannelAccessSetInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.access.set" }
>;

export type ChannelConnectionSaveInput = Extract<
  ClientOrchestrationCommand,
  { readonly type: "channel.connection.save" }
>;

export interface ChannelRuntimeDependencies {
  readonly engine: OrchestrationEngineShape;
  readonly secretStore: ServerSecretStore["Service"];
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">;
  readonly deliveryStore: ChannelDeliveryStoreShape;
  /** Durable thread follows. Defaults to an in-memory store, which tests use. */
  readonly followStore?: ChannelFollowStoreShape;
  readonly readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThread | null, ProjectionRepositoryError>;
  readonly nowIso: Effect.Effect<string>;
  readonly randomUuid: Effect.Effect<string, PlatformError.PlatformError>;
  /** HTTP client for built-in credential probes. Defaults to the fetch-backed client. */
  readonly httpClient?: HttpClient.HttpClient;
  /**
   * Public https origin the operator advertises for this environment
   * (`--public-origin`/`T3CODE_PUBLIC_ORIGIN`). Drives provider webhook URLs and
   * the "Open in Akeru" reply footer. Never derived from a bind address or a
   * client-supplied origin; undefined means no public origin is configured.
   */
  readonly publicOrigin?: string | undefined;
  /** Replaces the built-in adapters. Tests use it to drive transports directly. */
  readonly startTransport?: (
    input: ChannelConnectInput,
    onDirectMessage: InboundCallback,
    context: ChannelTransportContext,
  ) => Promise<{ readonly externalIdentity: string; readonly runtime: ChannelTransportRuntime }>;
}

export interface ChannelReplyTarget {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** A binding that could not be restored. Carries only the category so logs never hold secrets. */
export interface ChannelRestoreFailure {
  readonly botId: BotId;
  readonly provider: LiveProvider;
  readonly category: ChannelFailureCategory;
}

// Normalized chat-sdk emoji keys, so Slack and Discord each resolve their native form.
// "hourglass" marks a turn that is waiting on an approval or user-input answer.
export const channelStatusReactions = ["eyes", "check", "x", "hourglass"] as const;

export type ChannelOrigin = NonNullable<OrchestrationThread["messages"][number]["channelOrigin"]>;

export type ChannelStatus = {
  origin: ChannelOrigin;
  status: (typeof channelStatusReactions)[number];
  threadId?: ThreadId;
};

export type KeyedLock = (
  key: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/** Everything one runtime owns. Created by the layer and closed with its scope. */
export interface ChannelRuntimeContext {
  readonly deps: ChannelRuntimeDependencies;
  readonly runtimes: Map<string, ChannelRuntimeEntry>;
  readonly statuses: WeakMap<ChannelRuntimeEntry, Map<string, ChannelStatus>>;
  readonly withLock: KeyedLock;
  /** Runs SDK callback work as a fiber of the runtime scope. */
  readonly runSdkCallback: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Parent of every transport's own scope, such as a renewing gateway. */
  readonly transportScope: Scope.Scope;
  /** Runtime keys with a start in flight. A persisted `connecting` outside this set is stale. */
  readonly connecting: Set<string>;
  readonly follows: ChannelFollowStoreShape;
  /** Pending owner link codes by code. Kept in memory only, so a restart drops them. */
  readonly linkCodes: Map<string, PendingChannelLinkCode>;
  closed: boolean;
}

export interface ChannelRuntimeShape {
  readonly connect: (input: ChannelConnectInput) => Effect.Effect<number, ChannelOperationError>;
  readonly saveConnection: (
    input: ChannelConnectionSaveInput,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly deleteConnection: (
    connectionId: ChannelConnectionId,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly attach: (
    botId: BotId,
    connectionId: ChannelConnectionId,
    projectId: ProjectId,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly disconnect: (
    botId: BotId,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly changeProject: (
    botId: BotId,
    provider: ChannelProvider,
    projectId: ProjectId,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly detach: (
    botId: BotId,
    provider: ChannelProvider,
    expectedConnectionId?: ChannelConnectionId,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly reconnect: (
    botId: BotId,
    provider: ChannelProvider,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly createLinkCode: (
    input: ChannelLinkCodeCreateInput,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly removeOwner: (
    input: ChannelOwnerRemoveInput,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly setAccess: (
    input: ChannelAccessSetInput,
  ) => Effect.Effect<number, ChannelOperationError>;
  /** Reconnects every saved binding and reports the ones that failed. */
  readonly restoreConnectedChannels: Effect.Effect<
    ReadonlyArray<ChannelRestoreFailure>,
    ChannelOperationError
  >;
  readonly dispatchInbound: (
    input: InboundDispatchInput,
  ) => Effect.Effect<void, ChannelOperationError>;
  readonly sendChannelMessage: (
    input: ChannelReplyTarget,
  ) => Effect.Effect<number, ChannelOperationError>;
  readonly finishChannelTurn: (
    threadId: ThreadId,
    turnId: TurnId | undefined,
    state: "completed" | "failed" | "cancelled",
    requestMessageId?: MessageId,
  ) => Effect.Effect<void, ChannelOperationError>;
  readonly markChannelTurnWaiting: (
    threadId: ThreadId,
    turnId: TurnId | undefined,
    waiting: boolean,
  ) => Effect.Effect<void, ChannelOperationError>;
  readonly resolveCompletedChannelReply: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<ChannelReplyTarget | null, ChannelOperationError>;
  readonly sendCompletedChannelReply: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<number | null, ChannelOperationError>;
  readonly stopChannelsForBot: (botId: BotId) => Effect.Effect<void>;
  readonly clearChannelThreadStatuses: (threadId: ThreadId) => Effect.Effect<void>;
  /** Stops transports for archived bots and clears statuses for removed threads. */
  readonly stopArchivedBotChannels: <E, R>(
    events: Stream.Stream<OrchestrationEvent, E, R>,
  ) => Effect.Effect<void, E, R>;
  readonly handleWhatsAppWebhook: (botId: BotId, request: Request) => Effect.Effect<Response>;
  /** Routes a webhook for a saved WhatsApp connection to the bot it is attached to. */
  readonly handleWhatsAppConnectionWebhook: (
    connectionId: ChannelConnectionId,
    request: Request,
  ) => Effect.Effect<Response>;
  readonly channelBindingsForRuntime: (
    bindings: ReadonlyArray<ChannelBinding>,
  ) => ReadonlyArray<ChannelBinding>;
  /** Stops every running transport. The runtime stays usable; its scope finalizer also runs this. */
  readonly shutdown: Effect.Effect<void>;
}
