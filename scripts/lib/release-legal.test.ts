import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { RELEASE_LEGAL_FILES, stageReleaseLegalFiles } from "./release-legal.ts";

it.effect("copies the complete release legal bundle", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-legal-source-" });
    const destination = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-legal-output-" });

    yield* fs.makeDirectory(path.join(repoRoot, "legal/licenses"), { recursive: true });
    yield* fs.writeFileString(path.join(repoRoot, "LICENSE"), "project license");
    yield* fs.writeFileString(path.join(repoRoot, "THIRD_PARTY_NOTICES.md"), "notices");
    yield* fs.writeFileString(path.join(repoRoot, "legal/licenses/MIT-example.txt"), "MIT");

    yield* stageReleaseLegalFiles({ repoRoot, destination });

    assert.deepStrictEqual(RELEASE_LEGAL_FILES, ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"]);
    assert.strictEqual(
      yield* fs.readFileString(path.join(destination, "LICENSE")),
      "project license",
    );
    assert.strictEqual(
      yield* fs.readFileString(path.join(destination, "THIRD_PARTY_NOTICES.md")),
      "notices",
    );
    assert.strictEqual(
      yield* fs.readFileString(path.join(destination, "licenses/MIT-example.txt")),
      "MIT",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
