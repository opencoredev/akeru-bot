import { CHANNEL_LINK_CODE_ALPHABET, CHANNEL_LINK_CODE_LENGTH } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { type CommandInput, type CommandEffect, commandId, dispatch } from "./dispatch.ts";

export type CreateChannelLinkCodeInput = Omit<CommandInput<"channel.link-code.create">, "code">;

export type RemoveChannelOwnerInput = CommandInput<"channel.owner.remove">;

export type SetChannelAccessInput = CommandInput<"channel.access.set">;

/** A code from secure random bytes. The alphabet has 32 letters, so each byte maps evenly. */
export const channelLinkCodeFromBytes = (bytes: Uint8Array) =>
  Array.from(bytes.slice(0, CHANNEL_LINK_CODE_LENGTH), (byte) =>
    CHANNEL_LINK_CODE_ALPHABET.charAt(byte % CHANNEL_LINK_CODE_ALPHABET.length),
  ).join("");

/** Registers a fresh one-time code for the bot's channel and returns it for display. */
export const createChannelLinkCode = Effect.fn("EnvironmentCommands.createChannelLinkCode")(
  function* (input: CreateChannelLinkCodeInput) {
    const crypto = yield* Crypto.Crypto;

    const code = channelLinkCodeFromBytes(
      yield* crypto.randomBytes(CHANNEL_LINK_CODE_LENGTH).pipe(Effect.orDie),
    );

    yield* dispatch({
      ...input,
      type: "channel.link-code.create",
      commandId: yield* commandId(input),
      code,
    });

    return code;
  },
);

export const removeChannelOwner: (input: RemoveChannelOwnerInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.removeChannelOwner",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.owner.remove",
    commandId: yield* commandId(input),
  });
});

export const setChannelAccess: (input: SetChannelAccessInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setChannelAccess",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.access.set",
    commandId: yield* commandId(input),
  });
});
