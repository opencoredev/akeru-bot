import {
  type ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import {
  channelFailureMessage,
  channelFailurePresentation,
  isChannelTransportError,
  type ChannelFailurePresentation,
  type ChannelOperationError,
  type ChannelRuntimeShape,
} from "./ChannelRuntime.ts";

export type ChannelCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: `channel.${string}` }
>;

export function isChannelCommand(command: ClientOrchestrationCommand): command is ChannelCommand {
  return command.type.startsWith("channel.");
}

export const executeChannelCommand = (
  runtime: ChannelRuntimeShape,
  command: ChannelCommand,
): Effect.Effect<{ readonly sequence: number }, ChannelOperationError> =>
  (command.type === "channel.connect"
    ? runtime.connect(command)
    : command.type === "channel.connection.save"
      ? runtime.saveConnection(command)
      : command.type === "channel.connection.delete"
        ? runtime.deleteConnection(command.connectionId)
        : command.type === "channel.attach"
          ? runtime.attach(command.botId, command.connectionId, command.projectId, command.provider)
          : command.type === "channel.change-project"
            ? runtime.changeProject(command.botId, command.provider, command.projectId)
            : command.type === "channel.disconnect"
              ? runtime.disconnect(command.botId, command.provider)
              : command.type === "channel.detach"
                ? runtime.detach(command.botId, command.provider)
                : command.type === "channel.reconnect"
                  ? runtime.reconnect(command.botId, command.provider)
                  : runtime.sendChannelMessage(command)
  ).pipe(Effect.map((sequence) => ({ sequence })));

/**
 * The only way a channel command failure leaves the server. Returns fixed, client-safe text
 * and logs just the command type and failure category, never the provider error or cause.
 */
export const channelCommandFailure = (
  command: ChannelCommand,
  cause: Cause.Cause<unknown>,
): Effect.Effect<ChannelFailurePresentation> => {
  const error = Cause.hasInterruptsOnly(cause) ? undefined : Cause.squash(cause);
  const presented =
    error === undefined
      ? { message: "Channel command was interrupted. Try again." }
      : channelFailurePresentation(error);
  // A provider error after a reply post began is ambiguous: the message may have been delivered.
  // A definite rejection, or a check that failed before posting, keeps its own category.
  const deliveryUnknown = channelFailureMessage("delivery-unknown");
  const failure: ChannelFailurePresentation =
    command.type === "channel.send" &&
    (isChannelTransportError(error) || presented.message === deliveryUnknown)
      ? { message: deliveryUnknown, category: "delivery-unknown" }
      : presented;
  return Effect.logWarning("channel command failed", {
    commandType: command.type,
    category: failure.category ?? "internal",
  }).pipe(Effect.as(failure));
};

/** The client error for a channel failure. The category lets clients explain it and offer a repair. */
export const channelDispatchError = (failure: ChannelFailurePresentation) =>
  new OrchestrationDispatchCommandError({
    message: failure.message,
    ...(failure.category ? { channelFailureCategory: failure.category } : {}),
  });
