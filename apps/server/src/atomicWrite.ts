import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";

export const writeFileStringAtomically = <E = never>(input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
  readonly durable?: boolean;
  /** Runs after the contents are staged, right before they replace the target. */
  readonly beforeReplace?: Effect.Effect<void, E>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(
        tempPath,
        input.contents,
        input.mode === undefined ? undefined : { mode: input.mode },
      );
      if (input.durable) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Windows only flushes handles opened with write access.
            const tempFile = yield* fs.open(tempPath, { flag: "r+" });
            yield* tempFile.sync;
          }),
        );
      }
      if (input.beforeReplace) yield* input.beforeReplace;
      yield* fs.rename(tempPath, input.filePath);
      if (input.durable && (yield* HostProcessPlatform) !== "win32") {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs.open(targetDirectory, { flag: "r" });
            yield* directory.sync;
          }),
        ).pipe(
          Effect.catch((error) => {
            const cause = "cause" in error.reason ? error.reason.cause : undefined;
            const code =
              typeof cause === "object" && cause !== null && "code" in cause
                ? cause.code
                : undefined;
            return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP"
              ? Effect.void
              : Effect.fail(error);
          }),
        );
      }
    }),
  );
