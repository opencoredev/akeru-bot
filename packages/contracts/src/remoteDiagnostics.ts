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
