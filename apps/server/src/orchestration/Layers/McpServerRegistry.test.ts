import { CommandId, McpServerId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const registryLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "akeru-mcp-server-registry-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

registryLayer("MCP server registry", (it) => {
  it.effect("creates a disabled MCP server when requested", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const mcpServerId = McpServerId.make("mcp-disabled-import");

      yield* engine.dispatch({
        type: "mcp-server.create",
        commandId: CommandId.make("cmd-mcp-disabled-import"),
        mcpServerId,
        name: "Disabled import",
        transport: "url",
        url: "https://mcp.example.com/import",
        enabled: false,
        createdAt: "2026-08-30T12:00:00.000Z",
      });

      const snapshot = yield* snapshots.getShellSnapshot();
      assert.equal(snapshot.mcpServers?.[0]?.enabled, false);
      yield* engine.dispatch({
        type: "mcp-server.delete",
        commandId: CommandId.make("cmd-mcp-disabled-import-delete"),
        mcpServerId,
      });
    }),
  );

  it.effect(
    "round-trips create, update, disable, enable, and delete through the shell projection",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const mcpServerId = McpServerId.make("mcp-filesystem");
        const createdAt = "2026-03-22T10:00:00.000Z";

        yield* engine.dispatch({
          type: "mcp-server.create",
          commandId: CommandId.make("cmd-mcp-create"),
          mcpServerId,
          name: "Filesystem",
          transport: "stdio",
          command: "bunx",
          args: ["@modelcontextprotocol/server-filesystem", "/workspace"],
          createdAt,
        });

        let snapshot = yield* snapshots.getShellSnapshot();
        assert.deepEqual(snapshot.mcpServers, [
          {
            id: mcpServerId,
            name: "Filesystem",
            transport: "stdio",
            command: "bunx",
            args: ["@modelcontextprotocol/server-filesystem", "/workspace"],
            enabled: true,
            createdAt,
            updatedAt: createdAt,
          },
        ]);

        yield* engine.dispatch({
          type: "mcp-server.update",
          commandId: CommandId.make("cmd-mcp-update"),
          mcpServerId,
          name: "Remote Filesystem",
          transport: "url",
          url: "https://mcp.example.com/filesystem",
        });

        snapshot = yield* snapshots.getShellSnapshot();
        assert.equal(snapshot.mcpServers?.[0]?.name, "Remote Filesystem");
        assert.equal(snapshot.mcpServers?.[0]?.transport, "url");
        if (snapshot.mcpServers?.[0]?.transport === "url") {
          assert.equal(snapshot.mcpServers[0].url, "https://mcp.example.com/filesystem");
        }
        assert.equal(snapshot.mcpServers?.[0]?.enabled, true);
        assert.equal(snapshot.mcpServers?.[0]?.createdAt, createdAt);

        yield* engine.dispatch({
          type: "mcp-server.disable",
          commandId: CommandId.make("cmd-mcp-disable"),
          mcpServerId,
        });
        snapshot = yield* snapshots.getShellSnapshot();
        assert.equal(snapshot.mcpServers?.[0]?.enabled, false);

        yield* engine.dispatch({
          type: "mcp-server.enable",
          commandId: CommandId.make("cmd-mcp-enable"),
          mcpServerId,
        });
        snapshot = yield* snapshots.getShellSnapshot();
        assert.equal(snapshot.mcpServers?.[0]?.enabled, true);

        yield* engine.dispatch({
          type: "mcp-server.delete",
          commandId: CommandId.make("cmd-mcp-delete"),
          mcpServerId,
        });
        snapshot = yield* snapshots.getShellSnapshot();
        assert.deepEqual(snapshot.mcpServers, []);
      }),
  );

  it.effect("rejects duplicate creates and commands against a missing id", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const mcpServerId = McpServerId.make("mcp-invariants");
      const createdAt = "2026-03-22T10:00:00.000Z";

      yield* engine.dispatch({
        type: "mcp-server.create",
        commandId: CommandId.make("cmd-inv-create"),
        mcpServerId,
        name: "Filesystem",
        transport: "stdio",
        command: "bunx",
        createdAt,
      });

      const duplicate = yield* engine
        .dispatch({
          type: "mcp-server.create",
          commandId: CommandId.make("cmd-inv-create-again"),
          mcpServerId,
          name: "Filesystem",
          transport: "stdio",
          command: "bunx",
          createdAt,
        })
        .pipe(Effect.flip);
      assert.match(String(duplicate), /already exists/);

      const missingId = McpServerId.make("mcp-missing");
      const missingCommands = [
        {
          type: "mcp-server.delete",
          commandId: CommandId.make("cmd-inv-del"),
          mcpServerId: missingId,
        },
        {
          type: "mcp-server.enable",
          commandId: CommandId.make("cmd-inv-en"),
          mcpServerId: missingId,
        },
        {
          type: "mcp-server.disable",
          commandId: CommandId.make("cmd-inv-dis"),
          mcpServerId: missingId,
        },
      ] as const;
      for (const command of missingCommands) {
        const failure = yield* engine.dispatch(command).pipe(Effect.flip);
        assert.match(String(failure), /does not exist/);
      }

      const missingUpdate = yield* engine
        .dispatch({
          type: "mcp-server.update",
          commandId: CommandId.make("cmd-inv-up"),
          mcpServerId: missingId,
          name: "Ghost",
          transport: "stdio",
          command: "bunx",
        })
        .pipe(Effect.flip);
      assert.match(String(missingUpdate), /does not exist/);

      // Delete frees the id for a fresh create.
      yield* engine.dispatch({
        type: "mcp-server.delete",
        commandId: CommandId.make("cmd-inv-del-real"),
        mcpServerId,
      });
      yield* engine.dispatch({
        type: "mcp-server.create",
        commandId: CommandId.make("cmd-inv-recreate"),
        mcpServerId,
        name: "Filesystem again",
        transport: "stdio",
        command: "bunx",
        createdAt,
      });
    }),
  );

  it.effect("keeps raw MCP enabled when Executor is disabled", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const createdAt = "2026-03-23T00:00:00.000Z";
      const executorId = McpServerId.make("builtin-executor");
      const rawId = McpServerId.make("raw-filesystem");

      yield* engine.dispatch({
        type: "mcp-server.create",
        commandId: CommandId.make("cmd-executor-create"),
        mcpServerId: executorId,
        name: "Executor",
        transport: "stdio",
        command: "executor.sh",
        createdAt,
      });
      yield* engine.dispatch({
        type: "mcp-server.disable",
        commandId: CommandId.make("cmd-executor-disable"),
        mcpServerId: executorId,
      });
      yield* engine.dispatch({
        type: "mcp-server.create",
        commandId: CommandId.make("cmd-raw-create"),
        mcpServerId: rawId,
        name: "Raw filesystem",
        transport: "stdio",
        command: "bunx",
        args: ["@modelcontextprotocol/server-filesystem", "."],
        createdAt,
      });

      const snapshot = yield* snapshots.getShellSnapshot();
      assert.equal(snapshot.mcpServers?.find((server) => server.id === executorId)?.enabled, false);
      assert.equal(snapshot.mcpServers?.find((server) => server.id === rawId)?.enabled, true);
    }),
  );
});
