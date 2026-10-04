import type { OrchestrationEvent, OrchestrationReadModel } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { type OrchestrationProjectorDecodeError } from "./Errors.ts";
import { projectEnvironment } from "./projector/Environment.ts";
import { projectBotsAndGroups } from "./projector/BotsAndGroups.ts";
import { projectThreadLifecycle } from "./projector/ThreadLifecycle.ts";
import { projectThreadMessages } from "./projector/ThreadMessages.ts";
import { projectThreadHistory } from "./projector/ThreadHistory.ts";

export { findProjectedThread } from "./projector/Updates.ts";

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    bots: [],
    groups: [],
    delegations: [],
    mcpServers: [],
    routines: [],
    routineRuns: [],
    skillAssignments: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "delegation.created":
    case "delegation.updated":
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "mcp-server.created":
    case "mcp-server.updated":
    case "mcp-server.enabled":
    case "mcp-server.disabled":
    case "mcp-server.deleted":
    case "routine.drafted":
    case "routine.approved":
    case "routine.enabled":
    case "routine.paused":
    case "routine.deleted":
    case "routine.running":
    case "routine.blocked":
    case "routine.failed":
    case "routine.completed":
    case "routine.run-canceled":
    case "skill-assignment.assigned":
    case "skill-assignment.unassigned":
      return projectEnvironment(nextBase, event);
    case "bot.created":
    case "bot.updated":
    case "bot.archived":
    case "bot.restored":
    case "bot.deleted":
    case "group.created":
    case "group.renamed":
    case "group.member-assigned":
    case "group.member-unassigned":
    case "group.person-assigned":
    case "group.person-unassigned":
    case "group.boss-set":
    case "group.deleted":
      return projectBotsAndGroups(nextBase, event);
    case "thread.created":
    case "thread.ownership-updated":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.channel-delivery-set":
      return projectThreadLifecycle(nextBase, event);
    case "thread.message-sent":
    case "thread.message-reaction-set":
    case "thread.proposed-plan-upserted":
      return projectThreadMessages(nextBase, event);
    case "thread.turn-start-requested":
    case "thread.turn-resume-requested":
    case "thread.session-set":
    case "thread.turn-diff-completed":
    case "thread.reverted":
    case "thread.activity-appended":
      return projectThreadHistory(nextBase, event);
    default:
      return Effect.succeed(nextBase);
  }
}
