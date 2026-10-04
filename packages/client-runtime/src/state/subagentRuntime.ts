interface TaskActivityPayload {
  readonly agentKind?: unknown;
}

export function isBackgroundTaskActivity(payload: TaskActivityPayload): boolean {
  return payload.agentKind !== "agent";
}
