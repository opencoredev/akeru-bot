import { type OrchestrationCommand, type OrchestrationReadModel } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import type { OrchestrationDispatchActor } from "./Services/OrchestrationEngine.ts";
import { requireGroupOwnedThreadMutationAuthorized, requireThread } from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { decideProjects } from "./decider/projects.ts";
import { decideBots } from "./decider/bots.ts";
import { decideGroups } from "./decider/groups.ts";
import { decideMcpServers } from "./decider/mcpServers.ts";
import { decideDelegations } from "./decider/delegations.ts";
import { decideRoutines } from "./decider/routines.ts";
import { decideThreadLifecycle } from "./decider/threadLifecycle.ts";
import { decideThreadVisibility } from "./decider/threadVisibility.ts";
import { decideThreadTurns } from "./decider/threadTurns.ts";
import { decideThreadMessages } from "./decider/threadMessages.ts";
import { decideThreadObservations } from "./decider/threadObservations.ts";
import {
  type PlannedOrchestrationEvent,
  type DecideOrchestrationCommandResult,
} from "./decider/eventBase.ts";

export const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
  actor,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
      ...(actor !== undefined ? { actor } : {}),
    });

    const nextEvents = Array.isArray(decided) ? decided : [decided];

    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  actor,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const commandType = command.type;

  switch (command.type) {
    case "thread.delete":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.meta.update":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.voice-transcript.append":
    case "thread.message.reaction.set":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.checkpoint.revert":
    case "thread.session.stop": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      yield* requireGroupOwnedThreadMutationAuthorized({ readModel, thread, command, actor });
      break;
    }
  }

  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return yield* decideProjects({
        command,
        readModel,
        decideCommandSequence,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "bot.create":
    case "bot.update":
    case "bot.archive":
    case "bot.restore":
    case "bot.delete":
      return yield* decideBots({ command, readModel, ...(actor !== undefined ? { actor } : {}) });
    case "group.create":
    case "group.rename":
    case "group.delete":
    case "group.member.assign":
    case "group.member.unassign":
    case "group.person.assign":
    case "group.person.unassign":
    case "group.leave":
    case "group.boss.set":
      return yield* decideGroups({ command, readModel, ...(actor !== undefined ? { actor } : {}) });
    case "mcp-server.create":
    case "mcp-server.update":
    case "mcp-server.instructions.set":
    case "mcp-server.delete":
    case "mcp-server.enable":
    case "mcp-server.disable":
      return yield* decideMcpServers({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "delegation.create":
    case "delegation.state.set":
    case "delegation.cancel":
    case "delegation.retry":
      return yield* decideDelegations({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "routine.create-approved":
    case "routine.draft":
    case "routine.approve":
    case "routine.enable":
    case "routine.pause":
    case "routine.run":
    case "routine.run.scheduled":
    case "routine.run.start":
    case "routine.run.block":
    case "routine.run.fail":
    case "routine.run.complete":
    case "routine.run.cancel":
    case "routine.delete":
    case "routine.skill.assign":
    case "routine.skill.unassign":
      return yield* decideRoutines({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "thread.create":
    case "thread.delete":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.meta.update":
    case "thread.title.regeneration.complete":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.channel-delivery.set":
    case "thread.history.restore":
      return yield* decideThreadLifecycle({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "thread.settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
      return yield* decideThreadVisibility({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "thread.turn.start":
    case "thread.turn.resume":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.turn.diff.complete":
      return yield* decideThreadTurns({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "thread.voice-transcript.append":
    case "thread.message.assistant.delta":
    case "thread.message.assistant.complete":
    case "thread.message.reaction.set":
    case "thread.proposed-plan.upsert":
      return yield* decideThreadMessages({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    case "thread.checkpoint.revert":
    case "thread.session.stop":
    case "thread.session.set":
    case "thread.revert.complete":
    case "thread.activity.append":
      return yield* decideThreadObservations({
        command,
        readModel,
        ...(actor !== undefined ? { actor } : {}),
      });
    default: {
      command satisfies never;

      return yield* new OrchestrationCommandInvariantError({
        commandType: commandType,
        detail: `Unknown command type: ${commandType}`,
      });
    }
  }
});
