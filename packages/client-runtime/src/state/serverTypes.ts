import { type EnvironmentId, type McpServerId, WS_METHODS } from "@akeru/contracts";
import { type EnvironmentRpcInput } from "../rpc/client.ts";

export type ServerUpdateStage = "downloading" | "installing" | "resuming";

export type ServerUpdateState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly status: "failed";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
      readonly message: string;
    };

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.serverUpdateServer>;
}

export interface McpServerAuthenticationTarget {
  readonly environmentId: EnvironmentId;
  readonly mcpServerId: McpServerId;
  readonly onAuthorizationUrl: (url: string) => void | Promise<void>;
}
