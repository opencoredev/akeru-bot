import { assert, it } from "@effect/vitest";
import { BotId, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import {
  channelCommandFailure,
  channelDispatchError,
  type ChannelCommand,
} from "./ChannelCommand.ts";
import {
  ChannelPostRejectedError,
  ChannelRuntimeError,
  ChannelTransportError,
  channelFailureMessage,
} from "./ChannelRuntime.ts";

const send: ChannelCommand = {
  type: "channel.send",
  commandId: CommandId.make("command-send"),
  botId: BotId.make("bot-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
};

it.effect("keeps a definite reply rejection's category instead of delivery-unknown", () =>
  Effect.gen(function* () {
    const rejected = yield* channelCommandFailure(
      send,
      Cause.fail(new ChannelPostRejectedError({ message: "Rejected." })),
    );
    assert.deepStrictEqual(rejected, {
      message: "The channel rejected this reply. Correct the channel problem, then retry.",
      category: "credentials",
    });

    const categorized = yield* channelCommandFailure(
      send,
      Cause.fail(new ChannelPostRejectedError({ message: "Rejected.", category: "network" })),
    );
    assert.strictEqual(categorized.category, "network");
  }),
);

it.effect("reports an ambiguous reply transport failure as delivery-unknown", () =>
  Effect.gen(function* () {
    const failure = yield* channelCommandFailure(
      send,
      Cause.fail(
        new ChannelTransportError({ message: "Channel provider request failed.", cause: {} }),
      ),
    );
    assert.deepStrictEqual(failure, {
      message: channelFailureMessage("delivery-unknown"),
      category: "delivery-unknown",
    });
  }),
);

it.effect("keeps a reply failure that happened before posting out of delivery-unknown", () =>
  Effect.gen(function* () {
    const message = "Reconnect this channel before sending a reply.";
    const failure = yield* channelCommandFailure(
      send,
      Cause.fail(new ChannelRuntimeError({ message })),
    );
    assert.strictEqual(failure.message, message);
    assert.notStrictEqual(failure.category, "delivery-unknown");

    const unknown = yield* channelCommandFailure(
      send,
      Cause.fail(new ChannelRuntimeError({ message: channelFailureMessage("delivery-unknown") })),
    );
    assert.strictEqual(unknown.category, "delivery-unknown");
  }),
);

it("sends the failure category to clients with the fixed message", () => {
  const credentials = channelDispatchError({
    message: channelFailureMessage("credentials"),
    category: "credentials",
  });
  assert.strictEqual(credentials.channelFailureCategory, "credentials");
  assert.strictEqual(credentials.message, channelFailureMessage("credentials"));

  const internal = channelDispatchError({ message: "Channel command failed. Try again." });
  assert.strictEqual(internal.channelFailureCategory, undefined);
});
