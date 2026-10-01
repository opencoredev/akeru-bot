import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  type EditorId,
  type LaunchEditorInput,
} from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  type EditorLaunch,
  type TargetPathAndPosition,
  TARGET_WITH_POSITION_PATTERN,
  readBrowserLaunchEnv,
  readCommandLookupEnv,
} from "./externalLauncherTypes.ts";
import { resolveAvailableCommand } from "./browserLauncher.ts";
import {
  resolveUsableFileManagerCommand,
  resolveWslFileManagerPath,
  resolveFileManagerRevealLaunch,
} from "./fileManagerLauncher.ts";

export function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);

  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

export function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

export function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];

  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

export const buildAvailableEditors = Effect.fn("externalLauncher.buildAvailableEditors")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<EditorId>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      if ((yield* resolveUsableFileManagerCommand(platform, env)) !== undefined) {
        available.push(editor.id);
      }

      continue;
    }

    const command = yield* resolveAvailableCommand(editor.commands, env);

    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
});

export const resolveAvailableEditors = Effect.fn("externalLauncher.resolveAvailableEditors")(
  function* () {
    const platform = yield* HostProcessPlatform;
    const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };

    return yield* buildAvailableEditors(platform, env);
  },
);

export // ==============================
// Implementations
// ==============================

const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<
  EditorLaunch,
  ExternalLauncherError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const platform = yield* HostProcessPlatform;
  const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);

  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      yield* resolveAvailableCommand(editorDef.commands, env),
      () => editorDef.commands[0],
    );

    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  const command = yield* resolveUsableFileManagerCommand(platform, env);

  if (command === undefined) {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  if (input.reveal === true) {
    return yield* resolveFileManagerRevealLaunch(input.cwd, platform, env, command);
  }

  return {
    editor: editorDef.id,
    target: input.cwd,
    command,
    args:
      command === "explorer.exe" && env.WSL_DISTRO_NAME !== undefined
        ? [resolveWslFileManagerPath(input.cwd, env.WSL_DISTRO_NAME)]
        : [input.cwd],
  };
});
