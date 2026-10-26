import { WS_METHODS } from "@akeru/contracts";
import type { WsConnection } from "./wsConnection.ts";

export const createWsCloudHandlers = ({
  cloudAccount,
  cloudConnection,
  observeRpcEffect,
  observeRpcStream,
}: Pick<
  WsConnection,
  "cloudAccount" | "cloudConnection" | "observeRpcEffect" | "observeRpcStream"
>) => ({
  [WS_METHODS.cloudGetStatus]: () =>
    observeRpcEffect(WS_METHODS.cloudGetStatus, cloudAccount.getStatus, {
      "rpc.aggregate": "cloud",
    }),
  [WS_METHODS.cloudLinkStart]: () =>
    observeRpcEffect(WS_METHODS.cloudLinkStart, cloudAccount.link, { "rpc.aggregate": "cloud" }),
  [WS_METHODS.cloudLinkCancel]: () =>
    observeRpcEffect(WS_METHODS.cloudLinkCancel, cloudAccount.cancelLink, {
      "rpc.aggregate": "cloud",
    }),
  [WS_METHODS.cloudForget]: () =>
    observeRpcEffect(WS_METHODS.cloudForget, cloudAccount.unlink, { "rpc.aggregate": "cloud" }),
  [WS_METHODS.cloudUnlink]: () =>
    observeRpcEffect(WS_METHODS.cloudUnlink, cloudConnection.unlink, { "rpc.aggregate": "cloud" }),
  [WS_METHODS.subscribeCloudStatus]: () =>
    observeRpcStream(WS_METHODS.subscribeCloudStatus, cloudAccount.streamStatus, {
      "rpc.aggregate": "cloud",
    }),
});
