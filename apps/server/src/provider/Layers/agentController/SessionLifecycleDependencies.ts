import { ProviderDriverKind } from "@akeru/contracts";
import { ProviderInstanceId } from "@akeru/contracts";
import { akeruToolCategory } from "../../AkeruMastraHarness.ts";
import type { createAkeruWebFetch } from "../../AkeruWebFetch.ts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";
import type { ProviderServiceError } from "../../Errors.ts";
import type { RuntimeMode } from "@akeru/contracts";
import type { AkeruRuntimeSeam } from "../../AkeruRuntimeSeam.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";

import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  EventId,
  TurnId,
  type BotId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationRecord,
  type AkeruMemoryThreadAccess,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BotInboxService } from "../../../bot-inbox/service.ts";
import { BotMemoryStore, type BotMemoryAccess } from "../../../memory/BotMemory.ts";
import { type AkeruMemoryToolHandler } from "../../../memory/BotMemoryToolHandlers.ts";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";
import { type AkeruMastraHarness } from "../../AkeruMastraHarness.ts";
import { type AkeruChannelRuntime } from "../../AkeruChannelRuntime.ts";
import { type AkeruBotStateRuntime } from "../../AkeruBotStateRuntime.ts";
import { makeAkeruWorkerRuntime } from "../../AkeruWorkerRuntime.ts";
import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../../AkeruCatalogToolHandlers.ts";

import { type AkeruToolSession } from "../../AkeruToolRuntime.ts";
import { AkeruSessionResources } from "../../AkeruSessionResources.ts";

import { AgentControllerRuntimeError, ProviderValidationError } from "../../Errors.ts";

import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";
import {
  type ResolvedEngine,
  type ActiveSession,
  type LegacyResourceIdentity,
  type WorkerOrchestration,
} from "./State.ts";

export interface SessionLifecycleDependencies {
  readonly webFetch: ReturnType<typeof createAkeruWebFetch>;
  readonly runPromise: AkeruRuntimeSeam["runPromise"];
  readonly projectionSnapshotQuery: Option.Option<ProjectionSnapshotQuery["Service"]>;
  readonly workerRuntime: ReturnType<typeof makeAkeruWorkerRuntime> extends Effect.Effect<
    infer A,
    infer _E,
    infer _R
  >
    ? A
    : never;
  readonly wired: () => {
    readonly channelRuntime?: AkeruChannelRuntime;
    readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
    readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
    readonly botStateRuntime?: AkeruBotStateRuntime;
    readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
    readonly workerOrchestration?: WorkerOrchestration;
  };
  readonly sessions: Map<string, ActiveSession>;
  readonly resolvedByThread: Map<string, ResolvedEngine>;
  readonly usesMastraCode: (provider: ProviderDriverKind) => boolean;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly disabledProviderError: (
    operation: string,
    providerInstanceId: ProviderInstanceId,
  ) => ProviderValidationError;
  readonly options: AgentControllerLiveOptions | undefined;
  readonly botMemoryStore: BotMemoryStore;
  readonly failureDetail: (cause: unknown) => string;
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
  readonly imageToolSettings: Effect.Effect<
    { chatgptEnabled: boolean; grokEnabled: boolean },
    never,
    never
  >;
  readonly memorySettings: () =>
    | Effect.Effect<
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "auto" | "ask" }
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "ask" },
        never,
        never
      >
    | Effect.Effect<
        {
          readonly enabled: true;
          readonly privateBotMemory: true;
          readonly sharedProjectMemory: "ask";
        },
        never,
        never
      >;
  readonly memoryHandlers: (
    access: AkeruMemoryThreadAccess | undefined,
    allowedScopes: AkeruDelegationAccessGrant["memoryScopes"],
  ) => { memory: AkeruMemoryToolHandler } | undefined;
  readonly delegationFor: (input: {
    readonly threadId: ThreadId;
    readonly botId: BotId;
    readonly parentDelegation: AkeruDelegationRecord | undefined;
    readonly access: AkeruDelegationAccessGrant;
    readonly activeChildDelegations: number;
  }) => NonNullable<AkeruToolSession["delegation"]>;
  readonly workersFor: (
    threadId: ThreadId,
    access: AkeruDelegationAccessGrant,
  ) => NonNullable<AkeruToolSession["workers"]>;
  readonly memoryAccessFor: (
    access: AkeruMemoryThreadAccess | undefined,
  ) => BotMemoryAccess | undefined;
  readonly toolRuntime: AkeruToolRuntime;
  readonly toProviderSession: (threadId: ThreadId, active: ActiveSession) => ProviderSession;
  readonly legacyResourceIdentity: Map<string, LegacyResourceIdentity>;
  readonly memoryAccessKey: (access: BotMemoryAccess | undefined) => string | undefined;
  readonly sessionResources: AkeruSessionResources;
  readonly stopSessionWithResources: (
    input: { readonly threadId: ThreadId },
    destroyResources: boolean,
  ) => Effect.Effect<void, ProviderServiceError | AgentControllerRuntimeError, never>;
  readonly preparePreviewMcpSession: (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    memoryHandler?: AkeruMemoryToolHandler,
  ) => Effect.Effect<void, never, never>;
  readonly clearPreviewMcpSession: (threadId: ThreadId) => Effect.Effect<void, never, never>;
  readonly entityMemoryContext: (access: AkeruMemoryThreadAccess | undefined) => Promise<string>;
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly botInbox: BotInboxService;
  readonly deleteCatalogMcpServer: (
    runtime: Pick<AkeruPluginRuntimeOptions, "readSnapshot" | "dispatch">,
    serverId: string,
    commandPrefix: "mcp-delete" | "mcp-remove",
  ) => Promise<{
    serverId: string;
    removed: boolean;
    dependentBots: { id: BotId; name: string }[];
    clearedDisabledFor: { id: BotId; name: string }[];
  }>;
  readonly bundle: AkeruMastraHarness;
  readonly mastraModelOptions: (
    resolved: ResolvedEngine,
  ) => { serviceTier?: string; reasoningEffort?: string } | undefined;
  readonly DEFAULT_MODE_ID: string;
  readonly permissionPolicy: (
    runtimeMode: RuntimeMode,
    category: ReturnType<typeof akeruToolCategory>,
  ) => "allow" | "ask";
  readonly handleControllerEvent: (
    threadId: ThreadId,
    active: ActiveSession,
    event: AgentControllerEvent,
  ) => void;
  readonly publish: (event: ProviderRuntimeEvent) => void;
  readonly baseEvent: (
    threadId: ThreadId,
    active: Pick<ActiveSession, "provider" | "providerInstanceId">,
    turnId?: TurnId,
  ) => {
    turnId?: TurnId;
    eventId: EventId;
    provider: ProviderDriverKind;
    providerInstanceId: ProviderInstanceId;
    threadId: ThreadId;
    createdAt: string;
  };
  readonly publishSessionState: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) => void;
}
