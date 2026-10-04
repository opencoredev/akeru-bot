import * as Schema from "effect/Schema";
import { OrchestrationThreadDetailSnapshot } from "./readModel.ts";
import { OrchestrationEvent } from "./events.ts";

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);

export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;
