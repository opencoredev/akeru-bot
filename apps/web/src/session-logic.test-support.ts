import {
  classifyTaskAgentKind,
  EventId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@akeru/contracts";

let nextActivityId = 0;

export function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  // Fixtures model post-ingestion rows: ingestion stamps agentKind on every
  // task.* payload. Pass an explicit agentKind to model legacy rows.
  const rawPayload = overrides.payload ?? {};

  const payload =
    overrides.kind?.startsWith("task.") && !("agentKind" in rawPayload)
      ? {
          ...rawPayload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof rawPayload.taskType === "string" ? rawPayload.taskType : undefined,
            agentId: typeof rawPayload.agentId === "string" ? rawPayload.agentId : undefined,
          }),
        }
      : rawPayload;

  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}
