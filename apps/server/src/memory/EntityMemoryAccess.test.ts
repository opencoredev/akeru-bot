import { assert, describe, it } from "@effect/vitest";
import {
  AkeruMemoryTenantId,
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
  resolveRecallMemoryPartitions,
} from "./EntityMemoryAccess.ts";

const base = {
  tenantId: AkeruMemoryTenantId.make("local"),
  userId: AkeruMemoryUserId.make("owner"),
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  workspaceRoot: "/workspace/one",
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
      const recalled = yield* resolveRecallMemoryPartitions({
        ...base,
        botId: BotId.make("bot-1"),
        groupId: null,
      });
      assert.deepEqual(
        recalled.map((value) => value.scope),
        ["user", "bot-user", "bot", "thread"],
      );
      assert.isTrue(recalled.every((value) => value.visibility === "private"));
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
        ["group", "project", "workspace", "thread"],
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

  it("derives stable opaque workspace partitions", () => {
    const first = deriveAkeruWorkspaceId("/workspaces/akeru");
    const second = deriveAkeruWorkspaceId("/workspaces/akeru");
    assert.equal(first, second);
    assert.notInclude(first, "/workspaces/akeru");
  });
});
