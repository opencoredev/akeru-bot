import {
  AkeruMemoryPartitionId,
  type AkeruMemoryPartition,
  type AkeruMemoryThreadAccess,
  type AkeruMemoryVisibility,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface AuthorizedMemoryPartition extends AkeruMemoryPartition {
  readonly visibility: AkeruMemoryVisibility;
}

export class AkeruMemoryAccessDenied extends Schema.TaggedErrorClass<AkeruMemoryAccessDenied>()(
  "AkeruMemoryAccessDenied",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const partition = (
  input: AkeruMemoryThreadAccess,
  scope: AkeruMemoryPartition["scope"],
  partitionId: string,
  visibility: AkeruMemoryVisibility,
): AuthorizedMemoryPartition => ({
  tenantId: input.tenantId,
  scope,
  partitionId: AkeruMemoryPartitionId.make(partitionId),
  visibility,
});

export function deriveAkeruWorkspaceId(projectId: ProjectId): AkeruMemoryPartitionId {
  return AkeruMemoryPartitionId.make(`workspace:${projectId}`);
}

export function resolveAuthorizedMemoryPartitions(
  input: AkeruMemoryThreadAccess,
): Effect.Effect<ReadonlyArray<AuthorizedMemoryPartition>, AkeruMemoryAccessDenied> {
  if (input.groupId !== null) {
    const respondingBotId = input.respondingBotId ?? input.botId;
    if (
      respondingBotId === null ||
      !input.groupMemberBotIds.some((memberBotId) => memberBotId === respondingBotId)
    ) {
      return Effect.fail(
        new AkeruMemoryAccessDenied({
          reason: "The responding bot is not a current member of this thread's group.",
        }),
      );
    }
    return Effect.succeed([
      partition(input, "group", input.groupId, "shared"),
      partition(input, "project", input.projectId, "shared"),
      partition(input, "workspace", deriveAkeruWorkspaceId(input.projectId), "shared"),
      partition(input, "thread", input.threadId, "shared"),
    ]);
  }

  if (input.botId !== null) {
    return Effect.succeed([
      partition(input, "user", input.userId, "private"),
      partition(input, "bot-user", `${input.botId}:${input.userId}`, "private"),
      partition(input, "bot", input.botId, "private"),
      partition(input, "project", input.projectId, "shared"),
      partition(input, "workspace", deriveAkeruWorkspaceId(input.projectId), "shared"),
      partition(input, "thread", input.threadId, "private"),
    ]);
  }

  return Effect.succeed([
    partition(input, "project", input.projectId, "shared"),
    partition(input, "workspace", deriveAkeruWorkspaceId(input.projectId), "shared"),
    partition(input, "thread", input.threadId, "shared"),
  ]);
}

export function resolveMemoryArchivePartitions(
  input: AkeruMemoryThreadAccess,
  target: "thread" | "bot" | "project" | "workspace" | "all",
): Effect.Effect<ReadonlyArray<AuthorizedMemoryPartition>, AkeruMemoryAccessDenied> {
  return resolveAuthorizedMemoryPartitions(input).pipe(
    Effect.flatMap((partitions) => {
      const selected =
        target === "all"
          ? partitions
          : target === "thread"
            ? partitions.filter((candidate) => candidate.scope === "thread")
            : target === "project"
              ? partitions.filter((candidate) => candidate.scope === "project")
              : target === "workspace"
                ? partitions.filter((candidate) => candidate.scope === "workspace")
                : partitions.filter(
                    (candidate) => candidate.scope === "bot-user" || candidate.scope === "bot",
                  );
      return selected.length > 0
        ? Effect.succeed(selected)
        : Effect.fail(
            new AkeruMemoryAccessDenied({
              reason: `The ${target} memory target is not available to this thread.`,
            }),
          );
    }),
  );
}
