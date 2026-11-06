import {
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  EnvironmentId,
  type BotPermissionPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderValidationError } from "../Errors.ts";
import { AgentController } from "../Services/AgentController.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { mcpManagerFixture } from "../test-support/mcpManagerFixture.ts";
import { readBotToolPermissionSession } from "../tools/BotToolPermissionSessions.ts";
import {
  makeBridge,
  makeProviderSession,
  provideController,
} from "./test-support/agentControllerLayers.ts";
import type { AgentControllerLiveOptions } from "./agentController/Options.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import { ClaudeAdapter, makeHarness } from "./test-support/claudeAdapterHarness.ts";
import { policyWith } from "./test-support/claudeCodeAdapterHarness.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const botId = BotId.make("bot-claude-code");

const instanceId = ProviderInstanceId.make("claudeCode");

const selection = { instanceId, model: "claude-sonnet-4-6" };

const asClaudeCodeSession = (session: ProviderSession): ProviderSession => ({
  ...session,
  provider: ProviderDriverKind.make("claudeCode"),
  providerInstanceId: instanceId,
});

/**
 * Runs `body` against a Claude Agent bot on the legacy provider bridge. With
 * `adapter`, the bridge starts, interrupts, and stops real ClaudeAdapter
 * sessions, and like ProviderService it skips the adapter for a session that
 * already exited.
 */
const withClaudeCodeBot = <A, E>(
  threadId: ThreadId,
  body: (input: {
    readonly controller: AgentController["Service"];
    readonly bridge: ReturnType<typeof makeBridge>;
  }) => Effect.Effect<A, E, AgentController>,
  adapter?: ClaudeAdapterShape,
  options: Pick<
    AgentControllerLiveOptions,
    "makeMcpManager" | "issueMcpCredential" | "revokeMcpCredential"
  > & { readonly permissionPolicy?: BotPermissionPolicy } = {},
) => {
  const bridge = makeBridge();
  const mastra = mastraHarnessFixture();
  // Sessions the bridge started stay live until stopped, as Claude Code's do.
  const live = new Map<ThreadId, ProviderSession>();

  bridge.startSession.mockImplementation((id, input) =>
    adapter
      ? adapter
          .startSession({
            threadId: id,
            provider: ProviderDriverKind.make("claudeAgent"),
            runtimeMode: input.runtimeMode,
          })
          .pipe(Effect.map(asClaudeCodeSession))
      : Effect.sync(() => {
          const session: ProviderSession = {
            ...asClaudeCodeSession(makeProviderSession(id, "claudeAgent")),
            runtimeMode: input.runtimeMode,
          };

          live.set(id, session);

          return session;
        }),
  );
  bridge.stopSession.mockImplementation((input) =>
    adapter
      ? adapter
          .hasSession(input.threadId)
          .pipe(
            Effect.flatMap((running) =>
              running ? adapter.stopSession(input.threadId) : Effect.void,
            ),
          )
      : Effect.sync(() => {
          live.delete(input.threadId);
        }),
  );

  if (adapter) {
    bridge.interruptTurn.mockImplementation((input) =>
      adapter.interruptTurn(input.threadId, input.turnId),
    );
  }

  const service = {
    ...bridge.service,
    listSessions: () =>
      adapter
        ? adapter.listSessions().pipe(Effect.map((sessions) => sessions.map(asClaudeCodeSession)))
        : Effect.sync(() => [...live.values()]),
  };

  return provideController(
    Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* controller.resolveEngine({
        threadId,
        engine: null,
        fallback: selection,
        mode: "default",
        botConversation: true,
      });

      return yield* body({ controller, bridge });
    }),
    service,
    mastra.factory,
    options.makeMcpManager,
    undefined,
    undefined,
    {
      ...(options.issueMcpCredential ? { issueMcpCredential: options.issueMcpCredential } : {}),
      ...(options.revokeMcpCredential ? { revokeMcpCredential: options.revokeMcpCredential } : {}),
    },
  ).pipe(
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
        projectionQueryFixture({
          getThreadRuntimeContext: (id: ThreadId) =>
            Effect.succeed(Option.some(providerRuntimeContext({ id, botId }))),
          getBotById: () =>
            Effect.succeed(
              Option.some(
                providerBotFixture({
                  id: botId,
                  permissionPolicy: options.permissionPolicy ?? DEFAULT_BOT_PERMISSION_POLICY,
                }),
              ),
            ),
          getGroupById: () => Effect.succeed(Option.none()),
          listThreadDelegations: () => Effect.succeed([]),
        }),
      ),
    ),
  );
};

const startInput = (threadId: ThreadId) => ({
  threadId,
  provider: ProviderDriverKind.make("claudeCode"),
  providerInstanceId: instanceId,
  modelSelection: selection,
  runtimeMode: "full-access" as const,
  botId,
});

describe("AgentControllerLive Claude Agent sessions", () => {
  it.effect("refuses a remote sandbox instead of running Claude Code on this computer", () => {
    const threadId = ThreadId.make("thread-claude-code-sandbox");

    return withClaudeCodeBot(threadId, ({ controller, bridge }) =>
      Effect.gen(function* () {
        const failure = yield* controller
          .startSession(threadId, { ...startInput(threadId), botSandbox: "e2b" })
          .pipe(Effect.flip);

        expect(failure.message).toContain("can only use the Local sandbox");
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(readBotToolPermissionSession(threadId)).toBeUndefined();
      }),
    );
  });

  it.effect("clears the bot's policy entry when Claude Code fails to start", () => {
    const threadId = ThreadId.make("thread-claude-code-start-failure");

    return withClaudeCodeBot(threadId, ({ controller, bridge }) =>
      Effect.gen(function* () {
        bridge.startSession.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderValidationError({
              operation: "ProviderService.startSession",
              issue: "Claude Code is not installed.",
            }),
          ),
        );

        const failure = yield* controller
          .startSession(threadId, startInput(threadId))
          .pipe(Effect.flip);

        expect(failure.message).toContain("Claude Code is not installed.");
        expect(bridge.startSession).toHaveBeenCalledOnce();
        expect(readBotToolPermissionSession(threadId)).toBeUndefined();
      }),
    );
  });

  it.effect("keeps the bot's policy entry for a session that started", () => {
    const threadId = ThreadId.make("thread-claude-code-started");

    return withClaudeCodeBot(threadId, ({ controller }) =>
      Effect.gen(function* () {
        yield* controller.startSession(threadId, startInput(threadId));

        expect(readBotToolPermissionSession(threadId)?.botId).toBe(botId);
      }),
    );
  });

  it.effect("starts a new Claude Code session when Full access becomes Supervised", () => {
    const threadId = ThreadId.make("thread-claude-code-runtime-mode");

    return withClaudeCodeBot(threadId, ({ controller, bridge }) =>
      Effect.gen(function* () {
        yield* controller.startSession(threadId, startInput(threadId));
        // The same mode keeps the live session.
        yield* controller.startSession(threadId, startInput(threadId));
        expect(bridge.startSession).toHaveBeenCalledOnce();

        const session = yield* controller.startSession(threadId, {
          ...startInput(threadId),
          runtimeMode: "approval-required",
        });

        expect(bridge.stopSession).toHaveBeenCalledOnce();
        expect(bridge.startSession).toHaveBeenCalledTimes(2);
        expect(bridge.startSession.mock.calls[1]?.[1].runtimeMode).toBe("approval-required");
        expect(session.runtimeMode).toBe("approval-required");
      }),
    );
  });

  it.effect("starts a new Claude Code session when the model options change", () => {
    const threadId = ThreadId.make("thread-claude-code-model-options");

    return withClaudeCodeBot(threadId, ({ controller, bridge }) =>
      Effect.gen(function* () {
        yield* controller.startSession(threadId, startInput(threadId));
        yield* controller.startSession(threadId, {
          ...startInput(threadId),
          modelSelection: { ...selection, options: [{ id: "effort", value: "max" }] },
        });

        expect(bridge.stopSession).toHaveBeenCalledOnce();
        expect(bridge.startSession).toHaveBeenCalledTimes(2);
        expect(bridge.startSession.mock.calls[1]?.[1].modelSelection?.options).toEqual([
          { id: "effort", value: "max" },
        ]);
      }),
    );
  });

  it.effect("starts Supervised only after the Full access Claude Code process exits", () => {
    const threadId = ThreadId.make("thread-claude-code-slow-exit");
    const harness = makeHarness({ queryPerSession: true });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* withClaudeCodeBot(
        threadId,
        ({ controller, bridge }) =>
          Effect.gen(function* () {
            yield* controller.startSession(threadId, startInput(threadId));
            // A Full access turn is still running a command when the mode changes.
            yield* adapter.sendTurn({ threadId, input: "run the migration", attachments: [] });
            const fullAccess = harness.query;
            const exit = fullAccess.holdExit();

            const restart = yield* controller
              .startSession(threadId, { ...startInput(threadId), runtimeMode: "approval-required" })
              .pipe(Effect.forkChild);

            // Without the wait the restart finishes first and fails the checks below.
            yield* Effect.raceFirst(
              Effect.promise(() => exit.awaited),
              Fiber.await(restart).pipe(Effect.asVoid),
            );

            // The running command was interrupted before close, and nothing
            // replaced the session while the old process is still alive.
            expect(fullAccess.lifecycleCalls).toEqual(["interrupt", "close"]);
            expect(bridge.startSession).toHaveBeenCalledOnce();
            expect(harness.getLastCreateQueryInput()?.options.permissionMode).toBe(
              "bypassPermissions",
            );
            expect(restart.pollUnsafe()).toBeUndefined();

            exit.release();
            const session = yield* Fiber.join(restart);

            expect(bridge.startSession).toHaveBeenCalledTimes(2);
            expect(harness.getLastCreateQueryInput()?.options.permissionMode).not.toBe(
              "bypassPermissions",
            );
            expect(session.runtimeMode).toBe("approval-required");
          }),
        adapter,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases a deleted chat's resources after an interrupt ended Claude Code", () => {
    const threadId = ThreadId.make("thread-claude-code-interrupt-delete");
    const harness = makeHarness({ queryPerSession: true });
    const disconnect = vi.fn(async () => {});
    const revoked: ThreadId[] = [];

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* withClaudeCodeBot(
        threadId,
        ({ controller }) =>
          Effect.gen(function* () {
            yield* controller.startSession(threadId, {
              ...startInput(threadId),
              cwd: process.cwd(),
            });
            expect(readBotToolPermissionSession(threadId)?.botId).toBe(botId);

            yield* adapter.sendTurn({ threadId, input: "run the migration", attachments: [] });
            // Stop on a Claude Agent turn closes the query and drops the session.
            yield* controller.interruptTurn({ threadId });
            expect(yield* adapter.listSessions()).toEqual([]);
            expect(disconnect).not.toHaveBeenCalled();

            // Deleting the chat stops it.
            yield* controller.stopSession({ threadId });

            expect(readBotToolPermissionSession(threadId)).toBeUndefined();
            expect(disconnect).toHaveBeenCalledOnce();
            expect(revoked).toEqual([threadId]);

            // Cleanup that already ran is harmless.
            yield* controller.stopSession({ threadId });
            expect(disconnect).toHaveBeenCalledOnce();
          }),
        adapter,
        {
          makeMcpManager: () => mcpManagerFixture({ disconnect }),
          issueMcpCredential: ({ threadId: id, providerInstanceId }) =>
            Effect.succeed({
              config: {
                environmentId: EnvironmentId.make("environment-claude-code-test"),
                threadId: id,
                providerSessionId: "provider-session-claude-code-test",
                providerInstanceId,
                endpoint: "http://127.0.0.1:15070/mcp",
                authorizationHeader: "Bearer claude-code-test",
              },
            }),
          revokeMcpCredential: (id) =>
            Effect.sync(() => {
              revoked.push(id);
            }),
        },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a restarted chat's resources when an earlier stop finishes late", () => {
    const threadId = ThreadId.make("thread-claude-code-late-stop");
    const harness = makeHarness({ queryPerSession: true });
    const disconnects: number[] = [];
    let managers = 0;

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* withClaudeCodeBot(
        threadId,
        ({ controller, bridge }) =>
          Effect.gen(function* () {
            yield* controller.startSession(threadId, {
              ...startInput(threadId),
              cwd: process.cwd(),
            });
            yield* adapter.sendTurn({ threadId, input: "run the migration", attachments: [] });
            yield* controller.interruptTurn({ threadId });

            // The provider is slow to stop the first session.
            const stopping = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();

            bridge.stopSession.mockImplementationOnce(() =>
              Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );

            const firstStop = yield* controller.stopSession({ threadId }).pipe(Effect.forkChild);
            yield* Deferred.await(stopping);

            // The chat starts again before that stop returns.
            yield* controller.startSession(threadId, {
              ...startInput(threadId),
              cwd: process.cwd(),
            });
            expect(readBotToolPermissionSession(threadId)?.botId).toBe(botId);
            const disconnectsBefore = disconnects.length;

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(firstStop);

            expect(readBotToolPermissionSession(threadId)?.botId).toBe(botId);
            expect(disconnects.length).toBe(disconnectsBefore);
          }),
        adapter,
        {
          makeMcpManager: () => {
            const manager = (managers += 1);

            return mcpManagerFixture({
              disconnect: vi.fn(async () => {
                disconnects.push(manager);
              }),
            });
          },
        },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a restarted chat's stricter policy when an earlier stop finishes late", () => {
    const threadId = ThreadId.make("thread-claude-code-late-stop-policy");
    const harness = makeHarness({ queryPerSession: true, enforceBotPermissionPolicy: true });
    const disconnecting = Promise.withResolvers<void>();
    const finishDisconnect = Promise.withResolvers<void>();
    let managers = 0;

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* withClaudeCodeBot(
        threadId,
        ({ controller }) =>
          Effect.gen(function* () {
            yield* controller.startSession(threadId, {
              ...startInput(threadId),
              cwd: process.cwd(),
            });

            // The first stop waits on its MCP disconnect while the chat starts again.
            const firstStop = yield* controller.stopSession({ threadId }).pipe(Effect.forkChild);
            yield* Effect.promise(() => disconnecting.promise);
            yield* controller.startSession(threadId, {
              ...startInput(threadId),
              cwd: process.cwd(),
            });

            finishDisconnect.resolve();
            yield* Fiber.join(firstStop);

            const hook =
              harness.getLastCreateQueryInput()?.options.hooks?.PreToolUse?.[0]?.hooks[0];

            if (!hook) throw new Error("The restarted session has no policy hook.");

            const output = yield* Effect.promise(() =>
              hook(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "session",
                  transcript_path: "transcript",
                  cwd: process.cwd(),
                  tool_name: "Bash",
                  tool_input: { command: "ls" },
                  tool_use_id: "late-stop-bash",
                },
                "late-stop-bash",
                { signal: new AbortController().signal },
              ),
            );

            // The bot's policy denies shell access; the default policy would allow it.
            expect(JSON.stringify(output)).toContain('"permissionDecision":"deny"');
            expect(readBotToolPermissionSession(threadId)?.botId).toBe(botId);
          }),
        adapter,
        {
          permissionPolicy: policyWith({ "environment-access": "deny" }),
          // The preview MCP credential gives each session an MCP manager to disconnect.
          issueMcpCredential: ({ threadId: id, providerInstanceId }) =>
            Effect.succeed({
              config: {
                environmentId: EnvironmentId.make("environment-claude-code-test"),
                threadId: id,
                providerSessionId: "provider-session-claude-code-test",
                providerInstanceId,
                endpoint: "http://127.0.0.1:15070/mcp",
                authorizationHeader: "Bearer claude-code-test",
              },
            }),
          makeMcpManager: () => {
            const first = (managers += 1) === 1;

            return mcpManagerFixture({
              disconnect: vi.fn(async () => {
                if (!first) return;
                disconnecting.resolve();
                await finishDisconnect.promise;
              }),
            });
          },
        },
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
