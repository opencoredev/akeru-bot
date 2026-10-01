import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProviderDriverKind,
  ProjectId,
  type AkeruMemoryRevision,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexThreadId,
  claudeThreadId,
  codexInstanceId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  MemoryToolCallError,
  privatePolicyRevisions,
  entityMemorySection,
  makeMemoryOnlyCredentialOptions,
} from "./test-support/agentControllerMemory.ts";
import {
  makeProviderSession,
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  it.effect("reads entity memory for the access of a reused Mastra session", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-entity-reuse-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-entity-reuse");

    const accessFor = (project: string) =>
      ({
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId: ProjectId.make(project),
        workspaceRoot: "/workspace/entity-reuse",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      }) as const;

    const listedProjects: Array<string | null> = [];

    const listCurrent = vi.fn((input: { readonly access: { readonly projectId: unknown } }) => {
      listedProjects.push(String(input.access.projectId));

      return Effect.succeed([]);
    });

    const recordDerivedCopies = vi.fn(() => Effect.void);

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);

        const start = (project: string) =>
          controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            memoryAccess: accessFor(project),
          });

        yield* start("project-before");
        yield* start("project-after");
        listedProjects.length = 0;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use current memory." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        mastra.finishSend();
        yield* Effect.yieldNow;
        expect(listedProjects).toContain("project-after");
        expect(listedProjects).not.toContain("project-before");
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore, entityMemoryRepository: { listCurrent, recordDerivedCopies } as never },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("keeps entity memory out of a new legacy session while Memory is off", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const botId = BotId.make("bot-entity-memory-off");

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-entity-memory-off"),
      workspaceRoot: "/workspace/entity-memory-off",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;

    const listCurrent = vi.fn(() => Effect.succeed([]));
    // Only the entity packet records derived copies; the legacy migration read also lists facts.
    const recordDerivedCopies = vi.fn(() => Effect.void);

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ memory: { enabled: false } });
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });
        expect(recordDerivedCopies).not.toHaveBeenCalled();
        expect(bridge.startSession.mock.calls[0]?.[1].persistentMemoryContext).toBeUndefined();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      {
        ...makeMemoryOnlyCredentialOptions(),
        entityMemoryRepository: { listCurrent, recordDerivedCopies } as never,
      },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("reads entity memory from the current project after reusing a legacy session", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const botId = BotId.make("bot-entity-memory-moved");

    const accessFor = (project: string) =>
      ({
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make(project),
        workspaceRoot: "/workspace/entity-memory-moved",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      }) as const;

    const listCurrent = vi.fn((_input: { access: { projectId: ProjectId } }) => Effect.succeed([]));

    const startSession = (project: string) =>
      Effect.gen(function* () {
        const controller = yield* AgentController;

        return yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: accessFor(project),
        });
      });

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* startSession("project-before-move");
        yield* startSession("project-after-move");
        expect(bridge.startSession).toHaveBeenCalledTimes(1);
        listCurrent.mockClear();

        yield* controller.sendTurn({ threadId: claudeThreadId, input: "After the move." });
        expect(listCurrent.mock.calls.map(([input]) => String(input.access.projectId))).toEqual([
          "project-after-move",
        ]);
      }),
      {
        ...bridge.service,
        listSessions: () => Effect.succeed([makeProviderSession(claudeThreadId, "opencode")]),
      },
      mastra.factory,
      undefined,
      undefined,
      undefined,
      {
        ...makeMemoryOnlyCredentialOptions(),
        entityMemoryRepository: { listCurrent, recordDerivedCopies: () => Effect.void } as never,
      },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect(
    "withholds bot-private entity facts on the legacy path while Private bot memory is off",
    () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();
      const botId = BotId.make("bot-entity-private-legacy");
      const projectId = ProjectId.make("project-entity-private-legacy");

      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId,
        workspaceRoot: "/workspace/entity-private-legacy",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;

      const revisions = privatePolicyRevisions(botId, projectId);
      const listCurrent = vi.fn(() => Effect.succeed(revisions));

      const recordDerivedCopies = vi.fn(
        (_input: { readonly revisions: ReadonlyArray<AkeruMemoryRevision> }) => Effect.void,
      );

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({ memory: { privateBotMemory: false } });
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            memoryAccess: access,
          });

          const startPacket = entityMemorySection(
            bridge.startSession.mock.calls[0]?.[1].persistentMemoryContext,
          );

          expect(startPacket).toContain("Shared project entity fact.");
          expect(startPacket).not.toContain("Bot-private entity fact.");
          expect(startPacket).not.toContain("Bot-about-you entity fact.");

          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private off." });

          const offPacket = entityMemorySection(
            bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext,
          );

          expect(offPacket).toContain("Shared project entity fact.");
          expect(offPacket).not.toContain("Bot-private entity fact.");
          expect(offPacket).not.toContain("Bot-about-you entity fact.");

          // Derived copies track only what reached the provider.
          for (const [input] of recordDerivedCopies.mock.calls) {
            expect(input.revisions.map((revision) => revision.partition.scope)).toEqual([
              "project",
            ]);
          }

          yield* settings.updateSettings({ memory: { privateBotMemory: true } });
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private on." });

          const onPacket = entityMemorySection(
            bridge.sendTurn.mock.calls[1]?.[0].persistentMemoryContext,
          );

          expect(onPacket).toContain("Bot-private entity fact.");
          expect(onPacket).toContain("Bot-about-you entity fact.");
        }),
        {
          ...bridge.service,
          listSessions: () => Effect.succeed([makeProviderSession(claudeThreadId, "opencode")]),
        },
        mastra.factory,
        undefined,
        undefined,
        undefined,
        {
          ...makeMemoryOnlyCredentialOptions(),
          entityMemoryRepository: { listCurrent, recordDerivedCopies } as never,
        },
      );
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect(
    "withholds bot-private entity facts on the Mastra path while Private bot memory is off",
    () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-entity-private-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-entity-private-mastra");
      const projectId = ProjectId.make("project-entity-private-mastra");

      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId,
        workspaceRoot: "/workspace/entity-private-mastra",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;

      const revisions = privatePolicyRevisions(botId, projectId);
      const listCurrent = vi.fn(() => Effect.succeed(revisions));
      const recordDerivedCopies = vi.fn(() => Effect.void);

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
          yield* resolveCodex(controller);
          yield* controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            memoryAccess: access,
          });

          const awaitNextCompletedTurn = () =>
            controller.streamEvents.pipe(
              Stream.filter((event) => event.type === "turn.completed"),
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );

          yield* settings.updateSettings({ memory: { privateBotMemory: false } });
          const offTurn = yield* awaitNextCompletedTurn();
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Private off." });
          yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
          const offPacket = entityMemorySection(mastra.session.state.get().persistentMemoryContext);
          expect(offPacket).toContain("Shared project entity fact.");
          expect(offPacket).not.toContain("Bot-private entity fact.");
          expect(offPacket).not.toContain("Bot-about-you entity fact.");
          mastra.finishSend();
          yield* Fiber.join(offTurn);

          yield* settings.updateSettings({ memory: { privateBotMemory: true } });
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Private on." });
          yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
          const onPacket = entityMemorySection(mastra.session.state.get().persistentMemoryContext);
          expect(onPacket).toContain("Bot-private entity fact.");
          expect(onPacket).toContain("Bot-about-you entity fact.");
          mastra.finishSend();
          yield* Effect.yieldNow;
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore, entityMemoryRepository: { listCurrent, recordDerivedCopies } as never },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("applies the Private bot memory toggle mid-session on the legacy path", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-private-toggle-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-private-toggle-legacy");

    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-private-toggle-legacy"),
      workspaceRoot: "/workspace/private-toggle-legacy",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;

    const credentials = makeMemoryOnlyCredentialOptions();

    const callMemoryTool = (input: {
      target: string;
      operations: Array<unknown>;
      share?: { fact: string; scope: string };
    }) =>
      Effect.tryPromise({
        try: () => {
          const handler = McpMemoryToolSession.readMcpMemoryToolSession(claudeThreadId);
          assert.isDefined(handler);

          return handler({
            threadId: String(claudeThreadId),
            toolId: "memory",
            toolCallId: `mcp-memory-${NodeCrypto.randomUUID()}`,
            input,
            approvalMode: "require-grant",
          });
        },
        catch: (cause) =>
          new MemoryToolCallError({
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
      });

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...access,
            target: "memory",
            operations: [{ action: "add", content: "Bot-private note." }],
          }),
        );
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });

        const privateRead = yield* callMemoryTool({ target: "memory", operations: [] });
        expect(privateRead).toMatchObject({ success: true, content: "Bot-private note." });

        // Turning Private bot memory off mid-session removes MEMORY.md from the
        // prompt and denies the bot-private target on the existing handler.
        yield* settings.updateSettings({ memory: { privateBotMemory: false } });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private off turn." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
        const context = bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext ?? "";
        expect(context).not.toContain("<bot-memory>");
        expect(context).not.toContain("Bot-private note.");

        const denied = yield* callMemoryTool({ target: "memory", operations: [] }).pipe(
          Effect.result,
        );

        assert.equal(denied._tag, "Failure");
        expect(Predicate.isTagged(denied, "Failure") ? denied.failure.cause.message : "").toContain(
          "Private bot memory is disabled.",
        );

        // A share-only call names the memory target but never touches MEMORY.md,
        // so it passes the Private bot memory gate and reaches the share path
        // (this fixture has no approvals service).
        const shareOnly = yield* callMemoryTool({
          target: "memory",
          operations: [],
          share: { fact: "The project uses pnpm.", scope: "project" },
        }).pipe(Effect.result);

        expect(
          Predicate.isTagged(shareOnly, "Failure") ? shareOnly.failure.cause.message : "",
        ).toBe("Shared memory is not available in this chat.");
        const userStillAllowed = yield* callMemoryTool({ target: "user", operations: [] });
        expect(userStillAllowed).toMatchObject({ success: true });

        yield* settings.updateSettings({ memory: { privateBotMemory: true } });
        const restoredRead = yield* callMemoryTool({ target: "memory", operations: [] });
        expect(restoredRead).toMatchObject({ success: true, content: "Bot-private note." });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private on again." });
        expect(bridge.sendTurn.mock.calls[1]?.[0].persistentMemoryContext).toContain(
          "Bot-private note.",
        );
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore, ...credentials },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          McpMemoryToolSession.clearMcpMemoryToolSession(claudeThreadId);
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
