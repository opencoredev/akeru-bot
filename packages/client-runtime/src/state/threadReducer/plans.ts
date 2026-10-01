import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

import { type OrchestrationEvent, type OrchestrationThread } from "@akeru/contracts";
import type { ThreadDetailReducerResult } from "./types.ts";

import * as O from "effect/Order";

export const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

export function applyProposedPlanUpsertedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.proposed-plan-upserted" }>,
): ThreadDetailReducerResult {
  const proposedPlan = event.payload.proposedPlan;

  const proposedPlans = pipe(
    thread.proposedPlans,
    Arr.filter((entry) => entry.id !== proposedPlan.id),
    Arr.append(proposedPlan),
    Arr.sort(proposedPlanOrder),
  );

  return {
    kind: "updated",
    thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
  };
}
