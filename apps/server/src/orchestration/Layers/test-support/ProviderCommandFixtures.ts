import * as Predicate from "effect/Predicate";
import { type OrchestrationEvent } from "@akeru/contracts";
import { ApprovalRequestId, DelegationId, MessageId, ProjectId, TurnId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { deriveServerPaths } from "../../../config.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

export const asProjectId = (value: string): ProjectId => ProjectId.make(value);

export const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.make(value);

export const asMessageId = (value: string): MessageId => MessageId.make(value);

export const asTurnId = (value: string): TurnId => TurnId.make(value);

export const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

export // Subscribes before the caller triggers work, then resolves with the first
// published event that matches. Awaiting the event replaces polling state.
const awaitDomainEvent = (
  engine: OrchestrationEngineService["Service"],
  matches: (event: OrchestrationEvent) => boolean,
) =>
  engine.subscribeDomainEvents.pipe(
    Effect.flatMap((events) =>
      events.pipe(Stream.filter(matches), Stream.runHead, Effect.forkScoped),
    ),
  );

export // Matches the event that hands a delegated result back to pending.
const releasesDelegation = (delegationId: DelegationId) => (event: OrchestrationEvent) =>
  event.type === "delegation.updated" &&
  event.payload.delegation.delegationId === delegationId &&
  Predicate.isTagged(event.payload.delegation.phase, "Completed") &&
  event.payload.delegation.phase.acknowledgedAt === null;
