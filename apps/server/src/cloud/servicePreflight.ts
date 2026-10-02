import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { flow } from "effect/Function";
import packageJson from "../../package.json" with { type: "json" };
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  /** Older servers always pass this flag when invoking a staged preflight. */
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;

  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason:
        "This release requires a newer Akeru Bot service launcher. Update it on the server machine.",
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

const PreflightResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    version: Schema.String,
    launcherProtocol: Schema.Literal(SERVICE_LAUNCHER_PROTOCOL),
  }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    version: Schema.String,
    reason: Schema.String,
  }),
]);

export const decodeServicePreflightResult = flow(
  Schema.decodeUnknownOption(PreflightResult),
  Option.getOrUndefined,
);
