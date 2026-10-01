import * as Deferred from "effect/Deferred";
import { type AcpParsedSessionEvent } from "./AcpRuntimeTypes.ts";

export interface AcpSessionEventStreamBarrier {
  readonly _tag: "EventStreamBarrier";
  readonly acknowledge: Deferred.Deferred<void>;
}

export type AcpSessionRuntimeEvent = AcpParsedSessionEvent | AcpSessionEventStreamBarrier;
