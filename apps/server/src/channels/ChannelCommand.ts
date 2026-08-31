import type { ClientOrchestrationCommand } from "@t3tools/contracts";

import {
  connectChannel,
  disconnectChannel,
  reconnectChannel,
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
      : command.type === "channel.disconnect"
        ? await disconnectChannel(dependencies, command.botId, command.provider)
        : command.type === "channel.reconnect"
          ? await reconnectChannel(dependencies, command.botId, command.provider)
          : await sendChannelMessage(dependencies, command);
  return { sequence };
}
