import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const RELEASE_LEGAL_FILES = ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"] as const;

export const stageReleaseLegalFiles = Effect.fn("stageReleaseLegalFiles")(function* (input: {
  readonly repoRoot: string;
  readonly destination: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(input.destination, { recursive: true });
  yield* fs.copyFile(path.join(input.repoRoot, "LICENSE"), path.join(input.destination, "LICENSE"));
  yield* fs.copyFile(
    path.join(input.repoRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(input.destination, "THIRD_PARTY_NOTICES.md"),
  );
  yield* fs.copy(
    path.join(input.repoRoot, "legal/licenses"),
    path.join(input.destination, "licenses"),
  );
});
