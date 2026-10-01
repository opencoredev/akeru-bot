// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProviderDriverKind,
  ProjectId,
  type AkeruDelegationAccessGrant,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { AgentController } from "../Services/AgentController.ts";
import { type AgentControllerLiveOptions } from "./AgentController.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import { makeBridge, makeLayer, resolveCodex } from "./test-support/agentControllerLayers.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("keeps the memory tool for a delegated turn granted memory scopes", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-delegated-grant-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Read"],
      memoryScopes: ["bot"],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    };
    const runtime = {
      send: vi.fn(async () => {
        throw new Error("not used");
      }),
      sendToUser: vi.fn(async () => {
        throw new Error("not used");
      }),
      parentFinished: vi.fn(async () => undefined),
      accessForThread: () => access,
    };
    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
      runtime,
    );
    const memoryToolIds = () =>
      mastra.harnessOptions[0]?.toolRuntime
        .toolsForThread(String(codexThreadId))
        .map((tool) => tool.id)
        .filter((id) => id === "memory");

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
        memoryAccess: {
          tenantId: AkeruMemoryTenantId.make("local"),
          userId: AkeruMemoryUserId.make("owner"),
          threadId: codexThreadId,
          projectId: ProjectId.make("delegation-memory-grant"),
          workspaceRoot: process.cwd(),
          botId: BotId.make("delegated-bot"),
          respondingBotId: BotId.make("delegated-bot"),
          groupId: null,
          groupMemberBotIds: [],
        },
      });
      expect(memoryToolIds()).toEqual(["memory"]);
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Do the delegated task." });
      expect(mastra.session.sendMessage).toHaveBeenCalled();
      // Admission runs the turn without durable memory but keeps the granted tool.
      expect(memoryToolIds()).toEqual(["memory"]);
      expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
    }).pipe(
      Effect.provide(layer),
      Effect.orDie,
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("waits for observational memory shutdown before closing the controller scope", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const destroyStarted = Promise.withResolvers<void>();
    const destroyReleased = Promise.withResolvers<void>();
    const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = (options) =>
      Effect.acquireRelease(mastra.factory(options), () =>
        Effect.promise(async () => {
          destroyStarted.resolve();
          await destroyReleased.promise;
        }),
      );

    return Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      yield* Layer.buildWithScope(makeLayer(bridge.service, factory), scope);
      let scopeClosed = false;
      const closeScope = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() => Effect.sync(() => (scopeClosed = true))),
        Effect.forkScoped,
      );

      yield* Effect.promise(() => destroyStarted.promise);
      yield* Effect.yieldNow;
      expect(scopeClosed).toBe(false);

      destroyReleased.resolve();
      yield* Fiber.join(closeScope);
      expect(scopeClosed).toBe(true);
    });
  });
});
