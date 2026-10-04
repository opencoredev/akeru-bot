import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import type { AkeruRuntimeSeam } from "../AkeruRuntimeSeam.ts";

export function makeBotWorkspaceIO(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  runPromise: AkeruRuntimeSeam["runPromise"],
) {
  return {
    path,
    readIdentity: (file: string) =>
      runPromise(
        fileSystem
          .readFileString(file)
          .pipe(
            Effect.catch((error) =>
              Predicate.isTagged(error.reason, "NotFound") ? Effect.void : Effect.fail(error),
            ),
          ),
      ),
    mkdir: (directory: string) =>
      runPromise(fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })),
    writeIdentity: (file: string, content: string) =>
      runPromise(fileSystem.writeFileString(file, content, { mode: 0o600 })),
    rename: (from: string, to: string) => runPromise(fileSystem.rename(from, to)),
    remove: (file: string, recursive = false) =>
      runPromise(fileSystem.remove(file, { recursive, force: true })),
  };
}

export type BotWorkspaceIO = ReturnType<typeof makeBotWorkspaceIO>;
