import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type ProjectionDependencies,
  type ProjectorDefinition,
  retainProjectionActivitiesAfterRevert,
  extractActivityRequestId,
  isStalePendingApprovalFailureDetail,
} from "./Definitions.ts";

export function createRequests({
  projectionThreadActivityRepository,
  projectionTurnRepository,
  projectionPendingApprovalRepository,
}: Pick<
  ProjectionDependencies,
  | "projectionThreadActivityRepository"
  | "projectionTurnRepository"
  | "projectionPendingApprovalRepository"
>) {
  const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyThreadActivitiesProjection",
  )(function* (event, _attachmentSideEffects) {
    switch (event.type) {
      case "thread.created":
        yield* projectionThreadActivityRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });

        return;

      case "thread.activity-appended":
        yield* projectionThreadActivityRepository.upsert({
          activityId: event.payload.activity.id,
          threadId: event.payload.threadId,
          turnId: event.payload.activity.turnId,
          tone: event.payload.activity.tone,
          kind: event.payload.activity.kind,
          summary: event.payload.activity.summary,
          payload: event.payload.activity.payload,
          ...(event.payload.activity.sequence !== undefined
            ? { sequence: event.payload.activity.sequence }
            : {}),
          createdAt: event.payload.activity.createdAt,
        });

        return;

      case "thread.reverted": {
        const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
          threadId: event.payload.threadId,
        });

        if (existingRows.length === 0) {
          return;
        }

        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });

        const keptRows = retainProjectionActivitiesAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );

        if (keptRows.length === existingRows.length) {
          return;
        }

        yield* projectionThreadActivityRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);

        return;
      }

      default:
        return;
    }
  });

  const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyPendingApprovalsProjection",
  )(function* (event, _attachmentSideEffects) {
    switch (event.type) {
      case "thread.created":
        yield* projectionPendingApprovalRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });

        return;

      case "thread.activity-appended": {
        const requestId =
          extractActivityRequestId(event.payload.activity.payload) ??
          event.metadata.requestId ??
          null;

        if (requestId === null) {
          return;
        }

        const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
          requestId,
        });

        if (event.payload.activity.kind === "approval.resolved") {
          yield* projectionPendingApprovalRepository.deleteByRequestId({ requestId });

          return;
        }

        if (event.payload.activity.kind === "provider.approval.respond.failed") {
          const payload =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null
              ? (event.payload.activity.payload as Record<string, unknown>)
              : null;

          const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

          if (isStalePendingApprovalFailureDetail(detail)) {
            if (Option.isNone(existingRow)) {
              return;
            }

            if (existingRow.value.status === "resolved") {
              return;
            }

            yield* projectionPendingApprovalRepository.deleteByRequestId({ requestId });

            return;
          }

          return;
        }

        // Only approval-requested activities should create pending-approval
        // rows.  Other activity kinds that happen to carry a requestId
        // (e.g. user-input.requested / user-input.resolved) must not
        // pollute this projection — they have their own accounting via
        // derivePendingUserInputCountFromActivities.
        if (event.payload.activity.kind !== "approval.requested") {
          return;
        }

        if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
          return;
        }

        yield* projectionPendingApprovalRepository.upsert({
          requestId,
          threadId: event.payload.threadId,
          turnId: event.payload.activity.turnId,
          status: "pending",
          decision: null,
          createdAt: Option.isSome(existingRow)
            ? existingRow.value.createdAt
            : event.payload.activity.createdAt,
          resolvedAt: null,
        });

        return;
      }

      case "thread.approval-response-requested": {
        // Keep the request pending until the provider confirms the response.
        return;
      }

      default:
        return;
    }
  });

  return { applyThreadActivitiesProjection, applyPendingApprovalsProjection };
}
