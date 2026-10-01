import { type PreviewAutomationOperation } from "@akeru/contracts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  type ClientConnection,
  type PendingRequest,
  type BrokerState,
} from "./PreviewAutomationState.ts";

export const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const clients = new Map(current.clients);
  const assignments = new Map(current.assignments);
  const pending = new Map(current.pending);
  const disconnected: PendingRequest[] = [];

  if (current.clients.get(clientId)?.queue === queue) clients.delete(clientId);

  for (const [assignmentKey, assignment] of assignments) {
    if (assignment.queue === queue) assignments.delete(assignmentKey);
  }

  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }

  return {
    state: { ...current, clients, assignments, pending },
    disconnected,
  };
};

export const hostAssignmentKey = (scope: McpInvocationContext.McpInvocationScope): string =>
  `${scope.environmentId}\u0000${scope.providerSessionId}`;

export const supportsOperation = (
  connection: ClientConnection,
  operation: PreviewAutomationOperation,
): boolean => connection.supportedOperations.has(operation);
