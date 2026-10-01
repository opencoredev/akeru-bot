import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Semaphore from "effect/Semaphore";

export const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

export const DESKTOP_LOG_FILE_MAX_FILES = 10;

export interface RotatingLogFileWriter {
  readonly writeBytes: (chunk: Uint8Array) => Effect.Effect<void>;
  readonly writeText: (chunk: string) => Effect.Effect<void>;
}

export const textEncoder = new TextEncoder();

export class DesktopLogFileWriterConfigurationError extends Schema.TaggedErrorClass<DesktopLogFileWriterConfigurationError>()(
  "DesktopLogFileWriterConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    value: Schema.Number,
  },
) {
  override get message() {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

export type DesktopLogFileWriterError =
  | DesktopLogFileWriterConfigurationError
  | PlatformError.PlatformError;

export const refreshFileSize = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<number, never> =>
  fileSystem.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.orElseSucceed(() => 0),
  );

export const createRotatingLogFileWriter = Effect.fn("createRotatingLogFileWriter")(
  function* (input: {
    readonly filePath: string;
    readonly maxBytes?: number;
    readonly maxFiles?: number;
  }): Effect.fn.Return<
    RotatingLogFileWriter,
    DesktopLogFileWriterError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const maxBytes = input.maxBytes ?? DESKTOP_LOG_FILE_MAX_BYTES;
    const maxFiles = input.maxFiles ?? DESKTOP_LOG_FILE_MAX_FILES;
    const directory = path.dirname(input.filePath);
    const baseName = path.basename(input.filePath);

    if (maxBytes < 1) {
      return yield* new DesktopLogFileWriterConfigurationError({
        option: "maxBytes",
        value: maxBytes,
      });
    }
    if (maxFiles < 1) {
      return yield* new DesktopLogFileWriterConfigurationError({
        option: "maxFiles",
        value: maxFiles,
      });
    }

    yield* fileSystem.makeDirectory(directory, { recursive: true });

    const withSuffix = (index: number) => `${input.filePath}.${index}`;
    const currentSize = yield* Ref.make(yield* refreshFileSize(fileSystem, input.filePath));
    const mutex = yield* Semaphore.make(1);

    const pruneOverflowBackups = Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= maxFiles) continue;
        yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(Effect.ignore);
      }
    });

    const rotate = Effect.gen(function* () {
      yield* fileSystem.remove(withSuffix(maxFiles), { force: true }).pipe(Effect.ignore);
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const source = withSuffix(index);
        const sourceExists = yield* fileSystem
          .exists(source)
          .pipe(Effect.orElseSucceed(() => false));
        if (sourceExists) {
          yield* fileSystem.rename(source, withSuffix(index + 1));
        }
      }
      const currentExists = yield* fileSystem
        .exists(input.filePath)
        .pipe(Effect.orElseSucceed(() => false));
      if (currentExists) {
        yield* fileSystem.rename(input.filePath, withSuffix(1));
      }
      yield* Ref.set(currentSize, 0);
    }).pipe(
      Effect.catch(() =>
        refreshFileSize(fileSystem, input.filePath).pipe(
          Effect.flatMap((size) => Ref.set(currentSize, size)),
        ),
      ),
    );

    const writeBytes = (chunk: Uint8Array): Effect.Effect<void> => {
      if (chunk.byteLength === 0) return Effect.void;

      return mutex.withPermits(1)(
        Effect.gen(function* () {
          const beforeSize = yield* Ref.get(currentSize);
          if (beforeSize > 0 && beforeSize + chunk.byteLength > maxBytes) {
            yield* rotate;
          }

          yield* fileSystem.writeFile(input.filePath, chunk, { flag: "a" });
          const afterSize = (yield* Ref.get(currentSize)) + chunk.byteLength;
          yield* Ref.set(currentSize, afterSize);

          if (afterSize > maxBytes) {
            yield* rotate;
          }
        }).pipe(
          Effect.catch(() =>
            refreshFileSize(fileSystem, input.filePath).pipe(
              Effect.flatMap((size) => Ref.set(currentSize, size)),
            ),
          ),
        ),
      );
    };

    yield* pruneOverflowBackups;

    return {
      writeBytes,
      writeText: (chunk) => writeBytes(textEncoder.encode(chunk)),
    } satisfies RotatingLogFileWriter;
  },
);
