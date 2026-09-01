import {
  BotId,
  CommandId,
  GroupId,
  McpServerId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const TestLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-bot-persistence-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("bot persistence", (it) => {
  it.effect("creates, edits, archives, restores, and rebuilds bots and groups", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const botId = BotId.make("bot-1");
      const groupId = GroupId.make("group-1");
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-bot-create"),
        botId,
        name: "Scout",
        title: "Research lead",
        label: "Research",
        description: "Finds evidence for product decisions.",
        avatar: { kind: "blob", shape: "hex", color: "#7357ff" },
        engine: { provider: "codex", model: "gpt-5.6" },
        sandbox: "local",
        runtimeMode: "full-access",
        usageCap: null,
        groupId: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "group.create",
        commandId: CommandId.make("cmd-group-create"),
        groupId,
        name: "Product",
        bossBotId: botId,
        createdAt,
      });
      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-bot-update"),
        botId,
        name: "Pathfinder",
        title: "Staff researcher",
        label: "Discovery",
        description: "Investigates the highest-risk assumptions.",
        disabledMcpServerIds: [McpServerId.make("mcp-github")],
        avatar: { kind: "dither", seed: "pathfinder" },
        engine: null,
        sandbox: null,
        runtimeMode: "approval-required",
        usageCap: { unit: "tokens", limit: 50_000 },
        voiceEnabled: true,
      });
      yield* engine.dispatch({
        type: "bot.archive",
        commandId: CommandId.make("cmd-bot-archive"),
        botId,
      });

      const archived = yield* snapshots.getShellSnapshot();
      assert.equal(archived.bots.length, 1);
      assert.notEqual(archived.bots[0]?.archivedAt, null);

      yield* engine.dispatch({
        type: "bot.restore",
        commandId: CommandId.make("cmd-bot-restore"),
        botId,
      });
      yield* engine.dispatch({
        type: "group.rename",
        commandId: CommandId.make("cmd-group-rename"),
        groupId,
        name: "Discovery",
      });

      const restored = yield* snapshots.getShellSnapshot();
      assert.deepEqual(restored.bots, [
        {
          id: botId,
          name: "Pathfinder",
          title: "Staff researcher",
          label: "Discovery",
          description: "Investigates the highest-risk assumptions.",
          disabledMcpServerIds: [McpServerId.make("mcp-github")],
          avatar: { kind: "dither", seed: "pathfinder" },
          engine: null,
          sandbox: null,
          runtimeMode: "approval-required",
          usageCap: { unit: "tokens", limit: 50_000 },
          voiceEnabled: true,
          groupId,
          archivedAt: null,
          createdAt,
          updatedAt: restored.bots[0]!.updatedAt,
        },
      ]);
      assert.deepEqual(restored.groups, [
        {
          id: groupId,
          name: "Discovery",
          bossBotId: botId,
          members: [{ botId, role: "boss" }],
          createdAt,
          updatedAt: restored.groups[0]!.updatedAt,
        },
      ]);

      yield* engine.dispatch({
        type: "group.delete",
        commandId: CommandId.make("cmd-group-delete"),
        groupId,
      });
      assert.deepEqual((yield* snapshots.getShellSnapshot()).groups, []);

      yield* sql`DELETE FROM projection_bots`;
      yield* sql`DELETE FROM projection_groups`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN ('projection.bots', 'projection.groups')
      `;
      yield* projectionPipeline.bootstrap;

      const rebuilt = yield* snapshots.getSnapshot();
      assert.equal(rebuilt.bots.length, 1);
      assert.equal(rebuilt.bots[0]?.id, botId);
      assert.equal(rebuilt.bots[0]?.name, "Pathfinder");
      assert.equal(rebuilt.bots[0]?.voiceEnabled, true);
      assert.equal(rebuilt.bots[0]?.groupId, null);
      assert.equal(rebuilt.bots[0]?.archivedAt, null);
      assert.deepEqual(rebuilt.groups, []);
    }),
  );

  it.effect("rejects invalid bot groups, missing bots, and archived thread owners", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectId = ProjectId.make("project-bot-invariants");
      const botId = BotId.make("bot-invariants");
      const missingBotId = BotId.make("bot-missing");
      const missingGroupId = GroupId.make("group-missing");
      const createdAt = "2026-01-03T00:00:00.000Z";
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      };
      const makeBotCreate = (input: { readonly botId: BotId; readonly groupId: GroupId | null }) =>
        engine.dispatch({
          type: "bot.create",
          commandId: CommandId.make(
            `cmd-create-${input.botId}-${input.groupId ?? "without-group"}`,
          ),
          botId: input.botId,
          name: "Builder",
          title: "Backend engineer",
          avatar: { kind: "dither", seed: input.botId },
          engine: null,
          sandbox: "local",
          runtimeMode: "full-access",
          usageCap: null,
          groupId: input.groupId,
          createdAt,
        });

      assert.equal(
        (yield* Effect.result(makeBotCreate({ botId, groupId: missingGroupId })))._tag,
        "Failure",
      );
      yield* makeBotCreate({ botId, groupId: null });
      assert.equal(
        (yield* Effect.result(
          engine.dispatch({
            type: "bot.update",
            commandId: CommandId.make("cmd-update-unknown-group"),
            botId,
            groupId: missingGroupId,
          }),
        ))._tag,
        "Failure",
      );

      const missingBotResults = yield* Effect.all([
        Effect.result(
          engine.dispatch({
            type: "bot.update",
            commandId: CommandId.make("cmd-update-missing-bot"),
            botId: missingBotId,
            name: "Missing",
          }),
        ),
        Effect.result(
          engine.dispatch({
            type: "bot.archive",
            commandId: CommandId.make("cmd-archive-missing-bot"),
            botId: missingBotId,
          }),
        ),
        Effect.result(
          engine.dispatch({
            type: "bot.restore",
            commandId: CommandId.make("cmd-restore-missing-bot"),
            botId: missingBotId,
          }),
        ),
      ]);
      assert.deepEqual(
        missingBotResults.map((result) => result._tag),
        ["Failure", "Failure", "Failure"],
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-bot-invariant-project"),
        projectId,
        title: "Bot invariants",
        workspaceRoot: "/tmp/bot-invariants",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* engine.dispatch({
        type: "bot.archive",
        commandId: CommandId.make("cmd-archive-owner"),
        botId,
      });
      const archivedOwnerResult = yield* Effect.result(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-archived-owner"),
          threadId: ThreadId.make("thread-archived-owner"),
          projectId,
          botId,
          title: "Archived owner",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      assert.equal(archivedOwnerResult._tag, "Failure");
    }),
  );

  it.effect("persists the selected responder on group turns", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-group-routing");
      const groupId = GroupId.make("group-routing");
      const bossBotId = BotId.make("bot-routing-boss");
      const specialistBotId = BotId.make("bot-routing-specialist");
      const threadId = ThreadId.make("thread-group-routing");
      const createdAt = "2026-01-04T00:00:00.000Z";
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      };

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-routing-project"),
        projectId,
        title: "Routing",
        workspaceRoot: "/tmp/group-routing",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      for (const botId of [bossBotId, specialistBotId]) {
        yield* engine.dispatch({
          type: "bot.create",
          commandId: CommandId.make(`cmd-routing-${botId}`),
          botId,
          name: botId,
          title: "Agent",
          avatar: { kind: "dither", seed: botId },
          engine: null,
          sandbox: "local",
          runtimeMode: "full-access",
          usageCap: null,
          groupId: null,
          createdAt,
        });
      }
      yield* engine.dispatch({
        type: "group.create",
        commandId: CommandId.make("cmd-routing-group"),
        groupId,
        name: "Routing group",
        bossBotId,
        specialistBotIds: [specialistBotId],
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-routing-thread"),
        threadId,
        projectId,
        groupId,
        title: "Routing thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-routing-turn"),
        threadId,
        respondingBotId: specialistBotId,
        message: {
          messageId: MessageId.make("message-routing"),
          role: "user",
          text: "Investigate",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });

      const thread = (yield* snapshots.getShellSnapshot()).threads.find(
        (entry) => entry.id === threadId,
      );
      assert.equal(thread?.respondingBotId, specialistBotId);
      const turnRows = yield* sql<{ readonly respondingBotId: string | null }>`
        SELECT responding_bot_id AS "respondingBotId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(turnRows, [{ respondingBotId: specialistBotId }]);

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-routing-thread-delete"),
        threadId,
      });
    }),
  );

  it.effect("persists bot and group thread ownership across projection rebuilds", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-ownership");
      const botId = BotId.make("bot-owner");
      const groupId = GroupId.make("group-owner");
      const createdAt = "2026-01-02T00:00:00.000Z";
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      };

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-owner-project"),
        projectId,
        title: "Ownership",
        workspaceRoot: "/tmp/ownership",
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-owner-bot"),
        botId,
        name: "Builder",
        title: "Backend engineer",
        avatar: { kind: "dither", seed: "builder" },
        engine: null,
        sandbox: "local",
        runtimeMode: "full-access",
        usageCap: null,
        groupId: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "group.create",
        commandId: CommandId.make("cmd-owner-group"),
        groupId,
        name: "Owners",
        bossBotId: botId,
        createdAt,
      });

      const createThread = (input: {
        readonly threadId: ThreadId;
        readonly botId?: BotId | null;
        readonly groupId?: GroupId | null;
      }) =>
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-${input.threadId}`),
          threadId: input.threadId,
          projectId,
          ...(input.botId !== undefined ? { botId: input.botId } : {}),
          ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
          title: input.threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });

      yield* createThread({ threadId: ThreadId.make("thread-bot"), botId });
      yield* createThread({ threadId: ThreadId.make("thread-group"), groupId });
      yield* createThread({ threadId: ThreadId.make("thread-unowned") });

      const invalidOwnership = yield* Effect.result(
        createThread({ threadId: ThreadId.make("thread-invalid"), botId, groupId }),
      );
      assert.equal(invalidOwnership._tag, "Failure");

      const ownership = (yield* snapshots.getShellSnapshot()).threads.map((thread) => ({
        id: thread.id,
        botId: thread.botId ?? null,
        groupId: thread.groupId ?? null,
      }));
      assert.deepEqual(ownership, [
        { id: ThreadId.make("thread-bot"), botId, groupId: null },
        { id: ThreadId.make("thread-group"), botId: null, groupId },
        { id: ThreadId.make("thread-unowned"), botId: null, groupId: null },
      ]);

      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_remove(payload_json, '$.botId', '$.groupId')
        WHERE event_type = 'thread.created'
          AND stream_id = ${ThreadId.make("thread-unowned")}
      `;
      const historicalRows = yield* sql<{
        readonly botIdType: string | null;
        readonly groupIdType: string | null;
      }>`
        SELECT
          json_type(payload_json, '$.botId') AS "botIdType",
          json_type(payload_json, '$.groupId') AS "groupIdType"
        FROM orchestration_events
        WHERE event_type = 'thread.created'
          AND stream_id = ${ThreadId.make("thread-unowned")}
      `;
      assert.deepEqual(historicalRows, [{ botIdType: null, groupIdType: null }]);

      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state WHERE projector = 'projection.threads'`;
      yield* projectionPipeline.bootstrap;

      const rebuilt = yield* snapshots.getSnapshot();
      const rebuiltOwnership = rebuilt.threads
        .filter((thread) => thread.deletedAt === null)
        .map((thread) => ({
          id: thread.id,
          botId: thread.botId ?? null,
          groupId: thread.groupId ?? null,
        }));
      assert.deepEqual(rebuiltOwnership, ownership);
      const rebuiltHistoricalThread = rebuilt.threads.find(
        (thread) => thread.id === ThreadId.make("thread-unowned"),
      );
      assert.equal(rebuiltHistoricalThread?.botId, null);
      assert.equal(rebuiltHistoricalThread?.groupId, null);
    }),
  );

  it.effect("defaults omitted bot runtime modes by sandbox", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;

      for (const sandbox of [null, "local", "vercel"] as const) {
        yield* engine.dispatch({
          type: "bot.create",
          commandId: CommandId.make(`cmd-bot-default-${sandbox ?? "null"}`),
          botId: BotId.make(`bot-default-${sandbox ?? "null"}`),
          name: "Akeru",
          title: "Akeru",
          avatar: { kind: "dither", seed: "akeru" },
          engine: null,
          sandbox,
          usageCap: null,
          groupId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }

      const bots = (yield* snapshots.getShellSnapshot()).bots;
      assert.equal(
        bots.find((bot) => bot.id === BotId.make("bot-default-null"))?.runtimeMode,
        "approval-required",
      );
      assert.equal(
        bots.find((bot) => bot.id === BotId.make("bot-default-local"))?.runtimeMode,
        "approval-required",
      );
      assert.equal(
        bots.find((bot) => bot.id === BotId.make("bot-default-vercel"))?.runtimeMode,
        "full-access",
      );
    }),
  );
});
