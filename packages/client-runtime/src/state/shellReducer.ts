import * as Arr from "effect/Array";
import {
  isTerminalDelegationState,
  SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD,
  type AkeruDelegationRecord,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
} from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "bot-upserted": {
      const bots = snapshot.bots.some((bot) => bot.id === event.bot.id)
        ? Arr.map(snapshot.bots, (bot) => (bot.id === event.bot.id ? event.bot : bot))
        : Arr.append(snapshot.bots, event.bot);
      return { ...snapshot, bots, snapshotSequence: event.sequence };
    }
    case "group-upserted": {
      const groups = snapshot.groups.some((group) => group.id === event.group.id)
        ? Arr.map(snapshot.groups, (group) => (group.id === event.group.id ? event.group : group))
        : Arr.append(snapshot.groups, event.group);
      return { ...snapshot, groups, snapshotSequence: event.sequence };
    }
    case "group-removed":
      return {
        ...snapshot,
        groups: Arr.filter(snapshot.groups, (group) => group.id !== event.groupId),
        snapshotSequence: event.sequence,
      };
    case "mcp-server-upserted": {
      const mcpServers = snapshot.mcpServers ?? [];
      const nextMcpServers = mcpServers.some((server) => server.id === event.mcpServer.id)
        ? Arr.map(mcpServers, (server) =>
            server.id === event.mcpServer.id ? event.mcpServer : server,
          )
        : Arr.append(mcpServers, event.mcpServer);
      return { ...snapshot, mcpServers: nextMcpServers, snapshotSequence: event.sequence };
    }
    case "mcp-server-removed":
      return {
        ...snapshot,
        mcpServers: Arr.filter(
          snapshot.mcpServers ?? [],
          (server) => server.id !== event.mcpServerId,
        ),
        snapshotSequence: event.sequence,
      };
    case "delegation-upserted": {
      const delegations = snapshot.delegations.some(
        (delegation) => delegation.delegationId === event.delegation.delegationId,
      )
        ? Arr.map(snapshot.delegations, (delegation) =>
            delegation.delegationId === event.delegation.delegationId
              ? event.delegation
              : delegation,
          )
        : Arr.append(snapshot.delegations, event.delegation);
      return {
        ...snapshot,
        delegations: isTerminalDelegationState(event.delegation.state)
          ? capTerminalDelegations(delegations, event.delegation.parentThreadId)
          : delegations,
        snapshotSequence: event.sequence,
      };
    }
    case "routine-upserted": {
      const routines = snapshot.routines ?? [];
      const nextRoutines = routines.some((routine) => routine.id === event.routine.id)
        ? Arr.map(routines, (routine) =>
            routine.id === event.routine.id ? event.routine : routine,
          )
        : Arr.append(routines, event.routine);
      const runs = snapshot.routineRuns ?? [];
      const eventRun = event.run;
      const nextRuns = eventRun
        ? runs.some((run) => run.id === eventRun.id)
          ? Arr.map(runs, (run) => (run.id === eventRun.id ? eventRun : run))
          : Arr.append(runs, eventRun)
        : runs;
      return {
        ...snapshot,
        routines: nextRoutines,
        routineRuns: nextRuns,
        snapshotSequence: event.sequence,
      };
    }
    case "routine-removed":
      return {
        ...snapshot,
        routines: Arr.filter(snapshot.routines ?? [], (routine) => routine.id !== event.routineId),
        routineRuns: Arr.filter(
          snapshot.routineRuns ?? [],
          (run) => run.routineId !== event.routineId,
        ),
        snapshotSequence: event.sequence,
      };
    case "skill-assignment-upserted": {
      const assignments = snapshot.skillAssignments ?? [];
      const nextAssignments = assignments.some(
        (assignment) => assignment.id === event.assignment.id,
      )
        ? Arr.map(assignments, (assignment) =>
            assignment.id === event.assignment.id ? event.assignment : assignment,
          )
        : Arr.append(assignments, event.assignment);
      return {
        ...snapshot,
        skillAssignments: nextAssignments,
        snapshotSequence: event.sequence,
      };
    }
    case "skill-assignment-removed":
      return {
        ...snapshot,
        skillAssignments: Arr.filter(
          snapshot.skillAssignments ?? [],
          (assignment) => assignment.id !== event.assignmentId,
        ),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}

/**
 * Keeps the newest finished delegations for one parent thread, matching the
 * limit the server applies to shell snapshots.
 */
// Binary order, matching SQLite's default collation in the shell snapshot query.
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// Keeps the same finished delegations as the shell snapshot, which ranks them
// by updatedAt DESC, createdAt ASC, delegation_id ASC.
function capTerminalDelegations(
  delegations: ReadonlyArray<AkeruDelegationRecord>,
  parentThreadId: AkeruDelegationRecord["parentThreadId"],
): ReadonlyArray<AkeruDelegationRecord> {
  const terminal = delegations.filter(
    (delegation) =>
      delegation.parentThreadId === parentThreadId && isTerminalDelegationState(delegation.state),
  );
  if (terminal.length <= SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD) return delegations;
  const dropped = new Set(
    terminal
      .toSorted(
        (left, right) =>
          compareText(right.updatedAt, left.updatedAt) ||
          compareText(left.createdAt, right.createdAt) ||
          compareText(left.delegationId, right.delegationId),
      )
      .slice(SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD),
  );
  return delegations.filter((delegation) => !dropped.has(delegation));
}
