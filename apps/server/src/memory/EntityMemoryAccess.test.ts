import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  AkeruMemoryTenantId,
  AkeruMemoryPartitionId,
  AkeruMemoryUserId,
  BotId,
  GroupId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  deriveAkeruWorkspaceId,
  resolveAuthorizedMemoryPartitions,
  resolveMemoryArchivePartitions,
} from "./EntityMemoryAccess.ts";

const base = {
  tenantId: AkeruMemoryTenantId.make("local"),
  userId: AkeruMemoryUserId.make("owner"),
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  workspaceRoot: "/workspace/one",
  legacyWorkspaceOwnerProjectId: ProjectId.make("project-1"),
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

describe("entity memory access", () => {
  it.effect("keeps private bot memory out of other bot partitions", () =>
    Effect.gen(function* () {
      const first = yield* resolveAuthorizedMemoryPartitions({
        ...base,
        botId: BotId.make("bot-1"),
        groupId: null,
      });
      const second = yield* resolveAuthorizedMemoryPartitions({
        ...base,
        botId: BotId.make("bot-2"),
        groupId: null,
      });

      assert.isTrue(first.some((value) => value.partitionId === "bot-1:owner"));
      assert.isFalse(second.some((value) => value.partitionId === "bot-1:owner"));
      assert.deepEqual(
        first.map((value) => value.scope),
        ["user", "bot-user", "bot", "project", "workspace", "workspace", "thread"],
      );
      assert.isTrue(
        first.some((value) => value.scope === "project" && value.visibility === "shared"),
      );
      assert.isTrue(
        first.some((value) => value.scope === "workspace" && value.visibility === "shared"),
      );
    }),
  );

  it.effect("uses only shared partitions for a group thread", () =>
    Effect.gen(function* () {
      const partitions = yield* resolveAuthorizedMemoryPartitions({
        ...base,
        botId: BotId.make("bot-1"),
        groupId: GroupId.make("group-1"),
        respondingBotId: BotId.make("bot-1"),
        groupMemberBotIds: [BotId.make("bot-1")],
      });

      assert.deepEqual(
        partitions.map((value) => value.scope),
        ["group", "project", "workspace", "workspace", "thread"],
      );
      assert.isTrue(partitions.every((value) => value.visibility === "shared"));
    }),
  );

  it.effect("blocks recall as soon as group membership is absent", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolveAuthorizedMemoryPartitions({
          ...base,
          botId: BotId.make("bot-1"),
          groupId: GroupId.make("group-1"),
          respondingBotId: BotId.make("bot-1"),
          groupMemberBotIds: [],
        }),
      );
      assert.equal(exit._tag, "Failure");
    }),
  );

  it("keeps the workspace partition stable when the project root moves", () => {
    const beforeMove = deriveAkeruWorkspaceId(base.projectId);
    const afterMove = deriveAkeruWorkspaceId(
      { ...base, workspaceRoot: "/workspace/two" }.projectId,
    );
    assert.equal(beforeMove, afterMove);
    assert.notEqual(beforeMove, deriveAkeruWorkspaceId(ProjectId.make("project-2")));
  });

  it.effect("keeps legacy workspace memory reachable in reads and archives", () =>
    Effect.gen(function* () {
      const legacyWorkspaceId = AkeruMemoryPartitionId.make(
        `workspace:${NodeCrypto.createHash("sha256").update(base.workspaceRoot).digest("hex")}`,
      );
      const partitions = yield* resolveMemoryArchivePartitions(
        { ...base, botId: BotId.make("bot-1"), groupId: null },
        "workspace",
      );
      assert.deepEqual(partitions, [
        {
          tenantId: base.tenantId,
          scope: "workspace",
          partitionId: deriveAkeruWorkspaceId(base.projectId),
          visibility: "shared",
        },
        {
          tenantId: base.tenantId,
          scope: "workspace",
          partitionId: legacyWorkspaceId,
          visibility: "shared",
        },
      ]);
    }),
  );

  it.effect("does not authorize legacy workspace memory after a project replaces its owner", () =>
    Effect.gen(function* () {
      const replacementProjectId = ProjectId.make("project-2");
      const partitions = yield* resolveMemoryArchivePartitions(
        {
          ...base,
          projectId: replacementProjectId,
          botId: BotId.make("bot-1"),
          groupId: null,
        },
        "workspace",
      );

      assert.deepEqual(partitions, [
        {
          tenantId: base.tenantId,
          scope: "workspace",
          partitionId: deriveAkeruWorkspaceId(replacementProjectId),
          visibility: "shared",
        },
      ]);
    }),
  );
});
