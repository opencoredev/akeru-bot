import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeBotWorkspaceIO } from "../workspace/BotWorkspaceIO.ts";

export const workspaceIO = makeBotWorkspaceIO(
  Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer))),
  Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer))),
  Effect.runPromise,
);
