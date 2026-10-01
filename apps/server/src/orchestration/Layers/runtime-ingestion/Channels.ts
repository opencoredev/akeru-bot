import { MessageId, ThreadId, TurnId } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { makeDrainableWorker } from "@akeru/shared/DrainableWorker";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import type { createDependencies } from "./Dependencies.ts";
export const createChannels = Effect.fn("makeRuntimeChannels")(function* ({
  channelRuntime,
}: Pick<Effect.Success<ReturnType<typeof createDependencies>>, "channelRuntime">) {
  const channelStatusWorker = yield* makeDrainableWorker(
    (input: {
      threadId: ThreadId;
      turnId: TurnId | undefined;
      requestMessageId?: MessageId;
      state: "completed" | "failed" | "cancelled" | "waiting" | "resumed";
    }) =>
      channelRuntime
        ? (input.state === "waiting" || input.state === "resumed"
            ? channelRuntime.markChannelTurnWaiting(
                input.threadId,
                input.turnId,
                input.state === "waiting",
              )
            : channelRuntime.finishChannelTurn(
                input.threadId,
                input.turnId,
                input.state,
                input.requestMessageId,
              )
          ).pipe(Effect.catchCause(() => Effect.logWarning("failed to update channel turn status")))
        : Effect.void,
  );

  const automaticChannelReplyWorker = yield* makeDrainableWorker(
    (input: ChannelRuntime.ChannelReplyTarget) => {
      if (!channelRuntime) {
        return Effect.void;
      }
      return channelRuntime.sendChannelMessage(input).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to send automatic channel reply", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  // Open approval and user-input requests per provider turn, so a channel's waiting
  // reaction clears only when the last pending request resolves.
  const channelWaitingRequests = new Map<string, { turnId: TurnId; requestIds: Set<string> }>();

  const clearChannelWaitingRequests = (threadId: ThreadId) => {
    for (const key of channelWaitingRequests.keys()) {
      if (key.startsWith(`${threadId}:`)) channelWaitingRequests.delete(key);
    }
  };
  return {
    channelStatusWorker,
    automaticChannelReplyWorker,
    channelWaitingRequests,
    clearChannelWaitingRequests,
  };
});
