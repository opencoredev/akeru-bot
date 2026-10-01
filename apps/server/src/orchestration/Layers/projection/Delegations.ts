import { DelegationId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { toPersistenceSqlError } from "../../../persistence/Errors.ts";
import { type ProjectionDependencies, type ProjectorDefinition } from "./Definitions.ts";

export function createDelegations({ sql }: Pick<ProjectionDependencies, "sql">) {
  const applyDelegationsProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyDelegationsProjection",
  )((event, _attachmentSideEffects) => {
    if (event.type !== "delegation.created" && event.type !== "delegation.updated") {
      return Effect.void;
    }

    const delegation = event.payload.delegation;
    const recordJson = JSON.stringify(delegation);

    return Effect.gen(function* () {
      yield* sql`
          INSERT INTO projection_delegations (delegation_id, record_json)
          VALUES (
            ${delegation.delegationId},
            ${recordJson}
          )
          ON CONFLICT (delegation_id) DO UPDATE SET
            record_json = excluded.record_json
        `;

      // Children created before thread.created carried parent links get
      // them from their delegation record, whichever projector runs first.
      const childThreadId =
        "childThreadId" in delegation.phase ? delegation.phase.childThreadId : null;

      if (childThreadId !== null) {
        yield* sql`
            UPDATE projection_threads
            SET
              parent_thread_id = ${delegation.parentThreadId},
              parent_delegation_id = ${delegation.delegationId}
            WHERE thread_id = ${childThreadId}
              AND parent_thread_id IS NULL
          `;
      }
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPipeline.applyDelegationsProjection:query")),
    );
  });

  // Parent link for a delegated child whose thread.created event predates
  // parent fields. Delegations project before threads, so a replay finds it.
  const delegationParentLink = (threadId: string) =>
    sql<{ readonly parentThreadId: string; readonly parentDelegationId: string }>`
        SELECT
          json_extract(record_json, '$.parentThreadId') AS "parentThreadId",
          delegation_id AS "parentDelegationId"
        FROM projection_delegations
        WHERE COALESCE(
          json_extract(record_json, '$.phase.childThreadId'),
          json_extract(record_json, '$.childThreadId')
        ) = ${threadId}
        LIMIT 1
      `.pipe(
      Effect.map(([row]) => ({
        parentThreadId: row ? ThreadId.make(row.parentThreadId) : null,
        parentDelegationId: row ? DelegationId.make(row.parentDelegationId) : null,
      })),
      Effect.mapError(toPersistenceSqlError("ProjectionPipeline.delegationParentLink:query")),
    );

  return { applyDelegationsProjection, delegationParentLink };
}
