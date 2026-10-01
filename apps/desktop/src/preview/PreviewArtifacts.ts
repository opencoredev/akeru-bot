import { clipboard, nativeImage, shell } from "electron";

import * as Effect from "effect/Effect";

import type * as FileSystem from "effect/FileSystem";

import type * as Path from "effect/Path";

import { PreviewOperationError, PreviewArtifactImageLoadError } from "./PreviewErrors.ts";
import type { createPreviewState } from "./PreviewState.ts";
import type { createPreviewFrameCapture } from "./PreviewFrameCapture.ts";
import { artifactSiteSlug } from "./PreviewModel.ts";

export const createPreviewArtifacts = ({
  requireWebContents,
  currentIso,
  currentMillis,
  attemptPromise,
  path,
  resolvedArtifactDirectory,
  fileSystem,
  startFrameCapture,
  stopFrameCapture,
  resolveArtifactPath,
  attempt,
}: {
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly currentIso: ReturnType<typeof createPreviewState>["currentIso"];
  readonly currentMillis: ReturnType<typeof createPreviewState>["currentMillis"];
  readonly attemptPromise: ReturnType<typeof createPreviewState>["attemptPromise"];
  readonly path: Path.Path;
  readonly resolvedArtifactDirectory: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly startFrameCapture: ReturnType<typeof createPreviewFrameCapture>["startFrameCapture"];
  readonly stopFrameCapture: ReturnType<typeof createPreviewFrameCapture>["stopFrameCapture"];
  readonly resolveArtifactPath: ReturnType<typeof createPreviewState>["resolveArtifactPath"];
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
}) => {
  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);

    const [createdAt, millis, image] = yield* Effect.all([
      currentIso,
      currentMillis,
      attemptPromise(
        {
          operation: "captureScreenshot.capturePage",
          tabId,
          webContentsId: wc.id,
        },
        () => wc.capturePage(),
      ),
    ]);

    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}`;
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`);
    const data = image.toPNG();
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.makeDirectory",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.writeFile",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );

    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: "image/png" as const,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (tabId: string) {
    yield* startFrameCapture(tabId, "recording");
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    yield* stopFrameCapture(tabId, "recording");
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const id = `browser-recording-${millis.toString(36)}`;
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.${extension}`);
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.makeDirectory",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.writeFile",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );

    return {
      id,
      tabId,
      path: artifactPath,
      mimeType,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const revealArtifact = Effect.fn("PreviewManager.revealArtifact")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    yield* attempt({ operation: "revealArtifact", artifactPath: resolvedPath }, () =>
      shell.showItemInFolder(resolvedPath),
    );
  });

  const copyArtifactToClipboard = Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);

    const image = yield* attempt(
      { operation: "copyArtifactToClipboard.load", artifactPath: resolvedPath },
      () => nativeImage.createFromPath(resolvedPath),
    );

    if (image.isEmpty()) {
      return yield* new PreviewArtifactImageLoadError({ artifactPath: resolvedPath });
    }

    yield* attempt({ operation: "copyArtifactToClipboard.write", artifactPath: resolvedPath }, () =>
      clipboard.writeImage(image),
    );
  });

  return {
    captureScreenshot,
    startRecording,
    stopRecording,
    saveRecording,
    revealArtifact,
    copyArtifactToClipboard,
  };
};
