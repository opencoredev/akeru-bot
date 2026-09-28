import { RemoteDoctorReport } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { resolveBaseDir } from "../os-jank.ts";
import {
  renderRemoteDoctor,
  runRemoteDoctor,
  writeRemoteSupportBundle,
} from "../remote/diagnostics.ts";

/**
 * Akeru Remote diagnostics read only Akeru's home: an explicit `--base-dir`, then `AKERU_HOME`,
 * then `~/.akeru`. An ambient `T3CODE_HOME` is ignored so T3 Code's `~/.t3` is never inspected
 * or repaired by accident.
 */
export const remoteDoctorHome = (
  baseDirFlag: Option.Option<string>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => Option.getOrUndefined(baseDirFlag) ?? env.AKERU_HOME;

export const remoteDoctorCommand = Command.make(
  "__remote-doctor",
  {
    json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    repair: Flag.boolean("repair").pipe(Flag.withDefault(false)),
    supportBundle: Flag.string("support-bundle").pipe(Flag.optional),
    baseDir: Flag.string("base-dir").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveBaseDir(remoteDoctorHome(flags.baseDir, process.env));
      const report = yield* Effect.sync(() => runRemoteDoctor({ baseDir, repair: flags.repair }));
      if (Option.isSome(flags.supportBundle)) {
        const bundlePath = Option.getOrThrow(flags.supportBundle);
        const platform = yield* HostProcessPlatform;
        const arch = yield* HostProcessArchitecture;
        yield* Effect.sync(() => writeRemoteSupportBundle(bundlePath, report, { platform, arch }));
      }
      const output = flags.json
        ? yield* Schema.encodeEffect(Schema.fromJsonString(RemoteDoctorReport))(report).pipe(
            Effect.orDie,
          )
        : renderRemoteDoctor(report);
      yield* Console.log(output);
    }),
).pipe(Command.withDescription("Run typed Akeru Remote diagnostics."));
