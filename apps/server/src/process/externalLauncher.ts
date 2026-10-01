import {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  type EditorId,
  type FileManagerRevealKind,
  type LaunchEditorInput,
} from "@akeru/contracts";
import { isCommandAvailable, resolveSpawnCommand } from "@akeru/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  type EditorLaunch,
  type ProcessLaunch,
  readCommandLookupEnv,
  EDITOR_DISCOVERY_CACHE_TTL_NANOS,
  type EditorDiscoveryCacheEntry,
} from "./externalLauncherTypes.ts";
import { resolveBrowserLaunch } from "./browserLauncher.ts";
import { resolveAvailableEditors, resolveEditorLaunch } from "./editorLauncher.ts";
import { resolveFileManagerRevealKind } from "./fileManagerLauncher.ts";
/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    /**
     * Reveal kind for the host, or undefined when the executable a reveal
     * actually spawns is unavailable. Only meaningful when
     * `resolveAvailableEditors` includes "file-manager": on Linux that
     * availability check also carries the directory-handler probe this
     * capability relies on.
     */
    readonly resolveFileManagerRevealKind: () => Effect.Effect<FileManagerRevealKind | undefined>;
    /** Launch a URL target in the default browser. */
    readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;
    /**
     * Launch a workspace path in a selected editor integration.
     *
     * Launches the editor as a detached process so server startup is not blocked.
     */
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()("akeru-bot/process/externalLauncher") {}

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  onError: (cause: unknown) => ExternalLauncherError,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(onError),
  );
});

const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const launch = yield* resolveBrowserLaunch(target);
  return yield* launchAndUnref(
    launch,
    (cause) =>
      new ExternalLauncherBrowserSpawnError({
        target,
        command: launch.command,
        args: launch.args,
        cause,
      }),
  );
});

const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const env = yield* readCommandLookupEnv;
  if (!(yield* isCommandAvailable(launch.command, { env }))) {
    return yield* new ExternalLauncherCommandNotFoundError({
      editor: launch.editor,
      command: launch.command,
    });
  }

  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, { env });
  yield* launchAndUnref(
    {
      command: spawnCommand.command,
      args: spawnCommand.args,
      options: {
        detached: true,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    },
    (cause) =>
      new ExternalLauncherEditorSpawnError({
        editor: launch.editor,
        target: launch.target,
        command: spawnCommand.command,
        args: spawnCommand.args,
        cause,
      }),
  );
});

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const provideCommandResolutionServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const editorDiscoveryCache = yield* Ref.make<Option.Option<EditorDiscoveryCacheEntry>>(
    Option.none(),
  );
  const cachedAvailableEditors = Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos;
    const entry = yield* Ref.get(editorDiscoveryCache);
    if (Option.isSome(entry) && entry.value.expiresAtNanos > nowNanos) {
      return entry.value.editors;
    }
    const editors = yield* provideCommandResolutionServices(resolveAvailableEditors()).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    yield* Ref.set(
      editorDiscoveryCache,
      Option.some({
        editors,
        expiresAtNanos: nowNanos + EDITOR_DISCOVERY_CACHE_TTL_NANOS,
      }),
    );
    return editors;
  });

  return ExternalLauncher.of({
    resolveAvailableEditors: () => cachedAvailableEditors,
    resolveFileManagerRevealKind: () =>
      provideCommandResolutionServices(resolveFileManagerRevealKind()).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      provideCommandResolutionServices(
        Effect.flatMap(resolveEditorLaunch(input), launchEditorProcess),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
export { buildFileExplorerRevealPowerShellSource } from "./fileManagerLauncher.ts";

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@akeru/contracts";
export type { LaunchEditorInput };
