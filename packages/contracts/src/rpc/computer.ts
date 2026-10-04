import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import {
  ComputerTarget,
  ComputerSessionInput,
  ComputerInput,
  ComputerState,
  ComputerSession,
  ComputerEvent,
} from "../computer.ts";
import { WS_METHODS } from "./methods.ts";
import { computerError } from "./server.ts";

export const WsComputerGetStateRpc = Rpc.make(WS_METHODS.computerGetState, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});

export const WsComputerOpenRpc = Rpc.make(WS_METHODS.computerOpen, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});

export const WsComputerAcquireRpc = Rpc.make(WS_METHODS.computerAcquire, {
  payload: ComputerTarget,
  success: ComputerSession,
  error: computerError,
});

export const WsComputerInputRpc = Rpc.make(WS_METHODS.computerInput, {
  payload: ComputerInput,
  success: Schema.Void,
  error: computerError,
});

export const WsComputerReleaseRpc = Rpc.make(WS_METHODS.computerRelease, {
  payload: ComputerSessionInput,
  success: ComputerState,
  error: computerError,
});

export const WsComputerCloseRpc = Rpc.make(WS_METHODS.computerClose, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});

export const WsComputerStopRpc = Rpc.make(WS_METHODS.computerStop, {
  payload: ComputerTarget,
  success: ComputerState,
  error: computerError,
});

export const WsComputerEventsRpc = Rpc.make(WS_METHODS.computerEvents, {
  payload: ComputerTarget,
  success: ComputerEvent,
  error: computerError,
  stream: true,
});
