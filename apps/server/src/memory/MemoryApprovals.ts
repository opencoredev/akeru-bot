// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryCandidateId,
  AkeruMemoryId,
  AkeruMemoryRootId,
  AKERU_MEMORY_FACT_MAX_CHARS,
  BotId,
  CommandId,
  EventId,
  ThreadId,
  type AkeruMemoryApprovalRequest,
  type AkeruMemoryCandidateDecision,
  type AkeruMemoryDecisionReceipt,
  type AkeruMemoryRevision,
  type AkeruMemoryShareScope,
  type AkeruMemoryTargetScope,
  type AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BotInboxService } from "../bot-inbox/service.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { assertSafeContent } from "./BotMemory.ts";
import { resolveAuthorizedMemoryPartitions } from "./EntityMemoryAccess.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";

export class MemoryApprovalError extends Schema.TaggedErrorClass<MemoryApprovalError>()(
  "MemoryApprovalError",
  { message: Schema.String },
) {}

export interface MemoryShareProposal {
  readonly access: AkeruMemoryThreadAccess;
  readonly fact: string;
  readonly scope: AkeruMemoryShareScope;
  readonly sensitive: boolean;
  // "auto" saves non-sensitive shared facts without asking.
  readonly mode: "ask" | "auto";
}

export type MemoryShareResult =
  | { readonly status: "saved"; readonly memoryId: AkeruMemoryRootId }
  | { readonly status: "pending"; readonly candidateId: AkeruMemoryCandidateId };

export interface MemoryApprovalsShape {
  // Called by the memory tool when a bot wants to save a shared fact.
  readonly propose: (
    input: MemoryShareProposal,
  ) => Effect.Effect<MemoryShareResult, MemoryApprovalError>;
  // Called when a person approves or rejects a pending candidate from the
  // chat card or the bot inbox. Deciding twice returns the first receipt.
  readonly decide: (input: {
    readonly access: AkeruMemoryThreadAccess;
    readonly decision: AkeruMemoryCandidateDecision;
  }) => Effect.Effect<AkeruMemoryDecisionReceipt, MemoryApprovalError>;
}

export class MemoryApprovals extends Context.Service<MemoryApprovals, MemoryApprovalsShape>()(
  "akeru-bot/memory/MemoryApprovals",
) {}

export const memoryApprovalIncidentKey = (candidateId: string) => `memory-approval:${candidateId}`;

const SCOPE_LABELS: Record<AkeruMemoryTargetScope, string> = {
  private: "private",
  bot: "this bot's",
  project: "project",
  group: "group",
  workspace: "workspace",
};
const INBOX_SUMMARY_MAX_CHARS = 240;
const boundedSummary = (value: string) =>
  value.length <= INBOX_SUMMARY_MAX_CHARS
    ? value
    : `${value.slice(0, INBOX_SUMMARY_MAX_CHARS - 1)}…`;

const AffectedBotIdsJson = Schema.fromJsonString(Schema.Array(BotId));
const encodeAffectedBotIds = Schema.encodeEffect(AffectedBotIdsJson);

const CandidateRow = Schema.Struct({
  candidateId: Schema.String,
  tenantId: Schema.String,
  sourceThreadId: Schema.String,
  sourceMessageId: Schema.NullOr(Schema.String),
  authorBotId: Schema.NullOr(Schema.String),
  fact: Schema.String,
  scope: Schema.String,
  sensitive: Schema.Number,
  confidence: Schema.Number,
  affectedBotIds: AffectedBotIdsJson,
  status: Schema.String,
});

const ReceiptRow = Schema.Struct({
  status: Schema.String,
  fact: Schema.String,
  scope: Schema.String,
  affectedBotIds: AffectedBotIdsJson,
  memoryRootId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const decodeCandidateRow = Schema.decodeUnknownEffect(CandidateRow);
const decodeReceiptRow = Schema.decodeUnknownEffect(ReceiptRow);

const failWith = (message: string) => (cause: unknown) =>
  new MemoryApprovalError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? `${message}: ${String(cause.message)}`
        : message,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* EntityMemoryRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig;
  const botInbox = BotInboxService.forSecretsDir(config.secretsDir);
  const decideLock = yield* Semaphore.make(1);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const affectedBotsFor = (access: AkeruMemoryThreadAccess) => {
    const authorBotId = access.respondingBotId ?? access.botId;
    return access.groupId === null
      ? authorBotId === null
        ? []
        : [authorBotId]
      : [...access.groupMemberBotIds];
  };

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly candidateId: string;
    readonly phase: "requested" | "resolved";
    readonly summary: string;
    readonly payload: AkeruMemoryApprovalRequest | AkeruMemoryDecisionReceipt;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`memory-approval:${input.candidateId}:${input.phase}`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(`memory-approval:${input.candidateId}:${input.phase}`),
          tone: input.phase === "requested" ? "approval" : "info",
          kind:
            input.phase === "requested"
              ? AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY
              : AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.mapError(failWith("Could not record the memory approval")));

  const openInboxItem = Effect.fn("MemoryApprovals.openInboxItem")(function* (
    request: AkeruMemoryApprovalRequest,
  ) {
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(request.sourceThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const botId =
      request.authorBotId ??
      Option.match(thread, {
        onNone: () => null,
        onSome: (value) => value.respondingBotId ?? value.botId ?? null,
      });
    if (botId === null) return;
    const snapshot = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.orElseSucceed(() => null));
    const bot = snapshot?.bots.find((candidate) => candidate.id === botId);
    if (!bot) return;
    yield* Effect.sync(() =>
      botInbox.ensureOpen({
        incidentKey: memoryApprovalIncidentKey(request.candidateId),
        kind: "approval-request",
        botId,
        botName: bot.name,
        taskOrRoutine: Option.match(thread, {
          onNone: () => "Memory",
          onSome: (value) => value.title,
        }),
        lastFailure: boundedSummary(
          `Save to ${SCOPE_LABELS[request.scope]} memory: ${request.fact}`,
        ),
        nextAction: "Approve or reject this memory.",
        memoryApproval: request,
      }),
    );
  });

  const propose: MemoryApprovalsShape["propose"] = Effect.fn("MemoryApprovals.propose")(
    function* (input) {
      if (input.fact.length > AKERU_MEMORY_FACT_MAX_CHARS) {
        return yield* new MemoryApprovalError({ message: "Memory text is too long." });
      }
      const createdAt = yield* nowIso;
      if (input.mode === "auto" && !input.sensitive) {
        const memoryId = AkeruMemoryId.make(NodeCrypto.randomUUID());
        const revision = yield* repository
          .insertScopedFact({
            access: input.access,
            scope: input.scope,
            fact: input.fact,
            sensitive: false,
            confidence: 1,
            sourceMessageId: null,
            memoryId,
            createdAt,
          })
          .pipe(Effect.mapError(failWith("Could not save the memory")));
        return { status: "saved", memoryId: revision.rootId } as const;
      }

      // Check the scope before storing, so no card appears that can never be approved.
      const partitions = yield* resolveAuthorizedMemoryPartitions(input.access).pipe(
        Effect.mapError(failWith("Could not store the memory candidate")),
      );
      if (!partitions.some((partition) => partition.scope === input.scope)) {
        return yield* new MemoryApprovalError({
          message: `The ${input.scope} memory scope is not available to this chat.`,
        });
      }
      const candidateId = AkeruMemoryCandidateId.make(NodeCrypto.randomUUID());
      const authorBotId = input.access.respondingBotId ?? input.access.botId;
      const request: AkeruMemoryApprovalRequest = {
        candidateId,
        fact: input.fact,
        scope: input.scope,
        sensitive: input.sensitive,
        sourceThreadId: input.access.threadId,
        authorBotId,
        affectedBotIds: affectedBotsFor(input.access),
      };
      const affectedBotIdsJson = yield* encodeAffectedBotIds(request.affectedBotIds).pipe(
        Effect.mapError(failWith("Could not store the memory candidate")),
      );
      yield* sql`
        INSERT INTO akeru_memory_candidates (
          candidate_id, tenant_id, initiating_user_id, source_thread_id,
          source_message_id, author_bot_id, fact_text, target_scope, sensitive,
          confidence, affected_bot_ids_json, status, created_at
        ) VALUES (
          ${candidateId}, ${input.access.tenantId}, ${input.access.userId},
          ${input.access.threadId}, ${null}, ${authorBotId}, ${input.fact},
          ${input.scope}, ${input.sensitive ? 1 : 0}, ${1},
          ${affectedBotIdsJson}, 'pending', ${createdAt}
        )
      `.pipe(Effect.mapError(failWith("Could not store the memory candidate")));
      // Without its chat card the candidate cannot be decided, so drop it
      // when the request cannot be published.
      yield* appendActivity({
        threadId: input.access.threadId,
        candidateId,
        phase: "requested",
        summary: `Save to ${SCOPE_LABELS[input.scope]} memory?`,
        payload: request,
        createdAt,
      }).pipe(
        Effect.tapError(() =>
          sql`
            DELETE FROM akeru_memory_candidates
            WHERE tenant_id = ${input.access.tenantId} AND candidate_id = ${candidateId}
          `.pipe(Effect.ignore),
        ),
      );
      yield* openInboxItem(request);
      return { status: "pending", candidateId } as const;
    },
  );

  const readReceipt = (tenantId: string, candidateId: string) =>
    sql`
      SELECT status, fact_text AS fact, target_scope AS scope,
        affected_bot_ids_json AS affectedBotIds, memory_root_id AS memoryRootId,
        created_at AS createdAt
      FROM akeru_memory_decision_receipts
      WHERE tenant_id = ${tenantId} AND candidate_id = ${candidateId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.succeed(null)
          : decodeReceiptRow(rows[0]).pipe(
              Effect.map(
                (row): AkeruMemoryDecisionReceipt => ({
                  candidateId: AkeruMemoryCandidateId.make(candidateId),
                  status: row.status === "approved" ? "approved" : "rejected",
                  fact: row.fact,
                  scope: row.scope as AkeruMemoryTargetScope,
                  affectedBotIds: row.affectedBotIds,
                  memoryRootId:
                    row.memoryRootId === null ? null : AkeruMemoryRootId.make(row.memoryRootId),
                  createdAt: row.createdAt,
                }),
              ),
            ),
      ),
      Effect.mapError(failWith("Could not read the memory decision")),
    );

  const reconcileResolved = Effect.fn("MemoryApprovals.reconcileResolved")(function* (
    candidate: typeof CandidateRow.Type,
    receipt: AkeruMemoryDecisionReceipt,
  ) {
    yield* appendActivity({
      threadId: ThreadId.make(candidate.sourceThreadId),
      candidateId: candidate.candidateId,
      phase: "resolved",
      summary:
        receipt.status === "approved"
          ? `Saved to ${SCOPE_LABELS[receipt.scope] ?? receipt.scope} memory`
          : "Memory not saved",
      payload: receipt,
      createdAt: receipt.createdAt,
    });
    yield* Effect.sync(() => botInbox.resolve(memoryApprovalIncidentKey(candidate.candidateId)));
  });

  const decide: MemoryApprovalsShape["decide"] = (input) =>
    decideLock
      .withPermit(
        Effect.gen(function* () {
          const { decision } = input;
          let access = input.access;
          const rows = yield* sql`
          SELECT candidate_id AS candidateId, tenant_id AS tenantId,
            source_thread_id AS sourceThreadId, source_message_id AS sourceMessageId,
            author_bot_id AS authorBotId, fact_text AS fact, target_scope AS scope,
            sensitive, confidence, affected_bot_ids_json AS affectedBotIds, status
          FROM akeru_memory_candidates
          WHERE tenant_id = ${access.tenantId} AND candidate_id = ${decision.candidateId}
        `.pipe(
            Effect.flatMap(Effect.forEach((row) => decodeCandidateRow(row))),
            Effect.mapError(failWith("Could not read the memory candidate")),
          );
          const candidate = rows[0];
          if (candidate === undefined || candidate.sourceThreadId !== access.threadId) {
            return yield* new MemoryApprovalError({
              message: "This memory approval does not belong to this chat.",
            });
          }
          if (candidate.status !== "pending") {
            const existing = yield* readReceipt(access.tenantId, candidate.candidateId);
            if (existing !== null) {
              yield* reconcileResolved(candidate, existing);
              return existing;
            }
            return yield* new MemoryApprovalError({
              message: "This memory approval was already decided.",
            });
          }

          // Save under the bot that asked, even if a different group bot is
          // responding by the time the user decides.
          if (candidate.authorBotId !== null) {
            access = { ...access, respondingBotId: BotId.make(candidate.authorBotId) };
          }
          const createdAt = yield* nowIso;
          let fact =
            decision.decision === "approve" ? (decision.fact ?? candidate.fact) : candidate.fact;
          if (fact.length > AKERU_MEMORY_FACT_MAX_CHARS) {
            return yield* new MemoryApprovalError({ message: "Memory text is too long." });
          }
          if (decision.decision === "approve" && decision.fact !== undefined) {
            // An edited fact goes through the same guard as a tool-proposed one.
            yield* Effect.try({
              try: () => assertSafeContent(fact),
              catch: (cause) =>
                new MemoryApprovalError({
                  message: cause instanceof Error ? cause.message : "Memory content was rejected.",
                }),
            });
          }
          if (
            decision.decision === "approve" &&
            decision.scope !== undefined &&
            decision.scope !== candidate.scope
          ) {
            return yield* new MemoryApprovalError({
              message: "The approval scope must match the candidate scope.",
            });
          }
          let scope =
            decision.decision === "approve"
              ? (decision.scope ?? (candidate.scope as AkeruMemoryTargetScope))
              : (candidate.scope as AkeruMemoryTargetScope);
          let approvedRevision: AkeruMemoryRevision | null = null;
          if (decision.decision === "approve") {
            approvedRevision = yield* repository
              .insertScopedFact({
                access,
                scope,
                fact,
                sensitive: candidate.sensitive === 1,
                confidence: candidate.confidence,
                sourceMessageId: null,
                memoryId: AkeruMemoryId.make(`approval:${candidate.candidateId}`),
                createdAt,
              })
              .pipe(
                Effect.catchTag("EntityMemoryConflictError", () =>
                  repository
                    .getCurrent({
                      access,
                      rootId: AkeruMemoryRootId.make(`approval:${candidate.candidateId}`),
                    })
                    .pipe(
                      Effect.flatMap((existing) =>
                        existing.fact === fact &&
                        existing.partition.scope === scope &&
                        existing.approvalState === "approved" &&
                        existing.deletionState === "active"
                          ? Effect.succeed(existing)
                          : Effect.fail(
                              new MemoryApprovalError({
                                message:
                                  "This memory approval already has a different approved fact or scope.",
                              }),
                            ),
                      ),
                    ),
                ),
                Effect.mapError((cause) =>
                  cause._tag === "MemoryApprovalError"
                    ? cause
                    : failWith("Could not save the memory")(cause),
                ),
              );
            // A conflict may mean the insert committed before the receipt write.
            // Use the durable revision as the source of truth for the receipt.
            fact = approvedRevision.fact;
            scope = approvedRevision.partition.scope as AkeruMemoryTargetScope;
          } else {
            const orphan = yield* repository
              .getCurrent({
                access,
                rootId: AkeruMemoryRootId.make(`approval:${candidate.candidateId}`),
              })
              .pipe(Effect.catchTag("EntityMemoryNotFoundError", () => Effect.succeed(null)));
            // A retry after a crash may find the orphan already retracted.
            if (orphan !== null && orphan.deletionState === "active") {
              yield* repository
                .applyMutation({
                  access,
                  mutation: {
                    operation: "fact.forget",
                    memoryId: orphan.rootId,
                    expectedRevision: orphan.revision,
                  },
                  memoryId: AkeruMemoryId.make(`approval:${candidate.candidateId}:rejected`),
                  updatedAt: createdAt,
                  sharedProjectApproval: "approved",
                })
                .pipe(Effect.mapError(failWith("Could not retract the rejected memory")));
            }
          }
          const memoryRootId = approvedRevision?.rootId ?? null;
          const receipt: AkeruMemoryDecisionReceipt = {
            candidateId: AkeruMemoryCandidateId.make(candidate.candidateId),
            status: decision.decision === "approve" ? "approved" : "rejected",
            fact,
            scope,
            affectedBotIds: candidate.affectedBotIds,
            memoryRootId,
            createdAt,
          };
          const affectedBotIdsJson = yield* encodeAffectedBotIds(receipt.affectedBotIds).pipe(
            Effect.mapError(failWith("Could not record the memory decision")),
          );
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                UPDATE akeru_memory_candidates
                SET status = ${receipt.status}, decided_at = ${createdAt},
                  decided_memory_root_id = ${memoryRootId}
                WHERE tenant_id = ${access.tenantId} AND candidate_id = ${candidate.candidateId}
              `;
                yield* sql`
                INSERT INTO akeru_memory_decision_receipts (
                  receipt_id, candidate_id, tenant_id, status, fact_text, target_scope,
                  affected_bot_ids_json, memory_root_id, created_at
                ) VALUES (
                  ${NodeCrypto.randomUUID()}, ${candidate.candidateId}, ${access.tenantId},
                  ${receipt.status}, ${fact}, ${scope}, ${affectedBotIdsJson},
                  ${memoryRootId}, ${createdAt}
                )
              `;
              }),
            )
            .pipe(Effect.mapError(failWith("Could not record the memory decision")));
          yield* reconcileResolved(candidate, receipt);
          return receipt;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "MemoryApprovalError"
            ? cause
            : failWith("Could not record the memory decision")(cause),
        ),
      );

  return { propose, decide } satisfies MemoryApprovalsShape;
});

export const MemoryApprovalsLive = Layer.effect(MemoryApprovals, make);
