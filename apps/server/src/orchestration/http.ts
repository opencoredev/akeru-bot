import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import {
  applyAuthenticatedCommandActor,
  applyKnownGroupPerson,
  canManageGroupPeople,
} from "./AuthenticatedCommand.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const decodedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          if (!canManageGroupPeople(decodedCommand, principal.scopes)) {
            return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
          }
          const needsPeople =
            decodedCommand.type === "group.create" ||
            decodedCommand.type === "group.leave" ||
            decodedCommand.type === "group.person.assign" ||
            decodedCommand.type === "group.person.unassign" ||
            decodedCommand.type === "thread.turn.start";
          const clientSessions = needsPeople
            ? yield* serverAuth
                .listClientSessions(principal.sessionId)
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_dispatch_failed", cause),
                  ),
                )
            : [];
          const currentClient = clientSessions.find(
            (session) => session.sessionId === principal.sessionId,
          );
          const actor = {
            personId: principal.sessionId,
            displayName:
              currentClient?.client.label ??
              (principal.scopes.has(AuthAccessWriteScope) ? "Host" : "Paired person"),
            canManageGroups: principal.scopes.has(AuthAccessWriteScope),
          };
          const actorCommand = applyAuthenticatedCommandActor(decodedCommand, actor);
          const normalizedCommand = applyKnownGroupPerson(actorCommand, clientSessions);
          if (!normalizedCommand) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          return yield* orchestrationEngine.dispatch(normalizedCommand, { actor }).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
        }),
      );
  }),
);
