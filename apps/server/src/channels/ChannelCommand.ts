import type { ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ChannelOperationError, ChannelRuntimeShape } from "./ChannelRuntime.ts";

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
