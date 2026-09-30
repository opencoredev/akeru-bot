import * as Schema from "effect/Schema";

export const RemoteDiagnosticStatus = Schema.Literals(["pass", "warning", "fail"]);
export type RemoteDiagnosticStatus = typeof RemoteDiagnosticStatus.Type;

export const RemoteDiagnosticCheck = Schema.Struct({
  id: Schema.String,
  status: RemoteDiagnosticStatus,
  message: Schema.String,
  repairable: Schema.Boolean,
  details: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type RemoteDiagnosticCheck = typeof RemoteDiagnosticCheck.Type;

export const RemoteDoctorReport = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: Schema.DateTimeUtcFromString,
  overall: RemoteDiagnosticStatus,
  checks: Schema.Array(RemoteDiagnosticCheck),
  repairsApplied: Schema.Array(Schema.String),
});
export type RemoteDoctorReport = typeof RemoteDoctorReport.Type;

/**
 * Doctor result for Settings > Connections. `applicable` is false when the environment is not an
 * Akeru Remote install (no service launcher and no container), in which case `report` is null.
 */
export const RemoteDoctorStatus = Schema.Struct({
  applicable: Schema.Boolean,
  report: Schema.NullOr(RemoteDoctorReport),
});
export type RemoteDoctorStatus = typeof RemoteDoctorStatus.Type;

export const RemoteDoctorRepairInput = Schema.Struct({
  checkIds: Schema.NonEmptyArray(Schema.String),
});
export type RemoteDoctorRepairInput = typeof RemoteDoctorRepairInput.Type;

export class RemoteDoctorError extends Schema.TaggedErrorClass<RemoteDoctorError>()(
  "RemoteDoctorError",
  {
    reason: Schema.Literals(["not-remote", "not-repairable", "doctor-failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Remote doctor failed (${this.reason}): ${this.detail}`;
  }
}
