import { type OrchestrationCommand, type OrchestrationReadModel } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import {
  requireActiveGroupMember,
  requireBot,
  requireGroup,
  requireThread,
} from "../commandInvariants.ts";
import {
  requireActiveResponder,
  withEventBase,
  resolveAssistantMessageBot,
  type DecideOrchestrationCommandResult,
} from "./eventBase.ts";

export const decideThreadMessages = Effect.fn("decideThreadMessages")(function* ({
  command,
  readModel,
  actor,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "thread.voice-transcript.append"
        | "thread.message.assistant.delta"
        | "thread.message.assistant.complete"
        | "thread.message.reaction.set"
        | "thread.proposed-plan.upsert";
    }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "thread.voice-transcript.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      // An archived bot takes no new speech, but the tail of a reply already in
      // flight when it was archived still lands in the transcript. The web client
      // omits respondingBotId for user speech, so resolve it the way a turn would.
      if (command.role === "user") {
        const group =
          thread.groupId === null || thread.groupId === undefined
            ? null
            : yield* requireGroup({ readModel, command, groupId: thread.groupId });

        if (
          group === null &&
          thread.botId !== null &&
          command.respondingBotId !== undefined &&
          command.respondingBotId !== thread.botId
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Chat '${thread.id}' cannot address a different bot.`,
          });
        }

        yield* requireActiveResponder({
          readModel,
          command,
          groupId: group?.id,
          botId: group
            ? (command.respondingBotId ?? group.bossBotId)
            : (thread.botId ?? command.respondingBotId),
        });
      } else if (command.respondingBotId !== undefined) {
        yield* requireBot({ readModel, command, botId: command.respondingBotId });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: command.role,
          text: command.text,
          turnId: null,
          ...(command.respondingBotId !== undefined
            ? { respondingBotId: command.respondingBotId }
            : {}),
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const respondingBotId = yield* resolveAssistantMessageBot({ readModel, command, thread });

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
          turnId: command.turnId ?? null,
          respondingBotId,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      const respondingBotId = yield* resolveAssistantMessageBot({ readModel, command, thread });

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          respondingBotId,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.reaction.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      if (!thread.messages.some((message) => message.id === command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.messageId}' is not visible in thread '${command.threadId}'.`,
        });
      }

      if (actor === undefined && command.botId === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Trusted bot reactions require a bot identity.",
        });
      }

      if (actor === undefined && thread.groupId != null) {
        const group = yield* requireGroup({
          readModel,
          command,
          groupId: thread.groupId,
        });

        const reactionBotId = thread.respondingBotId ?? group.bossBotId;

        if (reactionBotId === null || command.botId !== reactionBotId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' cannot react in thread '${command.threadId}'.`,
          });
        }

        yield* requireActiveGroupMember({
          readModel,
          command,
          groupId: thread.groupId,
          botId: reactionBotId,
        });
      } else if (actor === undefined && thread.botId !== command.botId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Bot '${command.botId}' cannot react in thread '${command.threadId}'.`,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "thread.message-reaction-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(actor === undefined ? { botId: command.botId } : { personId: actor.personId }),
          emoji: command.emoji,
          present: command.present,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }
  }
});
