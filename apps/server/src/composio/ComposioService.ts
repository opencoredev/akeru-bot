import { Composio } from "@composio/core";
import {
  ComposioOperationError,
  type ComposioAuthorizeInput,
  type ComposioAuthorizeResult,
  type ComposioConnection,
  type ComposioStatus,
  type ComposioToolkit,
  type McpServer,
  McpServerId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { withMcpRuntimeHeaders } from "../provider/McpServerConfig.ts";

const API_KEY_SECRET = "composio-api-key";
const USER_ID_SECRET = "composio-user-id";
const COMPOSIO_MCP_SERVER_ID = McpServerId.make("composio-session");
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type ComposioClient = InstanceType<typeof Composio>;
type ComposioClientFactory = (apiKey: string) => ComposioClient;

export interface ComposioServiceShape {
  readonly getStatus: Effect.Effect<ComposioStatus, ComposioOperationError>;
  readonly configure: (apiKey: string) => Effect.Effect<ComposioStatus, ComposioOperationError>;
  readonly remove: Effect.Effect<ComposioStatus, ComposioOperationError>;
  readonly searchToolkits: (input: {
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<readonly ComposioToolkit[], ComposioOperationError>;
  readonly authorize: (
    input: ComposioAuthorizeInput,
  ) => Effect.Effect<ComposioAuthorizeResult, ComposioOperationError>;
  readonly disconnect: (
    connectionId: string,
  ) => Effect.Effect<ComposioStatus, ComposioOperationError>;
  readonly resolveRuntimeMcpServer: (
    resourceId: string,
  ) => Effect.Effect<McpServer | undefined, ComposioOperationError>;
}

export class ComposioService extends Context.Service<ComposioService, ComposioServiceShape>()(
  "akeru-bot/composio/ComposioService",
) {}

function operationError(operation: string, cause: unknown): ComposioOperationError {
  const status =
    typeof cause === "object" && cause !== null && "status" in cause
      ? Number((cause as { readonly status?: unknown }).status)
      : undefined;
  const message =
    status === 401
      ? "The Composio API key is invalid."
      : status === 403
        ? "The Composio API key does not have permission for this operation."
        : status === 429
          ? "Composio rate-limited this request. Try again shortly."
          : `Composio could not ${operation}.`;
  return new ComposioOperationError({ operation, message });
}

function isNotFoundError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    Number((cause as { readonly status?: unknown }).status) === 404
  );
}

const tryComposio = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => operationError(operation, cause),
  });

function bytesToId(bytes: Uint8Array): string {
  return `akeru_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function toConnection(input: {
  readonly id: string;
  readonly toolkit: { readonly slug: string };
  readonly status: ComposioConnection["status"];
  readonly alias?: string | null;
}): ComposioConnection {
  return {
    id: input.id,
    toolkitSlug: input.toolkit.slug,
    status: input.status,
    ...(input.alias ? { alias: input.alias } : {}),
  };
}

export function make(
  secretStore: ServerSecretStore["Service"],
  createClient: ComposioClientFactory = (apiKey) => new Composio({ apiKey }),
): ComposioServiceShape {
  let runtimeConfigurationGeneration = 0;
  const pendingHostedSessionDeletes = new Set<() => Promise<void>>();
  const pendingRuntimeResolutions = new Map<
    string,
    {
      readonly generation: number;
      readonly promise: Promise<McpServer | undefined>;
    }
  >();
  const runtimeCache = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly server: McpServer;
      readonly deleteSession: () => Promise<void>;
    }
  >();

  const deleteCachedSession = async (resourceId: string) => {
    const cached = runtimeCache.get(resourceId);
    if (!cached) return;
    try {
      await cached.deleteSession();
    } catch (cause) {
      if (!isNotFoundError(cause)) throw cause;
    }
    if (runtimeCache.get(resourceId) === cached) runtimeCache.delete(resourceId);
  };

  const clearRuntimeCache = async () => {
    for (const resourceId of runtimeCache.keys()) {
      await deleteCachedSession(resourceId);
    }
  };

  const deletePendingHostedSession = async (deleteSession: () => Promise<void>) => {
    try {
      await deleteSession();
    } catch (cause) {
      if (!isNotFoundError(cause)) throw cause;
    }
    pendingHostedSessionDeletes.delete(deleteSession);
  };

  const clearPendingHostedSessions = async () => {
    for (const deleteSession of pendingHostedSessionDeletes) {
      await deletePendingHostedSession(deleteSession);
    }
  };

  const clearHostedSessions = async () => {
    await clearRuntimeCache();
    await clearPendingHostedSessions();
  };

  const invalidateHostedSessions = async () => {
    runtimeConfigurationGeneration += 1;
    await clearHostedSessions();
  };

  const readApiKey = secretStore.get(API_KEY_SECRET).pipe(
    Effect.mapError((cause) => operationError("read its API key", cause)),
    Effect.map(Option.map((bytes) => textDecoder.decode(bytes).trim())),
    Effect.map(Option.filter((apiKey) => apiKey.length > 0)),
  );

  const readUserId = secretStore.getOrCreateRandom(USER_ID_SECRET, 16).pipe(
    Effect.map(bytesToId),
    Effect.mapError((cause) => operationError("prepare its local user", cause)),
  );

  const withClient = <A>(
    operation: string,
    run: (client: ComposioClient, userId: string) => Promise<A>,
  ) =>
    Effect.gen(function* () {
      const apiKey = yield* readApiKey;
      if (Option.isNone(apiKey)) {
        return yield* new ComposioOperationError({
          operation,
          message: "Connect Composio in Settings first.",
        });
      }
      const userId = yield* readUserId;
      return yield* tryComposio(operation, () => run(createClient(apiKey.value), userId));
    });

  const listConnections = (client: ComposioClient, userId: string) =>
    client.connectedAccounts
      .list({ userIds: [userId], accountType: "ALL", limit: 100 })
      .then((response) => response.items.map(toConnection));

  const getStatus: ComposioServiceShape["getStatus"] = Effect.gen(function* () {
    const apiKey = yield* readApiKey;
    if (Option.isNone(apiKey)) return { configured: false, connections: [] };
    const userId = yield* readUserId;
    const connections = yield* tryComposio("load connected accounts", () =>
      listConnections(createClient(apiKey.value), userId),
    );
    return { configured: true, connections };
  });

  const configure: ComposioServiceShape["configure"] = (apiKey) =>
    Effect.gen(function* () {
      const normalized = apiKey.trim();
      if (!normalized) {
        return yield* new ComposioOperationError({
          operation: "save its API key",
          message: "Enter a Composio API key.",
        });
      }
      const client = createClient(normalized);
      yield* tryComposio("validate its API key", () => client.toolkits.get({ limit: 1 }));
      yield* tryComposio("delete hosted tool sessions", invalidateHostedSessions);
      yield* secretStore
        .set(API_KEY_SECRET, textEncoder.encode(normalized))
        .pipe(Effect.mapError((cause) => operationError("save its API key", cause)));
      yield* tryComposio("delete hosted tool sessions", invalidateHostedSessions);
      return yield* getStatus;
    });

  const remove: ComposioServiceShape["remove"] = Effect.gen(function* () {
    yield* tryComposio("delete hosted tool sessions", invalidateHostedSessions);
    yield* secretStore
      .remove(API_KEY_SECRET)
      .pipe(Effect.mapError((cause) => operationError("remove its API key", cause)));
    yield* tryComposio("delete hosted tool sessions", invalidateHostedSessions);
    return { configured: false, connections: [] };
  });

  const searchToolkits: ComposioServiceShape["searchToolkits"] = (input) =>
    withClient("load toolkits", async (client) => {
      const limit = input.limit ?? 50;
      const query = input.query?.trim().toLowerCase() ?? "";
      const toolkits = await client.toolkits.get({ limit: 50, sortBy: "usage" });
      return toolkits
        .filter((toolkit) => {
          if (!query) return true;
          return [toolkit.name, toolkit.slug, toolkit.meta.description ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(query);
        })
        .slice(0, limit)
        .map(
          (toolkit): ComposioToolkit => ({
            slug: toolkit.slug,
            name: toolkit.name,
            ...(toolkit.meta.description ? { description: toolkit.meta.description } : {}),
            ...(toolkit.meta.logo ? { logoUrl: toolkit.meta.logo } : {}),
            categories: toolkit.meta.categories?.map((category) => category.name) ?? [],
            toolsCount: toolkit.meta.toolsCount ?? 0,
          }),
        );
    });

  const authorize: ComposioServiceShape["authorize"] = (input) =>
    withClient("start account authorization", async (client, userId) => {
      await invalidateHostedSessions();
      const session = await client.sessions.create(userId, {
        mcp: true,
        toolkits: [input.toolkitSlug],
        manageConnections: true,
        multiAccount: { enable: true, maxAccountsPerToolkit: 10 },
      });
      const deleteSession = () => session.delete().then(() => undefined);
      pendingHostedSessionDeletes.add(deleteSession);
      const authorization = await session
        .authorize(input.toolkitSlug, input.alias ? { alias: input.alias } : undefined)
        .then((request) => {
          if (!request.redirectUrl) {
            throw new Error("Composio did not return an authorization URL.");
          }
          return { connectionId: request.id, redirectUrl: request.redirectUrl };
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const cleanup = await deletePendingHostedSession(deleteSession).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!authorization.ok) {
        if (!cleanup.ok) {
          throw new AggregateError(
            [authorization.error, cleanup.error],
            "Composio authorization and hosted-session cleanup both failed.",
            { cause: authorization.error },
          );
        }
        throw authorization.error;
      }
      if (!cleanup.ok) {
        throw cleanup.error;
      }
      return authorization.value;
    });

  const disconnect: ComposioServiceShape["disconnect"] = (connectionId) =>
    withClient("disconnect an account", async (client) => {
      await invalidateHostedSessions();
      await client.connectedAccounts.delete(connectionId);
      await invalidateHostedSessions();
    }).pipe(Effect.flatMap(() => getStatus));

  const resolveRuntimeMcpServer: ComposioServiceShape["resolveRuntimeMcpServer"] = (resourceId) =>
    withClient("prepare connected tools", async (client, userId) => {
      const configurationGeneration = runtimeConfigurationGeneration;
      const pending = pendingRuntimeResolutions.get(resourceId);
      if (pending?.generation === configurationGeneration) return pending.promise;
      const resolving = (async () => {
        const connections = (await listConnections(client, userId)).filter(
          (connection) => connection.status === "ACTIVE",
        );
        if (connections.length === 0) {
          await deleteCachedSession(resourceId);
          return undefined;
        }
        const connectedAccounts = Object.groupBy(
          connections,
          (connection) => connection.toolkitSlug,
        );
        const accountMap = Object.fromEntries(
          Object.entries(connectedAccounts).map(([toolkit, accounts]) => [
            toolkit,
            (accounts ?? []).map((account) => account.id),
          ]),
        );
        const fingerprint = JSON.stringify(accountMap);
        const cached = runtimeCache.get(resourceId);
        if (cached?.fingerprint === fingerprint) return cached.server;
        await deleteCachedSession(resourceId);
        if (runtimeCache.size >= 100) {
          const oldest = runtimeCache.keys().next().value;
          if (oldest !== undefined) await deleteCachedSession(oldest);
        }
        const session = await client.sessions.create(userId, {
          mcp: true,
          toolkits: Object.keys(accountMap),
          connectedAccounts: accountMap,
          manageConnections: true,
          multiAccount: {
            enable: true,
            maxAccountsPerToolkit: 10,
            requireExplicitSelection: true,
          },
        });
        const deleteSession = () => session.delete().then(() => undefined);
        if (configurationGeneration !== runtimeConfigurationGeneration) {
          pendingHostedSessionDeletes.add(deleteSession);
          await deletePendingHostedSession(deleteSession);
          return undefined;
        }
        const now = "1970-01-01T00:00:00.000Z";
        const server = withMcpRuntimeHeaders(
          {
            id: COMPOSIO_MCP_SERVER_ID,
            name: "Composio",
            transport: "url",
            url: session.mcp.url,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
          session.mcp.headers ?? {},
        );
        runtimeCache.set(resourceId, {
          fingerprint,
          server,
          deleteSession,
        });
        return server;
      })();
      const pendingResolution = { generation: configurationGeneration, promise: resolving };
      pendingRuntimeResolutions.set(resourceId, pendingResolution);
      try {
        return await resolving;
      } finally {
        if (pendingRuntimeResolutions.get(resourceId) === pendingResolution) {
          pendingRuntimeResolutions.delete(resourceId);
        }
      }
    }).pipe(
      Effect.catch((error) =>
        error.message === "Connect Composio in Settings first."
          ? Effect.succeed<McpServer | undefined>(undefined)
          : Effect.fail(error),
      ),
    );

  return {
    getStatus,
    configure,
    remove,
    searchToolkits,
    authorize,
    disconnect,
    resolveRuntimeMcpServer,
  };
}

export const layer = Layer.effect(
  ComposioService,
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    return make(secretStore);
  }),
);
