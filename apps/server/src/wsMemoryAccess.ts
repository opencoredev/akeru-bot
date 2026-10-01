import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AkeruMemoryTenantId, AkeruMemoryUserId, type AkeruMemoryThreadAccess, isGroupBotMember, ThreadId } from "@akeru/contracts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionGroups from "./persistence/Services/ProjectionGroups.ts";
import { type BotMemoryAccess } from "./memory/BotMemory.ts";
import * as AgentController from "./provider/Services/AgentController.ts";
import { memoryOperationError } from "./wsSupport.ts";
export const createWsMemoryAccess = (projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"], projectionGroups: ProjectionGroups.ProjectionGroupRepository["Service"], agentController: AgentController.AgentController["Service"]) => {
      const resolveMemoryAccess = (operation: string, threadId: ThreadId) =>
        Effect.gen(function* () {
          const thread = yield* projectionSnapshotQuery
            .getThreadShellById(threadId)
            .pipe(Effect.mapError((cause) => memoryOperationError(operation, cause)));
          if (Option.isNone(thread)) {
            return yield* memoryOperationError(operation, "The chat does not exist.");
          }
          const project = yield* projectionSnapshotQuery
            .getProjectShellById(thread.value.projectId)
            .pipe(Effect.mapError((cause) => memoryOperationError(operation, cause)));
          if (Option.isNone(project)) {
            return yield* memoryOperationError(operation, "The chat project does not exist.");
          }
          const legacyWorkspaceOwnerProjectId = yield* projectionSnapshotQuery
            .getOriginalProjectIdByWorkspaceRoot(project.value.workspaceRoot)
            .pipe(Effect.mapError((cause) => memoryOperationError(operation, cause)));
          const groupId = thread.value.groupId ?? null;
          const groupMemberBotIds =
            groupId === null
              ? []
              : yield* projectionGroups.getById({ groupId }).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          memoryOperationError(operation, "The chat group does not exist."),
                        ),
                      onSome: (group) =>
                        Effect.succeed(
                          group.members.filter(isGroupBotMember).map((member) => member.botId),
                        ),
                    }),
                  ),
                  Effect.mapError((cause) => memoryOperationError(operation, cause)),
                );
          return {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId,
            projectId: thread.value.projectId,
            workspaceRoot: project.value.workspaceRoot,
            ...(Option.isSome(legacyWorkspaceOwnerProjectId)
              ? { legacyWorkspaceOwnerProjectId: legacyWorkspaceOwnerProjectId.value }
              : {}),
            botId:
              groupId === null
                ? (thread.value.respondingBotId ?? thread.value.botId ?? null)
                : null,
            groupId,
            respondingBotId: thread.value.respondingBotId ?? thread.value.botId ?? null,
            groupMemberBotIds,
          } satisfies AkeruMemoryThreadAccess;
        });

      const resolveBotMemoryAccess = (operation: string, threadId: ThreadId) =>
        resolveMemoryAccess(operation, threadId).pipe(
          Effect.flatMap((access) => {
            const botId = access.respondingBotId ?? access.botId;
            return botId
              ? Effect.succeed({
                  botId,
                  groupId: access.groupId,
                  groupMemberBotIds: access.groupMemberBotIds,
                } satisfies BotMemoryAccess)
              : Effect.fail(memoryOperationError(operation, "This chat has no responding bot."));
          }),
        );

      const readArchiveConversations = (
        anchor: AkeruMemoryThreadAccess,
        target: "thread" | "bot" | "project" | "workspace" | "all",
      ) =>
        projectionSnapshotQuery.getShellSnapshot().pipe(
          Effect.mapError((cause) => memoryOperationError("archive.export", cause)),
          Effect.flatMap((shell) => {
            const projectIds = new Set(
              shell.projects
                .filter((project) =>
                  target === "all"
                    ? true
                    : target === "project"
                      ? project.id === anchor.projectId
                      : target === "workspace"
                        ? project.workspaceRoot === anchor.workspaceRoot
                        : true,
                )
                .map((project) => project.id),
            );
            const threads = shell.threads.filter((thread) => {
              if (target === "thread") return thread.id === anchor.threadId;
              if (!projectIds.has(thread.projectId)) return false;
              if (target !== "bot") return true;
              return (
                (thread.respondingBotId ?? thread.botId) ===
                (anchor.respondingBotId ?? anchor.botId)
              );
            });
            return Effect.forEach(
              threads,
              (thread) =>
                agentController.readConversationMemory
                  ? agentController.readConversationMemory(thread.id).pipe(
                      Effect.map((snapshot) => ({ threadId: thread.id, snapshot })),
                      Effect.mapError((cause) => memoryOperationError("archive.export", cause)),
                    )
                  : Effect.fail(
                      memoryOperationError(
                        "archive.export",
                        "Observational memory is unavailable.",
                      ),
                    ),
              { concurrency: 4 },
            ).pipe(Effect.mapError((cause) => memoryOperationError("archive.export", cause)));
          }),
        );


return { resolveMemoryAccess, resolveBotMemoryAccess, readArchiveConversations };
};
