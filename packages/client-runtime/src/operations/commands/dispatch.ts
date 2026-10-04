import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { EnvironmentSupervisor } from "../../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];

export type CommandOf<T extends CommandType> = Extract<
  ClientOrchestrationCommand,
  { readonly type: T }
>;

type CommandInputFor<C extends ClientOrchestrationCommand> = C extends ClientOrchestrationCommand
  ? Omit<C, "type" | "commandId" | "createdAt"> & {
      readonly commandId?: CommandId;
    } & ("createdAt" extends keyof C
        ? {
            readonly createdAt?: C["createdAt"];
          }
        : {})
  : never;

export type CommandInput<T extends CommandType> = CommandInputFor<CommandOf<T>>;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;

export type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

export function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }

    const crypto = yield* Crypto.Crypto;

    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

export function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

export function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}
