// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as Schema from "effect/Schema";

export const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Harness construction failed before it could serve any session. */
export class AkeruMastraHarnessError extends Schema.TaggedErrorClass<AkeruMastraHarnessError>()(
  "AkeruMastraHarnessError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Akeru harness ${this.operation} failed: ${errorMessage(this.cause)}`;
  }
}

/** Observational memory work was requested after the harness scope began closing. */
export class AkeruObservationQueueClosedError extends Schema.TaggedErrorClass<AkeruObservationQueueClosedError>()(
  "AkeruObservationQueueClosedError",
  {
    threadId: Schema.String,
    resourceId: Schema.String,
  },
) {
  override get message(): string {
    return "Akeru observational memory is closing.";
  }
}

/**
 * Restoring an observation snapshot failed. `cause` is always the original
 * restore failure; `rollbackCause` is set only when putting the prior records
 * back failed too, in which case `rolledBack` is false.
 */
export class AkeruObservationRestoreError extends Schema.TaggedErrorClass<AkeruObservationRestoreError>()(
  "AkeruObservationRestoreError",
  {
    threadId: Schema.String,
    resourceId: Schema.String,
    rolledBack: Schema.Boolean,
    cause: Schema.Defect(),
    rollbackCause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.rolledBack
      ? `Observation restore failed and the original observations were kept: ${errorMessage(this.cause)}`
      : `Observation restore failed and the original observations could not be restored: ${errorMessage(this.cause)}`;
  }
}

export const isObservationQueueClosed = Schema.is(AkeruObservationQueueClosedError);
