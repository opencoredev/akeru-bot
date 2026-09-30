import {
  type ConnectionFailureCode,
  type EnvironmentConnectionPhase,
} from "@akeru/client-runtime/connection";
import { EnvironmentId, ThreadId, type ServerConfig } from "@akeru/contracts";

export interface EnvironmentRuntimeState {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorCode: ConnectionFailureCode | null;
  readonly connectionErrorTraceId: string | null;
  readonly serverConfig: ServerConfig | null;
}

export interface ConnectedEnvironmentSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorCode: ConnectionFailureCode | null;
  readonly connectionErrorTraceId: string | null;
}

export interface SelectedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
