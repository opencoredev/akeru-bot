import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { flow } from "effect/Function";
import type { ServerSelfUpdateOutcome } from "@akeru/contracts";

/** Protocol 2 snapshots SQLite before trials so migrations can be rolled back safely. */
export const SERVICE_LAUNCHER_PROTOCOL = 2;

export const SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";

export const SERVICE_LAUNCHER_FILE = "service-launcher.mjs";

export const SERVICE_STATE_FILE = "service-state.json";

/** Written by the launcher just before an explicit stop kills its child, so
    the child can tell "the service is going away" from "the launcher is about
    to start my replacement" while a pending update is recorded. */
export const SERVICE_STOP_MARKER_FILE = ".service-stopping";

export interface PendingServiceUpdate {
  readonly id: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly dbPath: string;
  readonly status: "pending";
}

export type ServiceUpdateRecord = PendingServiceUpdate | ServerSelfUpdateOutcome;

export interface ServiceState {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly activeVersion: string;
  readonly update?: ServiceUpdateRecord;
}

/** Context is copied from launcher-owned state when a child is spawned. */
export interface ServiceLauncherContext {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly childVersion: string;
  readonly update?: ServiceUpdateRecord;
}

export type ServiceLauncherChildMessage =
  | {
      readonly type: "request-update";
      readonly targetVersion: string;
      readonly dbPath: string;
    }
  | {
      readonly type: "prepared";
      readonly updateId: string;
    };

export type ServiceLauncherParentMessage =
  | {
      readonly type: "update-accepted";
      readonly updateId: string;
    }
  | {
      readonly type: "update-rejected";
      readonly reason: string;
    }
  | {
      readonly type: "committed";
      readonly updateId: string;
    };

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";

const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;

const EXACT_SERVICE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

/** Accepts exact SemVer only: never dist-tags or ranges passed to npm or filesystem paths. */
export const isExactServiceVersion = (version: string): boolean =>
  EXACT_SERVICE_VERSION.test(version);

const NonEmptyString = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""));

const ExactVersion = Schema.String.check(Schema.makeFilter(isExactServiceVersion));

const UpdateFields = {
  id: NonEmptyString,
  fromVersion: ExactVersion,
  targetVersion: ExactVersion,
};

const ServiceUpdateSchema = Schema.Union([
  Schema.Struct({ ...UpdateFields, status: Schema.Literal("pending"), dbPath: NonEmptyString }),
  Schema.Struct({
    ...UpdateFields,
    status: Schema.Literals(["committed", "rolled-back", "failed"]),
    reason: Schema.optional(Schema.UndefinedOr(NonEmptyString)),
  }),
]);

const ServiceStateSchema = Schema.Struct({
  protocol: Schema.Literal(SERVICE_LAUNCHER_PROTOCOL),
  activeVersion: ExactVersion,
  update: Schema.optional(Schema.UndefinedOr(ServiceUpdateSchema)),
});

const ContextSchema = Schema.Struct({
  protocol: Schema.Literal(SERVICE_LAUNCHER_PROTOCOL),
  childVersion: ExactVersion,
  update: Schema.optional(Schema.UndefinedOr(ServiceUpdateSchema)),
});

const decodeStateFields = Schema.decodeUnknownOption(ServiceStateSchema);

const decodeContextJson = Schema.decodeUnknownOption(Schema.fromJsonString(ContextSchema));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export const decodeServiceUpdate = flow(
  Schema.decodeUnknownOption(ServiceUpdateSchema),
  Option.getOrUndefined,
  normalizeUpdate,
);

function normalizeUpdate(
  update: typeof ServiceUpdateSchema.Type | undefined,
): ServiceUpdateRecord | undefined {
  if (update === undefined || update.status === "pending") return update;
  const { reason, ...fields } = update;

  return { ...fields, ...(reason === undefined ? {} : { reason }) };
}

/** SemVer precedence for exact versions. Build metadata is ignored. */
export function compareExactServiceVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const withoutBuild = version.split("+", 1)[0] ?? version;
    const separator = withoutBuild.indexOf("-");
    const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
    const [major = "0", minor = "0", patch = "0"] = core.split(".");

    return {
      core: [BigInt(major), BigInt(minor), BigInt(patch)] as const,
      prerelease: prerelease?.split(".") ?? [],
    };
  };

  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0n;
    const y = b.core[index] ?? 0n;

    if (x !== y) return x < y ? -1 : 1;
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }

  const count = Math.max(a.prerelease.length, b.prerelease.length);

  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];

    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;

    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);

    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;

    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;

    return x < y ? -1 : 1;
  }

  return 0;
}

export const decodeServiceState = flow(
  decodeStateFields,
  Option.getOrUndefined,
  (value): ServiceState | undefined => {
    if (value === undefined) return undefined;
    const update = normalizeUpdate(value.update);

    if (
      (update !== undefined &&
        compareExactServiceVersions(update.targetVersion, update.fromVersion) <= 0) ||
      (update?.status === "pending" && update.fromVersion !== value.activeVersion) ||
      (update?.status === "committed" && update.targetVersion !== value.activeVersion) ||
      ((update?.status === "rolled-back" || update?.status === "failed") &&
        update.fromVersion !== value.activeVersion)
    ) {
      return undefined;
    }

    return {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: value.activeVersion,
      ...(update === undefined ? {} : { update }),
    };
  },
);

export function parseServiceState(value: string): ServiceState | undefined {
  try {
    return decodeServiceState(decodeJson(value));
  } catch {
    return undefined;
  }
}

/** Detects an in-flight update across launcher protocol versions before replacing its state. */
export function serviceStateHasPendingUpdate(value: string): boolean {
  try {
    const parsed = decodeJson(value);

    return (
      isJsonObject(parsed) && isJsonObject(parsed.update) && parsed.update.status === "pending"
    );
  } catch {
    return false;
  }
}

export function decodeServiceLauncherContext(value: string): ServiceLauncherContext | undefined {
  const parsed = Option.getOrUndefined(decodeContextJson(value));

  if (parsed === undefined) return undefined;
  const update = normalizeUpdate(parsed.update);

  const selectedVersion =
    update?.status === "pending" || update?.status === "committed"
      ? update.targetVersion
      : update === undefined
        ? parsed.childVersion
        : update.fromVersion;

  if (parsed.childVersion !== selectedVersion) {
    return undefined;
  }

  return {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    childVersion: parsed.childVersion,
    ...(update === undefined ? {} : { update }),
  };
}

const ChildMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("request-update"),
    targetVersion: Schema.String,
    dbPath: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("prepared"), updateId: Schema.String }),
]);

const ParentMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("update-rejected"), reason: Schema.String }),
  Schema.Struct({ type: Schema.Literal("update-accepted"), updateId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("committed"), updateId: Schema.String }),
]);

export const decodeServiceLauncherChildMessage = flow(
  Schema.decodeUnknownOption(ChildMessageSchema),
  Option.getOrUndefined,
);

export const decodeServiceLauncherParentMessage = flow(
  Schema.decodeUnknownOption(ParentMessageSchema),
  Option.getOrUndefined,
);

function isJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
  return Predicate.isObject(value);
}
