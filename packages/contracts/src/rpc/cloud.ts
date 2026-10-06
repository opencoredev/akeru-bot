import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { CloudLinkError, CloudLinkStatus } from "../cloud.ts";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { WS_METHODS } from "./methods.ts";

export const WsCloudGetStatusRpc = Rpc.make(WS_METHODS.cloudGetStatus, {
  payload: Schema.Struct({}),
  success: CloudLinkStatus,
  error: EnvironmentAuthorizationError,
});

export const WsCloudLinkStartRpc = Rpc.make(WS_METHODS.cloudLinkStart, {
  payload: Schema.Struct({}),
  success: CloudLinkStatus,
  error: Schema.Union([CloudLinkError, EnvironmentAuthorizationError]),
});

export const WsCloudLinkCancelRpc = Rpc.make(WS_METHODS.cloudLinkCancel, {
  payload: Schema.Struct({}),
  success: CloudLinkStatus,
  error: EnvironmentAuthorizationError,
});

export const WsCloudUnlinkRpc = Rpc.make(WS_METHODS.cloudUnlink, {
  payload: Schema.Struct({}),
  success: CloudLinkStatus,
  error: Schema.Union([CloudLinkError, EnvironmentAuthorizationError]),
});

export const WsSubscribeCloudStatusRpc = Rpc.make(WS_METHODS.subscribeCloudStatus, {
  payload: Schema.Struct({}),
  success: CloudLinkStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});
