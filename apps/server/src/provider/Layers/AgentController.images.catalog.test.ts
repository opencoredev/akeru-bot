import { emptyProviderSnapshot, providerBotFixture } from "./test-support/projectionFixtures.ts";
import * as Predicate from "effect/Predicate";
// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  McpServerId,
  ProviderDriverKind,
  ThreadId,
  type McpServer,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentController } from "../Services/AgentController.ts";
import type { AkeruRuntimeToolId } from "../AkeruToolRuntime.ts";
import { ImageGenerationRuntime } from "../../image-generation/ImageGenerationRuntime.ts";
import {
  GROK_IMAGE_CAPABILITIES,
  makeChatGptImageAdapter,
  type ImageProviderAdapter,
} from "../../image-generation/adapters.ts";
import { pngBytes } from "../../image-generation/testImages.ts";
import { makeTestSubscriptionAuthService } from "../../subscription-auth/testUtils/subscriptionAuthService.ts";
import {
  codexThreadId,
  claudeThreadId,
  codexInstanceId,
  openCodeInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { makeMemoryOnlyCredentialOptions } from "./test-support/agentControllerMemory.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import { makeImageRuntimeTestLayer } from "./test-support/agentControllerImages.ts";

describe("AgentControllerLive", () => {
  it.effect("exposes and runs the web, image, and MCP catalog tools in a live session", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-catalog-tools-"));
    const page = NodeHttp.createServer((_request, response) => response.end("catalog page"));

    const imageResult = {
      status: "needs-consent",
      provider: "grok",
      message: "ask first",
      attempts: [],
    };

    const generateImage = vi.fn(<Input>(_threadId: ThreadId, _input: Input) =>
      Effect.succeed(imageResult),
    );

    const dispatched: OrchestrationCommand[] = [];

    const docsServer: McpServer = {
      id: McpServerId.make("docs"),
      name: "Docs",
      transport: "url",
      url: "https://mcp.example.com/docs",
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      instructions: "Search the docs first.",
    };

    const localServer: McpServer = {
      id: McpServerId.make("local"),
      name: "Local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "local-mcp"],
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };

    // Ada uses both servers, Grace turned docs off, and archived Linus turned local off.
    const snapshotBots = [
      { id: BotId.make("ada"), name: "Ada", archivedAt: null, disabledMcpServerIds: [] },
      {
        id: BotId.make("grace"),
        name: "Grace",
        archivedAt: null,
        disabledMcpServerIds: [McpServerId.make("docs"), McpServerId.make("other")],
      },
      {
        id: BotId.make("linus"),
        name: "Linus",
        archivedAt: "2026-09-02T00:00:00.000Z",
        disabledMcpServerIds: [McpServerId.make("local")],
      },
    ];

    return provideController(
      Effect.gen(function* () {
        yield* Effect.promise(
          () => new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve)),
        );
        const port = (page.address() as NodeNet.AddressInfo).port;
        const controller = yield* AgentController;
        yield* controller.configurePluginRuntime!({
          readSnapshot: async () =>
            ({
              ...emptyProviderSnapshot(),
              bots: snapshotBots.map(providerBotFixture),
              mcpServers: [docsServer, localServer],
            }) satisfies OrchestrationReadModel,
          dispatch: async (command) => {
            dispatched.push(command);

            // Grace saves another disabled server while docs is being removed;
            // the sweep must keep that newer choice.
            if (command.type === "mcp-server.delete" && command.mcpServerId === "docs") {
              snapshotBots[1]!.disabledMcpServerIds = [
                ...snapshotBots[1]!.disabledMcpServerIds,
                McpServerId.make("newer"),
              ];
            }

            return { sequence: dispatched.length };
          },
        });
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).toEqual(
          expect.arrayContaining([
            "WebSearch",
            "WebFetch",
            "GenerateImage",
            "AddMcpServer",
            "UninstallMcpServer",
            "RemoveMcpAccount",
            "RenameMcpAccount",
            "SetMcpInstructions",
          ]),
        );

        const run = (toolId: AkeruRuntimeToolId, toolCallId: string, input: Schema.Json) =>
          Effect.promise(() => {
            const execution = { threadId: String(codexThreadId), toolId, toolCallId, input };
            runtime.grantApproval(execution);

            return runtime.execute({ ...execution, approvalMode: "require-grant" });
          });

        expect(yield* run("WebSearch", "search", { query: "akeru bot" })).toMatchObject({
          status: "unavailable",
          query: "akeru bot",
          results: [],
        });
        expect(
          yield* run("WebFetch", "fetch", { url: `http://catalog.example:${port}/` }),
        ).toMatchObject({ status: 200, text: "catalog page", truncated: false });

        const imageRequest = { operation: "generate", prompt: "a fox" } as const;
        expect(yield* run("GenerateImage", "image", imageRequest)).toEqual(imageResult);
        expect(generateImage).toHaveBeenCalledExactlyOnceWith(codexThreadId, imageRequest);

        expect(
          yield* run("SetMcpInstructions", "instructions", {
            serverId: "docs",
            instructions: " Search the docs first. ",
          }),
        ).toMatchObject({ serverId: "docs", instructions: "Search the docs first." });
        expect(dispatched).toEqual([
          expect.objectContaining({
            type: "mcp-server.instructions.set",
            mcpServerId: "docs",
            instructions: " Search the docs first. ",
          }),
        ]);

        const takeDispatched = () => dispatched.splice(0);
        takeDispatched();
        const anyCommandId = expect.stringMatching(/^catalog:/);

        expect(
          yield* run("AddMcpServer", "add-stdio", {
            serverId: "tools",
            name: "Tools",
            transport: "stdio",
            command: "uvx",
            args: ["tools-mcp", "--verbose"],
          }),
        ).toEqual({ serverId: "tools", added: true });
        expect(takeDispatched()).toEqual([
          {
            type: "mcp-server.create",
            commandId: anyCommandId,
            mcpServerId: "tools",
            name: "Tools",
            transport: "stdio",
            command: "uvx",
            args: ["tools-mcp", "--verbose"],
            enabled: true,
            createdAt: expect.any(String),
          },
        ]);

        expect(
          yield* run("AddMcpServer", "add-url", {
            serverId: "search",
            name: "Search",
            transport: "url",
            url: "https://mcp.example.com/search?region=eu",
          }),
        ).toEqual({ serverId: "search", added: true });
        expect(takeDispatched()).toEqual([
          {
            type: "mcp-server.create",
            commandId: anyCommandId,
            mcpServerId: "search",
            name: "Search",
            transport: "url",
            url: "https://mcp.example.com/search?region=eu",
            enabled: true,
            createdAt: expect.any(String),
          },
        ]);

        // A stdio add without a command fails schema validation before any dispatch.
        const invalidAdd = yield* Effect.promise(() =>
          runtime
            .execute({
              threadId: String(codexThreadId),
              toolId: "AddMcpServer",
              toolCallId: "add-invalid",
              input: { serverId: "broken", name: "Broken", transport: "stdio" },
              approvalMode: "require-grant",
            })
            .then(
              () => undefined,
              (cause: unknown) => cause,
            ),
        );

        expect(Schema.isSchemaError(invalidAdd)).toBe(true);
        expect(takeDispatched()).toEqual([]);

        expect(
          yield* run("RenameMcpAccount", "rename-url", { serverId: "docs", name: "Docs (EU)" }),
        ).toEqual({ serverId: "docs", name: "Docs (EU)", renamed: true });
        expect(
          yield* run("RenameMcpAccount", "rename-stdio", { serverId: "local", name: "Local 2" }),
        ).toEqual({ serverId: "local", name: "Local 2", renamed: true });
        expect(takeDispatched()).toEqual([
          {
            type: "mcp-server.update",
            commandId: anyCommandId,
            mcpServerId: "docs",
            name: "Docs (EU)",
            transport: "url",
            url: "https://mcp.example.com/docs",
          },
          {
            type: "mcp-server.update",
            commandId: anyCommandId,
            mcpServerId: "local",
            name: "Local 2",
            transport: "stdio",
            command: "npx",
            args: ["-y", "local-mcp"],
          },
        ]);

        expect(yield* run("UninstallMcpServer", "uninstall", { serverId: "docs" })).toEqual({
          serverId: "docs",
          removed: true,
          dependentBots: [{ id: "ada", name: "Ada" }],
          clearedDisabledFor: [{ id: "grace", name: "Grace" }],
        });
        expect(takeDispatched()).toEqual([
          { type: "mcp-server.delete", commandId: anyCommandId, mcpServerId: "docs" },
          {
            type: "bot.update",
            commandId: anyCommandId,
            botId: "grace",
            disabledMcpServerIds: ["other", "newer"],
          },
        ]);

        expect(yield* run("RemoveMcpAccount", "remove", { serverId: "local" })).toEqual({
          serverId: "local",
          removed: true,
          dependentBots: [
            { id: "ada", name: "Ada" },
            { id: "grace", name: "Grace" },
          ],
          clearedDisabledFor: [{ id: "linus", name: "Linus" }],
        });
        expect(takeDispatched()).toEqual([
          { type: "mcp-server.delete", commandId: anyCommandId, mcpServerId: "local" },
          { type: "bot.update", commandId: anyCommandId, botId: "linus", disabledMcpServerIds: [] },
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => new Promise<void>((resolve) => page.close(() => resolve()))),
        ),
      ),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      undefined,
      {
        webFetch: {
          lookup: async () => [{ address: "127.0.0.1", family: 4 }],
          allowAddress: (address) => address === "127.0.0.1",
        },
        generateImage,
      },
      { imageGeneration: { chatgptEnabled: true } },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("routes the Mastra GenerateImage catalog tool through the image runtime", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-catalog-image-"));
    const grokCalls: Array<unknown> = [];
    let grokGate: (() => void) | undefined;

    const grokAdapter: ImageProviderAdapter = {
      provider: "grok",
      capabilities: GROK_IMAGE_CAPABILITIES,
      run: (request, signal) => {
        grokCalls.push(request);

        if (!grokGate) {
          return Promise.resolve({
            images: [pngBytes(32, 32)],
            model: "grok-image-model",
          });
        }

        return new Promise((resolve, reject) => {
          grokGate!();
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("aborted"));
          });
        });
      },
    };

    const {
      layer: runtimeLayer,
      dispatched,
      imageUsage,
    } = makeImageRuntimeTestLayer({
      baseDir,
      adapters: { chatgpt: grokAdapter, grok: grokAdapter },
      connected: ["xai"],
      settings: { grokEnabled: true },
      botProvider: "grok",
    });

    return provideController(
      Effect.gen(function* () {
        const imageRuntime = yield* ImageGenerationRuntime;
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).toContain(
          "GenerateImage",
        );
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "generate_image",
        );
        const input = { operation: "generate", prompt: "a fox" } as const;

        const execution = {
          threadId: String(codexThreadId),
          toolId: "GenerateImage" as const,
          toolCallId: "image-catalog",
          input,
        };

        runtime.grantApproval(execution);

        const result = yield* Effect.promise(() =>
          Promise.resolve(runtime.execute({ ...execution, approvalMode: "require-grant" })),
        );

        expect(result).toMatchObject({ status: "completed", provider: "grok" });
        expect(grokCalls).toHaveLength(1);

        const delta = dispatched.find(
          (command) => command.type === "thread.message.assistant.delta",
        ) as { attachments?: unknown[] } | undefined;

        expect(delta?.attachments).toHaveLength(1);
        expect(
          dispatched.filter((command) => command.type === "thread.message.assistant.complete"),
        ).toHaveLength(1);
        expect(imageUsage).toHaveLength(1);

        // Interrupting the Mastra turn cancels an in-flight image request.
        const pending = yield* Effect.forkChild(imageRuntime.generate(codexThreadId, input));
        const gate = Deferred.makeUnsafe<string>();
        grokGate = () => Deferred.doneUnsafe(gate, Effect.succeed("release"));
        yield* Deferred.await(gate);
        expect(grokCalls).toHaveLength(2);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        const cancelledExit = yield* Fiber.await(pending);
        expect(
          Predicate.isTagged(cancelledExit, "Success") ? cancelledExit.value : cancelledExit,
        ).toMatchObject({ status: "failed", kind: "cancelled" });
      }).pipe(Effect.provide(runtimeLayer)),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      undefined,
      undefined,
      { imageGeneration: { grokEnabled: true } },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("falls back to the next image provider when a Mastra image attempt times out", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-catalog-image-timeout-"),
    );

    const requestTimeout = Duration.millis(50);
    const chatgptStarted = Deferred.makeUnsafe<void>();
    let chatgptAborted = false;
    const grokCalls: Array<unknown> = [];

    const chatgptAdapter: ImageProviderAdapter = {
      provider: "chatgpt",
      capabilities: GROK_IMAGE_CAPABILITIES,
      run: (_request, signal) =>
        new Promise((_resolve, reject) => {
          Deferred.doneUnsafe(chatgptStarted, Effect.void);
          signal.addEventListener("abort", () => {
            chatgptAborted = true;
            reject(signal.reason ?? new Error("aborted"));
          });
        }),
    };

    const grokAdapter: ImageProviderAdapter = {
      provider: "grok",
      capabilities: GROK_IMAGE_CAPABILITIES,
      run: (request) => {
        grokCalls.push(request);

        return Promise.resolve({ images: [pngBytes(32, 32)], model: "grok-image-model" });
      },
    };

    const settings = { chatgptEnabled: true, grokEnabled: true };

    const { layer: runtimeLayer, dispatched } = makeImageRuntimeTestLayer({
      baseDir,
      adapters: { chatgpt: chatgptAdapter, grok: grokAdapter },
      connected: ["openai-codex", "xai"],
      settings,
      botProvider: "chatgpt",
      requestTimeout,
    });

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);

        const execution = {
          threadId: String(codexThreadId),
          toolId: "GenerateImage" as const,
          toolCallId: "image-catalog-timeout",
          input: { operation: "generate", prompt: "a fox" },
        };

        runtime.grantApproval(execution);

        const pending = yield* Effect.forkChild(
          Effect.promise(() =>
            Promise.resolve(runtime.execute({ ...execution, approvalMode: "require-grant" })),
          ),
        );

        yield* Deferred.await(chatgptStarted);
        yield* TestClock.adjust(requestTimeout);
        const result = yield* Fiber.join(pending);

        expect(chatgptAborted).toBe(true);
        expect(grokCalls).toHaveLength(1);
        expect(result).toMatchObject({
          status: "completed",
          provider: "grok",
          attempts: [
            { provider: "chatgpt", outcome: "timeout" },
            { provider: "grok", outcome: "completed" },
          ],
        });
        expect(
          dispatched.filter((command) => command.type === "thread.message.assistant.complete"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(runtimeLayer)),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      undefined,
      undefined,
      { imageGeneration: settings },
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("refuses an api-key openai-codex credential for ChatGPT images", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-image-apikey-"));
    const secretsDir = NodePath.join(baseDir, "userdata", "secrets");
    NodeFS.mkdirSync(secretsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(secretsDir, "subscription-auth.json"),
      JSON.stringify({ "openai-codex": { type: "api-key", access: "openai-key" } }),
    );

    return Effect.gen(function* () {
      const subscriptionAuth = yield* Effect.promise(() =>
        makeTestSubscriptionAuthService(NodePath.join(secretsDir, "subscription-auth.json")),
      );

      const adapter = makeChatGptImageAdapter({ subscriptionAuth });

      const run = adapter.run(
        {
          operation: "generate",
          prompt: "a fox",
          inputImages: [],
          aspectRatio: undefined,
          quality: "standard",
          count: 1,
        },
        AbortSignal.timeout(5_000),
      );

      const failure = yield* Effect.promise(() =>
        run.then(
          () => {
            throw new Error("expected failure");
          },
          (cause: unknown) => cause,
        ),
      );

      expect(String((failure as Error).message)).toContain("ChatGPT account sign-in");
    }).pipe(Effect.provide(NodeServices.layer));
  });
});

describe("AgentControllerLive", () => {
  it.effect("grants legacy sessions the image tool when an image provider is enabled", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const credentials = makeMemoryOnlyCredentialOptions();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ imageGeneration: { chatgptEnabled: true } });
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
        });
        expect(credentials.requests.at(-1)?.capabilities?.has("image")).toBe(true);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      credentials,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect(
    "hides the image tool on a reused Mastra session after image providers turn off",
    () => {
      const bridge = makeBridge();
      const mastra = mastraHarnessFixture();

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
          yield* resolveCodex(controller);

          const input = {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access" as const,
          };

          yield* controller.startSession(codexThreadId, input);
          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);

          const toolIds = () =>
            runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id);

          expect(toolIds()).toContain("GenerateImage");

          yield* settings.updateSettings({ imageGeneration: { grokEnabled: false } });
          yield* controller.startSession(codexThreadId, input);
          expect(mastra.createSession).toHaveBeenCalledOnce();
          expect(toolIds()).not.toContain("GenerateImage");
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        undefined,
        { imageGeneration: { grokEnabled: true } },
      );
    },
  );
});
