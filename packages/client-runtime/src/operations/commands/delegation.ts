import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type CancelDelegationInput = CommandInput<"delegation.cancel">;

export type RetryDelegationInput = CommandInput<"delegation.retry">;

export const cancelDelegation: (input: CancelDelegationInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.cancelDelegation",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "delegation.cancel",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const retryDelegation: (input: RetryDelegationInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.retryDelegation",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "delegation.retry",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});
