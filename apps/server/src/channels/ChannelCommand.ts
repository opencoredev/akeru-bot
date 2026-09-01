import type { ClientOrchestrationCommand } from "@t3tools/contracts";

import {
  connectChannel,
  attachChannelConnection,
  deleteChannelConnection,
  disconnectChannel,
  reconnectChannel,
  saveChannelConnection,
  sendChannelMessage,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";

export type ChannelCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: `channel.${string}` }
>;

export function isChannelCommand(command: ClientOrchestrationCommand): command is ChannelCommand {
  return command.type.startsWith("channel.");
}

export async function executeChannelCommand(
  dependencies: ChannelRuntimeDependencies,
  command: ChannelCommand,
): Promise<{ readonly sequence: number }> {
  const sequence =
    command.type === "channel.connect"
      ? await connectChannel(dependencies, command)
      : command.type === "channel.connection.save"
        ? await saveChannelConnection(dependencies, command)
        : command.type === "channel.connection.delete"
          ? await deleteChannelConnection(dependencies, command.connectionId)
          : command.type === "channel.attach"
            ? await attachChannelConnection(
                dependencies,
                command.botId,
                command.connectionId,
                command.provider,
              )
            : command.type === "channel.disconnect"
              ? await disconnectChannel(dependencies, command.botId, command.provider)
              : command.type === "channel.reconnect"
                ? await reconnectChannel(dependencies, command.botId, command.provider)
                : await sendChannelMessage(dependencies, command);
  return { sequence };
}
