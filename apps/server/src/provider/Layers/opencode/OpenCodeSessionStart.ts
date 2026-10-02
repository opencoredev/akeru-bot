import {
  type EventId,
  type OpenCodeSettings,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeItemId,
  type RuntimeRequestId,
  type ThreadId,
  type TurnId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { type ServerConfig } from "../../../config.ts";
import * as McpProviderSession from "../../../mcp/McpProviderSession.ts";
import { subscriptionRuntimeEnvironment } from "../../../subscription-auth/runtime.ts";
import { type ProviderAdapterRequestError } from "../../Errors.ts";
import { getMcpRuntimeHeaders } from "../../McpServerConfig.ts";
import {
  buildOpenCodePermissionRules,
  type OpenCodeRuntime,
  OpenCodeRuntimeError,
  runOpenCodeSdk,
} from "../../opencodeRuntime.ts";
import { type OpenCodeAdapterShape } from "../../Services/OpenCodeAdapter.ts";
import {
  type EventBaseInput,
  OPENCODE_RESUME_VERSION,
  type OpenCodeSessionContext,
  PROVIDER,
} from "./OpenCodeAdapterState.ts";
import {
  isOpenCodeNotFound,
  nowIso,
  parseOpenCodeResume,
  toProcessError,
} from "./OpenCodeProtocol.ts";
import type { createOpenCodeEvents } from "./OpenCodeEvents.ts";
import { stopOpenCodeContext } from "./OpenCodeSessionLifecycle.ts";

/**
 * Starts an OpenCode session: connects to (or spawns) the server, attaches MCP
 * servers, then resumes, forks, or creates the remote session before
 * registering its context and starting the event pump.
 */
export function createOpenCodeSessionStart(deps: {
  readonly openCodeSettings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly boundInstanceId: ProviderInstanceId;
  readonly serverConfig: ServerConfig["Service"];
  readonly openCodeRuntime: OpenCodeRuntime["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sameDirectory: (left: string, right: string) => Effect.Effect<boolean>;
  readonly sessions: Map<ThreadId, OpenCodeSessionContext>;
  readonly startEventPump: ReturnType<typeof createOpenCodeEvents>["startEventPump"];
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
  readonly buildEventBase: (input: EventBaseInput) => Effect.Effect<
    {
      raw?: { source: "opencode.sdk.event"; payload: {} | null };
      requestId?: RuntimeRequestId;
      itemId?: RuntimeItemId;
      turnId?: TurnId;
      eventId: EventId;
      provider: ProviderDriverKind;
      threadId: ThreadId;
      createdAt: string;
    },
    ProviderAdapterRequestError,
    never
  >;
}) {
  const {
    openCodeSettings,
    boundInstanceId,
    serverConfig,
    openCodeRuntime,
    fileSystem,
    path,
    sameDirectory,
    sessions,
    startEventPump,
    emit,
    buildEventBase,
  } = deps;

  const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const binaryPath = openCodeSettings.binaryPath;
      const serverUrl = openCodeSettings.serverUrl;
      const serverPassword = openCodeSettings.serverPassword;
      const directory = input.cwd ?? serverConfig.cwd;
      const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
      const existing = sessions.get(input.threadId);

      if (existing) {
        yield* stopOpenCodeContext(existing);
        sessions.delete(input.threadId);
      }

      const started = yield* Effect.gen(function* () {
        const sessionScope = yield* Scope.make();

        const startedExit = yield* Effect.exit(
          Effect.gen(function* () {
            // The runtime binds the server's lifetime to the Scope.Scope
            // we provide below — closing `sessionScope` kills the child
            // process automatically. No manual `server.close()` needed.
            const server = yield* openCodeRuntime.connectToOpenCodeServer({
              binaryPath,
              serverUrl,
              environment: yield* subscriptionRuntimeEnvironment(
                serverConfig.secretsDir,
                "opencode-go",
                deps.environment,
                boundInstanceId,
              ).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            });

            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory,
              ...(server.external && serverPassword ? { serverPassword } : {}),
            });

            yield* Effect.forEach(
              input.mcpServers ?? [],
              (mcpServer) =>
                runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    name: String(mcpServer.id),
                    config:
                      mcpServer.transport === "url"
                        ? {
                            type: "remote",
                            url: mcpServer.url,
                            ...(Object.keys(getMcpRuntimeHeaders(mcpServer)).length > 0
                              ? { headers: getMcpRuntimeHeaders(mcpServer) }
                              : {}),
                            oauth: false,
                          }
                        : {
                            type: "local",
                            command: [mcpServer.command, ...(mcpServer.args ?? [])],
                          },
                  }),
                ),
              { discard: true },
            );
            const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);

            if (mcpSession && !server.external) {
              yield* runOpenCodeSdk("mcp.add", () =>
                client.mcp.add({
                  name: "akeru",
                  config: {
                    type: "remote",
                    url: mcpSession.endpoint,
                    headers: {
                      Authorization: mcpSession.authorizationHeader,
                    },
                    oauth: false,
                  },
                }),
              );
            }

            // Resume: re-adopt the session named by the durable cursor —
            // OpenCode scopes history by session id. The probe recovers only
            // a confirmed not-found (start fresh); transport/auth/server
            // errors propagate instead of masking as a new empty session.
            const resolved = yield* Effect.gen(function* () {
              const adopted = resumeSessionId
                ? yield* runOpenCodeSdk("session.get", () =>
                    client.session.get({ sessionID: resumeSessionId }),
                  ).pipe(
                    Effect.map((response) => response.data),
                    Effect.catchIf(
                      (cause) => isOpenCodeNotFound(cause),
                      () => Effect.void,
                    ),
                  )
                : undefined;

              // Reuse in place only when the session still matches the
              // requested cwd; on a cwd change it is forked below instead.
              const reusable =
                adopted &&
                (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                  ? adopted
                  : undefined;

              if (reusable) {
                // Resume skips `session.create`, so re-assert the ruleset —
                // a runtime-mode change would otherwise leave the session on
                // its original permissions.
                yield* runOpenCodeSdk("session.update", () =>
                  client.session.update({
                    sessionID: reusable.id,
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );

                return { openCodeSession: reusable, created: false };
              }

              // The session lives under a different cwd (e.g. the thread
              // moved into a git worktree). Fork it into the requested
              // directory instead of minting an empty one — the fork carries
              // the full history, so the follow-up keeps its context (#3604).
              if (adopted) {
                yield* Effect.logInfo(
                  `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                );

                const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                  client.session.fork({ sessionID: adopted.id, directory }),
                );

                const forked = forkedSession.data;

                if (!forked) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.fork",
                    detail: "OpenCode session.fork returned no session payload.",
                  });
                }

                yield* runOpenCodeSdk("session.update", () =>
                  client.session.update({
                    sessionID: forked.id,
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );

                return { openCodeSession: forked, created: true };
              }

              if (resumeSessionId) {
                yield* Effect.logWarning(
                  `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                );
              }

              const createdSession = yield* runOpenCodeSdk("session.create", () =>
                client.session.create({
                  ...(input.title ? { title: input.title } : {}),
                  permission: buildOpenCodePermissionRules(input.runtimeMode),
                }),
              );

              if (!createdSession.data) {
                return yield* new OpenCodeRuntimeError({
                  operation: "session.create",
                  detail: "OpenCode session.create returned no session payload.",
                });
              }

              return { openCodeSession: createdSession.data, created: true };
            });

            return {
              sessionScope,
              server,
              client,
              openCodeSession: resolved.openCodeSession,
              created: resolved.created,
            };
          }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
        );

        if (Exit.isFailure(startedExit)) {
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);

          return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
        }

        return startedExit.value;
      });

      // Guard against a concurrent startSession call that may have raced
      // and already inserted a session while we were awaiting async work.
      const raceWinner = sessions.get(input.threadId);

      if (raceWinner) {
        // Another call won the race — clean up. Only abort the remote
        // session if we created it here; a resumed one is shared upstream
        // state the winner is now using.
        if (started.created) {
          yield* runOpenCodeSdk("session.abort", () =>
            started.client.session.abort({
              sessionID: started.openCodeSession.id,
            }),
          ).pipe(Effect.ignore);
        }

        yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);

        return raceWinner.session;
      }

      const createdAt = yield* nowIso;

      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: directory,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        // ProviderService persists this cursor and feeds it back into
        // `startSession` after the in-memory session is lost (reaper /
        // restart), so follow-ups continue the same conversation (#3604).
        resumeCursor: {
          schemaVersion: OPENCODE_RESUME_VERSION,
          sessionId: started.openCodeSession.id,
        },
        createdAt,
        updatedAt: createdAt,
      };

      const context: OpenCodeSessionContext = {
        session,
        client: started.client,
        server: started.server,
        directory,
        openCodeSessionId: started.openCodeSession.id,
        relatedSessionIds: new Set([started.openCodeSession.id]),
        resolvedRequestIds: new Set(),
        autoRepliedRequestIds: new Set(),
        requestRelationRetries: new Map(),
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        messageRoleById: new Map(),
        textPartsByMessageId: new Map(),
        textPartById: new Map(),
        activeTurnId: undefined,
        activeAgent: undefined,
        activeVariant: undefined,
        stopped: yield* Ref.make(false),
        sessionScope: started.sessionScope,
      };

      sessions.set(input.threadId, context);
      yield* startEventPump(context);

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "session.started",
        payload: {
          message: "OpenCode session started",
        },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId })),
        type: "thread.started",
        payload: {
          providerThreadId: started.openCodeSession.id,
        },
      });

      return session;
    },
  );

  return startSession;
}
