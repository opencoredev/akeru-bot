import { OrchestrationDispatchCommandError } from "@akeru/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(cause: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(cause) && cause.bootstrapThreadDisposition === "deleted"
  );
}
