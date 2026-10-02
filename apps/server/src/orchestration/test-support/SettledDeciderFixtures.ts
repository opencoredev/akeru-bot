import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@akeru/contracts";

export const NOW = "2026-01-01T00:00:00.000Z";

export const SETTLED_AT = "2025-12-30T00:00:00.000Z";

export function makeReadModel(
  settledOverride: OrchestrationThread["settledOverride"],
  archivedAt: string | null = null,
  session: OrchestrationSession | null = null,
  activities: OrchestrationThread["activities"] = [],
  messages: OrchestrationThread["messages"] = [],
  lifecycle: {
    readonly pinnedAt?: string | null;
    readonly snoozedUntil?: string | null;
    readonly snoozedAt?: string | null;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    bots: [],
    groups: [],
    delegations: [],
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
        snoozedUntil: lifecycle.snoozedUntil ?? null,
        snoozedAt: lifecycle.snoozedAt ?? (lifecycle.snoozedUntil != null ? SETTLED_AT : null),
        pinnedAt: lifecycle.pinnedAt ?? null,
        deletedAt: null,
        messages,
        proposedPlans: [],
        activities,
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

export function createSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}
