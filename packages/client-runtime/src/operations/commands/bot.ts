import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  commandId,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type CreateBotInput = CommandInput<"bot.create">;

export type UpdateBotInput = CommandInput<"bot.update">;

export type ArchiveBotInput = CommandInput<"bot.archive">;

export type RestoreBotInput = CommandInput<"bot.restore">;

export type DeleteBotInput = CommandInput<"bot.delete">;

export type ConnectChannelInput = CommandInput<"channel.connect">;

export type SaveChannelConnectionInput = CommandInput<"channel.connection.save">;

export type DeleteChannelConnectionInput = CommandInput<"channel.connection.delete">;

export type AttachChannelInput = CommandInput<"channel.attach">;

export type DisconnectChannelInput = CommandInput<"channel.disconnect">;

export type DetachChannelInput = CommandInput<"channel.detach">;

export type ReconnectChannelInput = CommandInput<"channel.reconnect">;

export type SendChannelMessageInput = CommandInput<"channel.send">;

export const createBot: (input: CreateBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createBot",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "bot.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateBot: (input: UpdateBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.update",
    commandId: yield* commandId(input),
  });
});

export const archiveBot: (input: ArchiveBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.archive",
    commandId: yield* commandId(input),
  });
});

export const restoreBot: (input: RestoreBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.restoreBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.restore",
    commandId: yield* commandId(input),
  });
});

export const deleteBot: (input: DeleteBotInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteBot",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "bot.delete",
    commandId: yield* commandId(input),
  });
});

export const connectChannel: (input: ConnectChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.connectChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.connect",
    commandId: yield* commandId(input),
  });
});

export const saveChannelConnection: (input: SaveChannelConnectionInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.saveChannelConnection")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "channel.connection.save",
      commandId: yield* commandId(input),
    });
  });

export const deleteChannelConnection: (input: DeleteChannelConnectionInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.deleteChannelConnection")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "channel.connection.delete",
      commandId: yield* commandId(input),
    });
  });

export const attachChannel: (input: AttachChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.attachChannel",
)(function* (input) {
  return yield* dispatch({ ...input, type: "channel.attach", commandId: yield* commandId(input) });
});

export const disconnectChannel: (input: DisconnectChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.disconnectChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.disconnect",
    commandId: yield* commandId(input),
  });
});

export const detachChannel: (input: DetachChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.detachChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.detach",
    commandId: yield* commandId(input),
  });
});

export const reconnectChannel: (input: ReconnectChannelInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reconnectChannel",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.reconnect",
    commandId: yield* commandId(input),
  });
});

export const sendChannelMessage: (input: SendChannelMessageInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.sendChannelMessage",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "channel.send",
    commandId: yield* commandId(input),
  });
});
