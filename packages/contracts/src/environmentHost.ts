import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import {
  ExecutionEnvironmentPlatform,
  ExecutionEnvironmentPlatformArch,
  ExecutionEnvironmentPlatformOs,
} from "./environment.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Tools the server looks for on its own machine. Detection checks files on
 * PATH and known install locations; it never runs the tool.
 */
export const EnvironmentHostTool = Schema.Literals([
  "xcodebuild",
  "docker",
  "nvidia-smi",
  "git",
  "chrome",
  "chromium",
  "firefox",
  "safari",
  "edge",
]);

export type EnvironmentHostTool = typeof EnvironmentHostTool.Type;

/**
 * How often automatic placement should pick this environment. `manual-only`
 * keeps it out of automatic placement entirely; only a user's explicit choice
 * can send work there.
 */
export const EnvironmentPlacementWeight = Schema.Literals([
  "prefer",
  "normal",
  "less-often",
  "manual-only",
]);

export type EnvironmentPlacementWeight = typeof EnvironmentPlacementWeight.Type;

export const DEFAULT_ENVIRONMENT_PLACEMENT_WEIGHT: EnvironmentPlacementWeight = "normal";

export const ENVIRONMENT_HOST_LABEL_MAX_CHARS = 32;

export const ENVIRONMENT_HOST_LABELS_MAX = 12;

export const ENVIRONMENT_HOST_NOTE_MAX_CHARS = 280;

export const EnvironmentHostLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_HOST_LABEL_MAX_CHARS),
);

export type EnvironmentHostLabel = typeof EnvironmentHostLabel.Type;

const EnvironmentHostLabels = Schema.Array(EnvironmentHostLabel).check(
  Schema.isMaxLength(ENVIRONMENT_HOST_LABELS_MAX),
  Schema.isUnique(),
);

export const EnvironmentHostNote = TrimmedString.check(
  Schema.isMaxLength(ENVIRONMENT_HOST_NOTE_MAX_CHARS),
);

/**
 * The owner's description of an environment, stored in that environment's
 * server settings. An empty label list and an empty note mean "not described".
 */
export const EnvironmentHostProfile = Schema.Struct({
  labels: EnvironmentHostLabels.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  note: EnvironmentHostNote.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  placementWeight: EnvironmentPlacementWeight.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_PLACEMENT_WEIGHT)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export type EnvironmentHostProfile = typeof EnvironmentHostProfile.Type;

export const EnvironmentHostProfilePatch = Schema.Struct({
  labels: Schema.optionalKey(EnvironmentHostLabels),
  note: Schema.optionalKey(EnvironmentHostNote),
  placementWeight: Schema.optionalKey(EnvironmentPlacementWeight),
});

export type EnvironmentHostProfilePatch = typeof EnvironmentHostProfilePatch.Type;

/** The settings patch that removes the owner's labels and note. The weight is kept. */
export const CLEAR_ENVIRONMENT_HOST_DESCRIPTION_PATCH = {
  labels: [],
  note: "",
} as const satisfies EnvironmentHostProfilePatch;

/**
 * One reading of the machine's load. `cpuUtilization` is the busy share of all
 * cores, from 0 (idle) to 1 (saturated), measured over a short window.
 *
 * `sampleAgeMs` is how old the reading was when the server sent it, measured
 * on the server's own clock. It is a duration, not a timestamp, because the
 * server's and the client's clocks can disagree by minutes: a client adds the
 * time since it received the descriptor, on its own clock, to get the
 * reading's current age.
 */
export const EnvironmentHostLoad = Schema.Struct({
  cpuUtilization: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  availableMemoryBytes: NonNegativeInt,
  totalMemoryBytes: PositiveInt,
  sampleAgeMs: NonNegativeInt,
});

export type EnvironmentHostLoad = typeof EnvironmentHostLoad.Type;

export const EnvironmentHostProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  /** Enabled, installed, and signed in, so a turn can start on it now. */
  ready: Schema.Boolean,
});

export type EnvironmentHostProvider = typeof EnvironmentHostProvider.Type;

export const EnvironmentHostProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});

export type EnvironmentHostProject = typeof EnvironmentHostProject.Type;

/**
 * What one environment's machine can do right now. Served by that
 * environment's own server; clients collect one per connected environment
 * and hand them to placement.
 */
export const EnvironmentHostDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  cpuCount: PositiveInt,
  /** `null` when the server could not read load. Placement treats it as unknown. */
  load: Schema.NullOr(EnvironmentHostLoad),
  tools: Schema.Array(EnvironmentHostTool),
  providers: Schema.Array(EnvironmentHostProvider),
  projects: Schema.Array(EnvironmentHostProject),
  profile: EnvironmentHostProfile,
});

export type EnvironmentHostDescriptor = typeof EnvironmentHostDescriptor.Type;

/**
 * Hard requirements for where work may run. Every field that is present must
 * match. `project` matches a project title or the last segment of its root,
 * ignoring case, because the same repository usually lives at different paths
 * on different machines.
 */
export const EnvironmentHostRequirements = Schema.Struct({
  os: Schema.optionalKey(ExecutionEnvironmentPlatformOs),
  arch: Schema.optionalKey(ExecutionEnvironmentPlatformArch),
  tools: Schema.optionalKey(Schema.Array(EnvironmentHostTool)),
  labels: Schema.optionalKey(Schema.Array(EnvironmentHostLabel)),
  project: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});

export type EnvironmentHostRequirements = typeof EnvironmentHostRequirements.Type;
