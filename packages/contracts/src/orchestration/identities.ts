import * as Schema from "effect/Schema";
import { CommandId, TrimmedNonEmptyString } from "../baseSchemas.ts";

// Keep this schema local to avoid evaluating the delegation module's
// orchestration import while defining the orchestration contracts.
export const DelegationIdSchema = TrimmedNonEmptyString.pipe(Schema.brand("DelegationId"));

// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;

export type CorrelationId = typeof CorrelationId.Type;
