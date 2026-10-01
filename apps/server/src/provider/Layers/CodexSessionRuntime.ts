import { createCodexRuntimeApprovals } from "./codex/CodexRuntimeApprovals.ts";
import { createCodexNotifications } from "./codex/CodexNotifications.ts";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  TurnId,
} from "@akeru/contracts";
import { resolveSpawnCommand } from "@akeru/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { buildCodexInitializeParams } from "./codex/CodexCapabilitiesProbe.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";

import {
  decodeV2TurnStartResponse,
  hasConfiguredMcpServer,
  normalizeCodexModelSlug,
  buildTurnStartParams,
  toCodexUserInputAnswers,
} from "./codex/CodexRuntimeRequests.ts";
import {
  PROVIDER,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  type PendingApproval,
  type ApprovalCorrelation,
  type PendingUserInput,
} from "./codex/CodexRuntimeState.ts";
import {
  CODEX_APP_SERVER_FORCE_KILL_AFTER,
  readResumeCursorThreadId,
  classifyCodexStderrLine,
  openCodexThread,
} from "./codex/CodexRuntimeOpening.ts";
import {
  CodexSessionRuntimePendingApprovalNotFoundError,
  CodexSessionRuntimePendingUserInputNotFoundError,
  CodexSessionRuntimeThreadIdMissingError,
} from "./codex/CodexRuntimeErrors.ts";
import { toMcpElicitationResponse } from "./codex/CodexMcpElicitation.ts";
import {
  type CodexServerNotification,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Pure method/params envelope builder; no Effect service is constructed.
  makeCodexServerNotification,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Pure notification predicate factory; no Effect service is constructed.
  makeMemoryConsolidationNotificationFilter,
  type CollabChildAgentState,
} from "./codex/CodexRuntimeNotifications.ts";
import {
  currentProviderThreadId,
  updateSession,
  parseThreadSnapshot,
} from "./codex/CodexRuntimeSessions.ts";

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const collabChildAgentsRef = yield* Ref.make(new Map<string, CollabChildAgentState>());
    /** Child provider-thread id → its currently running provider turn id. */
    const collabChildLiveTurnsRef = yield* Ref.make(new Map<string, string>());
    const suppressMemoryConsolidationNotification = makeMemoryConsolidationNotificationFilter();
    const closedRef = yield* Ref.make(false);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;

    const env = {
      ...options.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };

    const extendEnv = options.environment === undefined;
    const appServerArgs = codexSessionAppServerArgs(options.appServerArgs, options.launchArgs);

    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, appServerArgs, {
      env,
      extendEnv,
    });

    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env,
          extendEnv,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );

    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const randomUUIDv4 = (purpose: CodexErrors.CodexAppServerIdentifierPurpose) =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerIdentifierGenerationError({
              purpose,
              cause,
            }),
        ),
      );

    const sessionCreatedAt = yield* nowIso;

    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;

    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4("provider-event");

        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });

    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const { settlePendingApprovals, settlePendingUserInputs } = createCodexRuntimeApprovals({
      pendingApprovalsRef,
      pendingUserInputsRef,
    });

    /**
     * Registers v2 collab children and re-emits their notifications as
     * synthetic `collabAgent/*` events for the adapter's task.* synthesis.
     * Returns true when the notification was fully handled (must not reach
     * parent-timeline mapping).
     */
    const { handleRawNotification } = createCodexNotifications({
      collabChildAgentsRef,
      sessionRef,
      emitEvent,
      options,
      collabChildLiveTurnsRef,
      suppressMemoryConsolidationNotification,
      collabReceiverTurnsRef,
      approvalCorrelationsRef,
    });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }

          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }

          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }

          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;

          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;

          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }

          const errorMessage = payload.error.message;
          const willRetry = payload.willRetry;

          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("command-approval-request"));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });

          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });

          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);

              return next;
            }),
          ),
        );

        return {
          decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(
          yield* randomUUIDv4("file-change-approval-request"),
        );

        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });

          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });

          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);

              return next;
            }),
          ),
        );

        return {
          decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("mcpServer/elicitation/request", (payload) =>
      Effect.gen(function* () {
        if (toMcpElicitationResponse(payload, "accept").action !== "accept") {
          yield* Effect.logWarning("Declined an unsupported MCP elicitation.", {
            serverName: payload.serverName,
            mode: payload.mode,
          });

          return {
            action: "decline",
          } satisfies EffectCodexSchema.McpServerElicitationRequestResponse;
        }

        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("mcp-elicitation-request"));

        const turnId = payload.turnId
          ? TurnId.make(payload.turnId)
          : (yield* Ref.get(sessionRef)).activeTurnId;

        const jsonRpcId = payload.mode === "url" ? payload.elicitationId : requestId;
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId,
            requestKind: "mcp-elicitation",
            turnId,
            itemId: undefined,
            decision,
          });

          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(jsonRpcId, {
            requestId,
            requestKind: "mcp-elicitation",
            turnId,
            itemId: undefined,
          });

          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "mcpServer/elicitation/request",
          requestId,
          requestKind: "mcp-elicitation",
          ...(turnId ? { turnId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);

              return next;
            }),
          ),
        );

        return toMcpElicitationResponse(payload, resolved);
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });

          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);

              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(CodexRpc.SERVER_NOTIFICATION_METHODS),
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";

          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);

                if (!classified) {
                  return Effect.void;
                }

                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }

            const nextStatus = exitCode === 0 ? "closed" : "error";

            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      const providerThreadId = opened.thread.id;

      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;

      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");

      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));

      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }

      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);

      if (alreadyClosed) {
        return;
      }

      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped").pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Codex session closed event.", { cause }),
        ),
      );
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;

          if (hasConfiguredMcpServer(options.appServerArgs)) {
            yield* client.request("config/mcpServer/reload", undefined).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to refresh Codex MCP tool catalog before turn.", {
                  cause,
                }),
              ),
            );
          }

          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );

          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            runtimeMode: options.runtimeMode,
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
            // Derived from the session's own MCP configuration rather than the
            // setting, so the prompt describes the tools this turn actually
            // has even if the setting changed after the session started.
            browserToolsAvailable: hasConfiguredMcpServer(options.appServerArgs),
          });

          const rawResponse = yield* client.raw.request("turn/start", params);

          const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                "decode-response-payload",
                error,
                { method: "turn/start" },
              ),
            ),
          );

          const turnId = TurnId.make(response.turn.id);
          yield* updateSession(sessionRef, (session) => ({
            status: "running",
            // Codex accepts follow-ups while the current turn is still
            // running. The response contains the queued turn id, but
            // turn/interrupt only accepts the id that is active now.
            activeTurnId: session.activeTurnId ?? turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          }));
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));

          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          // Stop-everything: children are full threads with their own turns;
          // interrupting only the parent leaves the fleet running. Interrupt
          // each live child turn first, best-effort per child, BOUNDED: the
          // transport awaits an unbounded Deferred per request, so a wedged
          // child would otherwise block the parent interrupt forever —
          // exactly during the runaway fleet where Stop matters most
          // (review finding). Per-child and overall deadlines guarantee the
          // parent interrupt below always runs.
          const liveChildTurns = yield* Ref.get(collabChildLiveTurnsRef);
          yield* Effect.forEach(
            Array.from(liveChildTurns.entries()),
            ([childThreadId, childTurnId]) =>
              client
                .request("turn/interrupt", {
                  threadId: childThreadId,
                  turnId: childTurnId,
                })
                .pipe(Effect.timeoutOption("3 seconds"), Effect.ignore),
            { concurrency: 8, discard: true },
          ).pipe(Effect.timeoutOption("10 seconds"), Effect.ignore);
          const effectiveTurnId = turnId ?? session.activeTurnId;

          if (!effectiveTurnId) {
            return;
          }

          yield* client.request("turn/interrupt", {
            threadId: providerThreadId,
            turnId: effectiveTurnId,
          });
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;

        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });

        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;

          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });

          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });

          return parseThreadSnapshot(response);
        }),
      uploadFeedback: (reason) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;

          return yield* client.request("feedback/upload", {
            classification: "bug",
            includeLogs: true,
            ...(reason ? { reason } : {}),
            threadId: providerThreadId,
          });
        }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);

          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }

          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);

            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);

          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }

          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);

            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });

export {
  hasConfiguredMcpServer,
  CodexResumeCursorSchema,
  type CodexTurnStartParamsWithCollaborationMode,
  type CodexResumeCursor,
  buildTurnStartParams,
} from "./codex/CodexRuntimeRequests.ts";

export {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexThreadTurnSnapshot,
  type CodexThreadSnapshot,
  type CodexSessionRuntimeShape,
} from "./codex/CodexRuntimeState.ts";

export {
  type CodexSessionRuntimeError,
  CodexSessionRuntimePendingApprovalNotFoundError,
  CodexSessionRuntimePendingUserInputNotFoundError,
  CodexSessionRuntimeInvalidUserInputAnswersError,
  CodexSessionRuntimeThreadIdMissingError,
} from "./codex/CodexRuntimeErrors.ts";

export { describeMcpElicitation, toMcpElicitationResponse } from "./codex/CodexMcpElicitation.ts";

export { isRecoverableThreadResumeError, openCodexThread } from "./codex/CodexRuntimeOpening.ts";

export {
  makeMemoryConsolidationNotificationFilter,
  type CodexChildNotificationRoute,
  routeCodexChildNotification,
} from "./codex/CodexRuntimeNotifications.ts";
