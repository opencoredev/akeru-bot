import {
  AuthAccessWriteScope,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type OrchestrationCommand,
} from "@t3tools/contracts";

export interface AuthenticatedCommandActor {
  readonly personId: AuthSessionId;
  readonly displayName: string;
  readonly canManageGroups: boolean;
}

export function canManageGroupPeople(
  command: OrchestrationCommand,
  scopes: Iterable<AuthEnvironmentScope>,
): boolean {
  if (command.type !== "group.person.assign" && command.type !== "group.person.unassign") {
    return true;
  }
  return [...scopes].includes(AuthAccessWriteScope);
}

export function applyKnownGroupPerson(
  command: OrchestrationCommand,
  clientSessions: ReadonlyArray<AuthClientSession>,
): OrchestrationCommand | null {
  if (command.type === "group.person.unassign") return command;
  if (command.type !== "group.person.assign") return command;
  const clientSession = clientSessions.find(
    (candidate) => candidate.sessionId === command.person.personId,
  );
  if (!clientSession) return null;
  return {
    ...command,
    person: {
      kind: "person",
      personId: clientSession.sessionId,
      displayName: clientSession.client.label ?? "Paired person",
    },
  };
}

export function applyAuthenticatedCommandActor(
  command: OrchestrationCommand,
  actor: AuthenticatedCommandActor,
): OrchestrationCommand {
  switch (command.type) {
    case "group.create":
      return {
        ...command,
        creator: {
          kind: "person",
          personId: actor.personId,
          displayName: actor.displayName,
        },
      };
    case "group.leave":
      return { ...command, personId: actor.personId };
    case "thread.turn.start":
      return {
        ...command,
        senderPersonId: actor.personId,
        senderDisplayName: actor.displayName,
        senderCanManageGroups: actor.canManageGroups,
      };
    default:
      return command;
  }
}
