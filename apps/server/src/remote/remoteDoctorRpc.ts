import {
  RemoteDoctorError,
  type RemoteDoctorRepairInput,
  type RemoteDoctorStatus,
} from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as Effect from "effect/Effect";

import { runRemoteDoctor } from "./diagnostics.ts";

const runDoctor = (baseDir: string, repair: false | ReadonlySet<string>) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    return yield* Effect.tryPromise({
      try: () => runRemoteDoctor({ baseDir, repair, platform }),
      catch: (cause) =>
        new RemoteDoctorError({
          reason: "doctor-failed",
          detail: "The remote doctor could not finish.",
          cause,
        }),
    });
  });

/** Reads the doctor report for Settings > Connections. Local environments report not applicable. */
export const getRemoteDoctorStatus = (input: {
  readonly baseDir: string;
  readonly remote: boolean;
}) =>
  input.remote
    ? runDoctor(input.baseDir, false).pipe(
        Effect.map((report): RemoteDoctorStatus => ({ applicable: true, report })),
      )
    : Effect.succeed<RemoteDoctorStatus>({ applicable: false, report: null });

/**
 * Repairs the named checks after the user asks for it. Every named check must currently be
 * repairable and not passing, so a stale client cannot trigger a repair nobody was offered.
 */
export const repairRemoteDoctor = Effect.fn("remote.doctor.repair")(function* (input: {
  readonly baseDir: string;
  readonly remote: boolean;
  readonly request: RemoteDoctorRepairInput;
}) {
  if (!input.remote) {
    return yield* new RemoteDoctorError({
      reason: "not-remote",
      detail: "This environment is not an Akeru Remote install.",
    });
  }
  const current = yield* runDoctor(input.baseDir, false);
  const offered = new Set(
    current.checks
      .filter((check) => check.repairable && check.status !== "pass")
      .map((check) => check.id),
  );
  const refused = input.request.checkIds.filter((id) => !offered.has(id));
  if (refused.length > 0) {
    return yield* new RemoteDoctorError({
      reason: "not-repairable",
      detail: `No repair is available for: ${refused.join(", ")}.`,
    });
  }
  const report = yield* runDoctor(input.baseDir, new Set(input.request.checkIds));
  return { applicable: true, report } satisfies RemoteDoctorStatus;
});
