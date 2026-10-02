import {
  BotId,
  CommandId,
  GroupId,
  McpServerId,
  ProjectId,
  RoutineId,
  ThreadId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { TestLayer } from "./test-support/BotPersistenceHarness.ts";

it.layer(TestLayer)("bot persistence", (it) => {
  it.effect("creates, edits, archives, restores, and rebuilds bots and groups", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const botId = BotId.make("bot-1");
      const specialistBotId = BotId.make("bot-2");
      const groupId = GroupId.make("group-1");
      const routineId = RoutineId.make("routine-1");
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
        type: "routine.draft",
        commandId: CommandId.make("cmd-routine-draft"),
        routineId,
        botId,
        targetThreadId: ThreadId.make("thread-routine"),
        projectId: ProjectId.make("project-1"),
        job: "Morning research",
        procedure: "Prepare the morning research brief.",
        schedule: { kind: "daily", time: "09:00" },
        timezone: "America/New_York",
        skillAssignmentIds: [],
        connectorDependencies: [],
        sandbox: "local",
        approvalPolicy: "approval-required",
        delegateToBotId: specialistBotId,
        createdAt,
      });
      yield* engine.dispatch({
        type: "routine.approve",
        commandId: CommandId.make("cmd-routine-approve"),
        routineId,
        procedureVersion: 1,
        createdAt,
      });
      yield* engine.dispatch({
        type: "routine.enable",
        commandId: CommandId.make("cmd-routine-enable"),
        routineId,
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
        engine: {
          provider: "codex",
          model: "gpt-5.6-sol",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        },
        sandbox: null,
        runtimeMode: "approval-required",
        usageCap: { unit: "tokens", limit: 50_000 },
        imageProvider: "chatgpt",
        personalityTone: 50,
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
      assert.equal(archived.routines?.[0]?.lifecycle, "paused");
      assert.equal(archived.routines?.[0]?.enabled, false);
      assert.equal(archived.routines?.[0]?.nextRunAt, null);
      assert.equal(archived.routines?.[0]?.delegateToBotId, specialistBotId);

      yield* engine.dispatch({
        type: "bot.restore",
        commandId: CommandId.make("cmd-bot-restore"),
        botId,
      });
      yield* engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-specialist-create"),
        botId: specialistBotId,
        name: "Verifier",
        title: "QA engineer",
        avatar: { kind: "dither", seed: "verifier" },
        engine: null,
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
        specialistBotIds: [specialistBotId],
        createdAt,
      });
      yield* engine.dispatch({
        type: "group.rename",
        commandId: CommandId.make("cmd-group-rename"),
        groupId,
        name: "Discovery",
      });

      const restored = yield* snapshots.getShellSnapshot();
      assert.equal(restored.routines?.[0]?.lifecycle, "paused");
      assert.equal(restored.routines?.[0]?.enabled, false);
      assert.equal(restored.bots.length, 2);
      const restoredBot = restored.bots.find((bot) => bot.id === botId);
      assert.deepEqual(restoredBot, {
        id: botId,
        name: "Pathfinder",
        title: "Staff researcher",
        label: "Discovery",
        description: "Investigates the highest-risk assumptions.",
        disabledMcpServerIds: [McpServerId.make("mcp-github")],
        avatar: { kind: "dither", seed: "pathfinder" },
        engine: {
          provider: "codex",
          model: "gpt-5.6-sol",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        },
        sandbox: null,
        runtimeMode: "approval-required",
        usageCap: { unit: "tokens", limit: 50_000 },
        imageProvider: "chatgpt",
        personalityTone: 50,
        voiceEnabled: true,
        channelBindings: [],
        groupId: null,
        archivedAt: null,
        createdAt,
        updatedAt: restoredBot!.updatedAt,
      });
      assert.deepEqual(restored.groups, [
        {
          id: groupId,
          name: "Discovery",
          bossBotId: botId,
          members: [
            { kind: "bot", botId, role: "boss" },
            { kind: "bot", botId: specialistBotId, role: "specialist" },
          ],
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
      assert.equal(rebuilt.bots.length, 2);
      const rebuiltBot = rebuilt.bots.find((bot) => bot.id === botId);
      assert.equal(rebuiltBot?.name, "Pathfinder");
      assert.equal(rebuiltBot?.voiceEnabled, true);
      assert.equal(rebuiltBot?.imageProvider, "chatgpt");
      assert.deepEqual(rebuiltBot?.engine, {
        provider: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      });
      assert.equal(rebuiltBot?.groupId, null);
      assert.equal(rebuiltBot?.archivedAt, null);
      assert.deepEqual(rebuilt.groups, []);
    }),
  );

  it.effect("persists a nullable per-bot image provider selection", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const botId = BotId.make("bot-image-provider");
      const createdAt = "2026-01-02T00:00:00.000Z";

      // No selection on create decodes as null — "use the global default" —
      // and is independent of the chat engine (a Claude bot may use ChatGPT).
      yield* engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-img-bot-create"),
        botId,
        name: "Painter",
        title: "Illustrator",
        avatar: { kind: "dither", seed: "painter" },
        engine: { provider: "claudeAgent", model: "claude-opus-5.5" },
        sandbox: "local",
        usageCap: null,
        groupId: null,
        createdAt,
      });
      let bot = (yield* snapshots.getShellSnapshot()).bots.find((entry) => entry.id === botId);
      assert.equal(bot?.imageProvider, null);

      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-img-bot-set"),
        botId,
        imageProvider: "grok",
      });
      bot = (yield* snapshots.getShellSnapshot()).bots.find((entry) => entry.id === botId);
      assert.equal(bot?.imageProvider, "grok");

      // Clearing back to null restores "use the global default".
      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-img-bot-clear"),
        botId,
        imageProvider: null,
      });
      bot = (yield* snapshots.getShellSnapshot()).bots.find((entry) => entry.id === botId);
      assert.equal(bot?.imageProvider, null);
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
        "auto",
      );
      assert.equal(
        bots.find((bot) => bot.id === BotId.make("bot-default-local"))?.runtimeMode,
        "auto",
      );
      assert.equal(
        bots.find((bot) => bot.id === BotId.make("bot-default-vercel"))?.runtimeMode,
        "full-access",
      );
    }),
  );

  it.effect("maps historical Akeru Cloud bots to local during projection rebuilds", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const botId = BotId.make("bot-legacy-akeru-cloud");

      yield* engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-bot-legacy-akeru-cloud"),
        botId,
        name: "Legacy",
        title: "Legacy",
        avatar: { kind: "dither", seed: "legacy" },
        engine: null,
        sandbox: "local",
        usageCap: null,
        groupId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.sandbox', 'akeru-cloud')
        WHERE event_type = 'bot.created' AND stream_id = ${botId}
      `;
      yield* sql`DELETE FROM projection_bots`;
      yield* sql`DELETE FROM projection_state WHERE projector = 'projection.bots'`;
      yield* projectionPipeline.bootstrap;

      const bot = (yield* snapshots.getShellSnapshot()).bots.find((item) => item.id === botId);
      assert.equal(bot?.sandbox, null);
    }),
  );
});
