import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  AkeruMemoryOperationError,
  type AuthAccessStreamEvent,
  AuthSessionId,
  ClientSurface,
  type FileManagerRevealKind,
  type OrchestrationClientOrigin,
  type OrchestrationReadModel,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  PortabilityArchiveError,
  type PortabilityArchive,
  type PortabilityProjectFolderMap,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ServerProvider,
  SubscriptionProviderId,
  McpServerAuthenticationError,
  ThreadId,
} from "@akeru/contracts";
import { HttpServerRequest } from "effect/unstable/http";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as Portability from "./portability.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";

export const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export const isMcpServerAuthenticationError = Schema.is(McpServerAuthenticationError);

export const subscriptionDriverByProvider: Record<SubscriptionProviderId, string> = {
  anthropic: "claudeAgent",
  "openai-codex": "codex",
  xai: "grok",
  "kimi-for-coding": "kimi",
  "opencode-go": "opencodeGo",
};

export const subscriptionProviderForDriver = (driver: string): SubscriptionProviderId | undefined =>
  SubscriptionProviderId.literals.find(
    (provider) => subscriptionDriverByProvider[provider] === driver,
  );

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

export const portabilityError = (operation: "export" | "preview" | "apply", cause: unknown) =>
  new PortabilityArchiveError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const memoryOperationError = (operation: string, cause: unknown) =>
  new AkeruMemoryOperationError({
    operation,
    detail:
      cause instanceof Error
        ? cause.message
        : Predicate.isString(cause)
          ? cause
          : "The memory operation failed.",
  });

export const availablePortabilityProviderIds = (providers: ReadonlyArray<ServerProvider>) =>
  new Set(
    providers.flatMap((provider) =>
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated"
        ? [provider.instanceId]
        : [],
    ),
  );

export const validatePortabilityProjectFolders = Effect.fn("validatePortabilityProjectFolders")(
  function* (
    archive: PortabilityArchive,
    snapshot: OrchestrationReadModel,
    projectFolders: PortabilityProjectFolderMap,
    operation: "preview" | "apply",
  ) {
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const path = yield* Path.Path;

    for (const [projectId, destination] of Object.entries(projectFolders)) {
      if (!path.isAbsolute(destination) || path.dirname(destination) === destination) {
        return yield* portabilityError(
          operation,
          new Error(`Project '${projectId}' destination must be an absolute non-root path.`),
        );
      }
    }

    const normalized = Portability.normalizePortabilityProjectFolders(
      archive,
      snapshot,
      projectFolders,
    );

    return Object.fromEntries(
      yield* Effect.forEach(Object.entries(normalized), ([projectId, workspaceRoot]) =>
        workspacePaths
          .normalizeWorkspaceRoot(workspaceRoot)
          .pipe(Effect.map((normalizedRoot) => [projectId, normalizedRoot] as const)),
      ),
    );
  },
);

export const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

export function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

export function projectEntriesFailureContext(
  error: WorkspaceEntries.WorkspaceEntriesError,
): ProjectEntriesFailureContextResult {
  return Match.value(error).pipe(
    Match.tag("WorkspaceRootNotExistsError", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    }),
    Match.tag("WorkspaceRootCreateFailedError", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    }),
    Match.tag("WorkspaceRootStatFailedError", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    }),
    Match.tag("WorkspaceRootNotDirectoryError", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    }),
    Match.tag("WorkspaceSearchIndexCreateFailed", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    }),
    Match.tag("WorkspaceSearchIndexScanTimedOut", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    }),
    Match.tag("WorkspaceSearchIndexSearchFailed", (error): ProjectEntriesFailureContextResult => {
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    }),
    Match.orElse((error): ProjectEntriesFailureContextResult => {
      return unexpectedCompatibilityError(error);
    }),
  );
}

export function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): ProjectFileFailureContextResult {
  return Match.value(error).pipe(
    Match.tag("WorkspacePathOutsideRootError", (_error): ProjectFileFailureContextResult => {
      return { failure: "workspace_path_outside_root" };
    }),
    Match.tag("WorkspaceFileSystemOperationError", (error): ProjectFileFailureContextResult => {
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    }),
    Match.tag("WorkspaceFilePathEscapeError", (error): ProjectFileFailureContextResult => {
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    }),
    Match.tag("WorkspacePathNotFileError", (error): ProjectFileFailureContextResult => {
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    }),
    Match.tag("WorkspaceBinaryFileError", (error): ProjectFileFailureContextResult => {
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    }),
    Match.orElse((error): ProjectFileFailureContextResult => {
      return unexpectedCompatibilityError(error);
    }),
  );
}

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.message-reaction-set"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.channel-delivery-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.message-reaction-set" ||
    event.type === "thread.channel-delivery-set" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

export const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// A server-config subscription re-probes providers only when their cached
// status is at least this old. Background health checks cover the rest.
export const PROVIDER_SUBSCRIBE_REFRESH_TTL_MS = 60_000;

/**
 * Subscription-triggered provider probes, shared by every connection so a
 * reconnect burst probes each stale instance once instead of once per client.
 * The probes run in the server's scope: a client that disconnects must not
 * cancel a probe other clients skipped theirs for.
 */
export interface ProviderSubscribeRefreshes {
  /** Provider instance ids with a probe in flight. */
  readonly inFlight: Set<string>;
  readonly scope: Scope.Scope;
}

export const THREAD_SHELL_REFETCH = "thread.shell-refetch";

/**
 * A live shell input that only asks for the thread's current shell. It keeps
 * the coalescing key and sequence of the event it replaces without holding the
 * event body.
 */
export interface ThreadShellRefetch {
  readonly type: typeof THREAD_SHELL_REFETCH;
  readonly aggregateKind: "thread";
  readonly aggregateId: ThreadId;
  readonly threadId: ThreadId;
  readonly sequence: number;
}

export type ShellSourceEvent = OrchestrationEvent | ThreadShellRefetch;

/** Thread events whose shell item reads the event payload instead of the projection. */
export const THREAD_SHELL_PAYLOAD_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
]);

/** Reduce a thread event that the shell only refetches to its thread id and sequence. */
export const toShellSourceEvent = (event: OrchestrationEvent): ShellSourceEvent => {
  if (event.aggregateKind !== "thread" || THREAD_SHELL_PAYLOAD_EVENT_TYPES.has(event.type)) {
    return event;
  }

  const threadId = ThreadId.make(event.aggregateId);

  return {
    type: THREAD_SHELL_REFETCH,
    aggregateKind: "thread",
    aggregateId: threadId,
    threadId,
    sequence: event.sequence,
  };
};

/** What one shell subscription has already sent to its client. */
export interface SentThreadShells {
  /** Serialized thread shells last sent, keyed by thread id. */
  readonly threads: Map<string, string>;
  /** Sequence of the last item sent, which is the client's resume cursor. */
  lastSentSequence: number;
}

export const createSentThreadShells = (): SentThreadShells => ({
  threads: new Map(),
  lastSentSequence: 0,
});

/**
 * Record a shell item for one subscription and report whether it repeats the
 * thread shell already sent. A removal clears the entry so a restored thread
 * is always sent again. An unchanged shell is still sent once the client's
 * cursor would fall `SHELL_CURSOR_REFRESH_GAP` events behind, so a long run of
 * unchanged events cannot push a reconnect past the replay window.
 */
export const isUnchangedThreadShell = (
  sent: SentThreadShells,
  item: OrchestrationShellStreamEvent,
): boolean => {
  if (
    item.kind === "thread-upserted" &&
    item.sequence - sent.lastSentSequence < SHELL_CURSOR_REFRESH_GAP
  ) {
    const serialized = JSON.stringify(item.thread);

    if (sent.threads.get(item.thread.id) === serialized) {
      return true;
    }

    sent.threads.set(item.thread.id, serialized);
  } else if (item.kind === "thread-upserted") {
    sent.threads.set(item.thread.id, JSON.stringify(item.thread));
  } else if (item.kind === "thread-removed") {
    sent.threads.delete(item.threadId);
  }

  sent.lastSentSequence = Math.max(sent.lastSentSequence, item.sequence);

  return false;
};

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
export const SHELL_RESUME_MAX_GAP = 1_000;

// A shell subscription re-sends an unchanged thread shell once its client's
// cursor lags this far, keeping reconnects well inside the replay window.
export const SHELL_CURSOR_REFRESH_GAP = SHELL_RESUME_MAX_GAP / 2;

// Thread replay counts only this thread's rows. Busy or pruned unrelated
// streams must not force a full thread snapshot.
export const THREAD_RESUME_MAX_EVENTS = 1_000;

// Row count alone does not bound replay memory: a few events with large tool
// payloads can decode to gigabytes. Before replaying, sum the serialized
// payload bytes of the range in SQL and reset with a snapshot past this budget.
export const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

export function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

export const isClientSurface = Schema.is(ClientSurface);

export const MAX_CLIENT_APP_VERSION_LENGTH = 64;

// Optional client identity announced on the /ws upgrade URL next to wsTicket.
// Lenient by design: absent or malformed values degrade to {} so a connection
// never fails over attribution metadata.
export function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = HttpServerRequest.toURL(request);

  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}

type ProjectEntriesFailureContextResult = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
};

type ProjectFileFailureContextResult = {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
};
