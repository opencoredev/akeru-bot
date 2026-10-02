import {
  ApprovalRequestId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  TurnId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { toMcpElicitationResponse } from "./CodexMcpElicitation.ts";
import {
  CodexSessionRuntimePendingApprovalNotFoundError,
  CodexSessionRuntimePendingUserInputNotFoundError,
} from "./CodexRuntimeErrors.ts";
import { toCodexUserInputAnswers } from "./CodexRuntimeRequests.ts";
import {
  type ApprovalCorrelation,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  type PendingApproval,
  type PendingUserInput,
} from "./CodexRuntimeState.ts";

/**
 * Approval, MCP elicitation, and user-input requests the Codex App Server
 * sends to the client, plus the responses the adapter routes back to them.
 */
export function createCodexServerRequests(deps: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly options: CodexSessionRuntimeOptions;
  readonly sessionRef: Ref.Ref<ProviderSession>;
  readonly pendingApprovalsRef: Ref.Ref<Map<ApprovalRequestId, PendingApproval>>;
  readonly approvalCorrelationsRef: Ref.Ref<Map<string, ApprovalCorrelation>>;
  readonly pendingUserInputsRef: Ref.Ref<Map<ApprovalRequestId, PendingUserInput>>;
  readonly randomUUIDv4: (
    purpose: CodexErrors.CodexAppServerIdentifierPurpose,
  ) => Effect.Effect<string, CodexErrors.CodexAppServerIdentifierGenerationError>;
  readonly emitEvent: (
    event: Omit<ProviderEvent, "id" | "provider" | "createdAt">,
  ) => Effect.Effect<void, CodexErrors.CodexAppServerIdentifierGenerationError>;
}) {
  const {
    options,
    sessionRef,
    pendingApprovalsRef,
    approvalCorrelationsRef,
    pendingUserInputsRef,
    randomUUIDv4,
    emitEvent,
  } = deps;

  const registerHandlers = Effect.gen(function* () {
    yield* deps.client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
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

    yield* deps.client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
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

    yield* deps.client.handleServerRequest("mcpServer/elicitation/request", (payload) =>
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

    yield* deps.client.handleServerRequest("item/tool/requestUserInput", (payload) =>
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

    yield* deps.client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );
  });

  const respondToRequest: CodexSessionRuntimeShape["respondToRequest"] = (requestId, decision) =>
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
    });

  const respondToUserInput: CodexSessionRuntimeShape["respondToUserInput"] = (requestId, answers) =>
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
    });

  return { registerHandlers, respondToRequest, respondToUserInput };
}
