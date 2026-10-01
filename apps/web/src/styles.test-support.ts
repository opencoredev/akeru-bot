import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const readAppStyles = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const entry = yield* fileSystem.readFileString(
    decodeURIComponent(new URL("./index.css", import.meta.url).pathname),
  );

  let styles = entry;

  for (const match of entry.matchAll(/@import "(\.\/styles\/[^"]+)";/g)) {
    const imported = yield* fileSystem.readFileString(
      decodeURIComponent(new URL(match[1]!, import.meta.url).pathname),
    );

    styles = styles.replace(match[0], imported);
  }

  return styles;
});
