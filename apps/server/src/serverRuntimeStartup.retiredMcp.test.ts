import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, CommandId, McpServerId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "./config.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { sqlitePersistenceLayer } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const CREATED_AT = "2026-10-01T09:00:00.000Z";

const [RETIRED_ID] = [...ServerRuntimeStartup.RETIRED_MCP_SERVER_IDS];

const HOSTED_ID = McpServerId.make("hosted-docs");

const LOCAL_ID = McpServerId.make("local-files");

const MIRA = BotId.make("bot-mira");

const SOL = BotId.make("bot-sol");

const makeLayer = (dbPath: string) =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(sqlitePersistenceLayer(dbPath)),
  );

// The state an upgraded install had: the retired connector installed next to a hosted and a
// local custom MCP server, with one bot opted out of the retired connector and a custom one.
const seed = (retiredId: McpServerId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    let commandIndex = 0;
    const commandId = () => CommandId.make(`seed-${commandIndex++}`);

    yield* engine.dispatch({
      type: "mcp-server.create",
      commandId: commandId(),
      mcpServerId: retiredId,
      name: "Retired connector",
      transport: "url",
      url: "https://retired.example/mcp",
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "mcp-server.create",
      commandId: commandId(),
      mcpServerId: HOSTED_ID,
      name: "Hosted docs",
      transport: "url",
      url: "https://docs.example.com/mcp",
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "mcp-server.create",
      commandId: commandId(),
      mcpServerId: LOCAL_ID,
      name: "Local files",
      transport: "stdio",
      command: "bunx",
      args: ["@modelcontextprotocol/server-filesystem", "."],
      createdAt: CREATED_AT,
    });
    yield* engine.dispatch({
      type: "mcp-server.disable",
      commandId: commandId(),
      mcpServerId: LOCAL_ID,
    });

    for (const [botId, name, disabledMcpServerIds] of [
      [MIRA, "Mira", [retiredId, HOSTED_ID]],
      [SOL, "Sol", []],
    ] as const) {
      yield* engine.dispatch({
        type: "bot.create",
        commandId: commandId(),
        botId,
        name,
        title: "Agent",
        avatar: { kind: "dither", seed: botId },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        groupId: null,
        disabledMcpServerIds: [...disabledMcpServerIds],
        createdAt: CREATED_AT,
      });
    }
  });

const eventCount = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;

  return Array.from(yield* Stream.runCollect(engine.readEvents(0, 10_000))).length;
});

it.effect("removes a retired connector and its bot references once, keeping custom MCP", () =>
  Effect.gen(function* () {
    if (RETIRED_ID === undefined) return assert.fail("No retired MCP server id is declared.");
    const { dbPath } = yield* ServerConfig;

    yield* seed(RETIRED_ID).pipe(Effect.provide(makeLayer(dbPath)));

    // First startup after the upgrade.
    const first = yield* Effect.gen(function* () {
      const before = yield* eventCount;
      yield* ServerRuntimeStartup.reconcileRetiredMcpServers;
      const readModel = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();

      return { readModel, written: (yield* eventCount) - before };
    }).pipe(Effect.provide(makeLayer(dbPath)));

    // One bot sweep and one delete.
    assert.equal(first.written, 2);
    assert.deepStrictEqual(
      (first.readModel.mcpServers ?? []).map((server) => [server.id, server.enabled]),
      [
        [HOSTED_ID, true],
        [LOCAL_ID, false],
      ],
    );
    const bots = new Map(first.readModel.bots.map((bot) => [bot.id, bot.disabledMcpServerIds]));
    assert.deepStrictEqual(bots.get(MIRA), [HOSTED_ID]);
    assert.deepStrictEqual(bots.get(SOL), []);

    // A second startup changes nothing, and custom servers still remove normally.
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const before = yield* eventCount;
      yield* ServerRuntimeStartup.reconcileRetiredMcpServers;
      assert.equal((yield* eventCount) - before, 0);

      yield* engine.dispatch({
        type: "mcp-server.delete",
        commandId: CommandId.make("remove-local"),
        mcpServerId: LOCAL_ID,
      });
      const { mcpServers } = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
      assert.deepStrictEqual(
        (mcpServers ?? []).map((server) => server.id),
        [HOSTED_ID],
      );
    }).pipe(Effect.provide(makeLayer(dbPath)));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-retired-mcp-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("keeps a bot's opt-out while the retired connector cannot be removed", () =>
  Effect.gen(function* () {
    if (RETIRED_ID === undefined) return assert.fail("No retired MCP server id is declared.");
    const { dbPath } = yield* ServerConfig;

    yield* seed(RETIRED_ID).pipe(Effect.provide(makeLayer(dbPath)));

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;

      // Every delete fails, so the retired connector stays registered.
      yield* ServerRuntimeStartup.reconcileRetiredMcpServers.pipe(
        Effect.provideService(OrchestrationEngineService, {
          ...engine,
          dispatch: (command) =>
            command.type === "mcp-server.delete"
              ? Effect.die(new Error("delete failed"))
              : engine.dispatch(command),
        }),
      );
      const blocked = yield* query.getCommandReadModel();
      assert.isTrue((blocked.mcpServers ?? []).some((server) => server.id === RETIRED_ID));
      assert.deepStrictEqual(blocked.bots.find((bot) => bot.id === MIRA)?.disabledMcpServerIds, [
        RETIRED_ID,
        HOSTED_ID,
      ]);

      // The next startup that can remove it also sweeps the opt-out.
      yield* ServerRuntimeStartup.reconcileRetiredMcpServers;
      const cleaned = yield* query.getCommandReadModel();
      assert.isFalse((cleaned.mcpServers ?? []).some((server) => server.id === RETIRED_ID));
      assert.deepStrictEqual(cleaned.bots.find((bot) => bot.id === MIRA)?.disabledMcpServerIds, [
        HOSTED_ID,
      ]);
    }).pipe(Effect.provide(makeLayer(dbPath)));
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-retired-mcp-test-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
