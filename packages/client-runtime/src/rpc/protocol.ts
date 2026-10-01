import { WsRpcGroup } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";

export const wsRpcProtocolClient = RpcClient.make(WsRpcGroup);

export type WsRpcProtocolClient = Effect.Success<typeof wsRpcProtocolClient>;
