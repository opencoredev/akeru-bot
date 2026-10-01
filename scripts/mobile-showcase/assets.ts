// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodeFSP from "node:fs/promises";

import * as NodePath from "node:path";

import * as NodeProcess from "node:process";

import { PNG } from "pngjs";

import { type ShowcaseDevice, type ShowcaseStoreAssetSpec } from "../mobile-showcase.config.ts";

import { REPO_ROOT, type ShowcaseCapture } from "./paths.ts";

export interface PngMetadata {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly hasAlpha: boolean;
}

export function readPngMetadata(bytes: Uint8Array): PngMetadata {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 26 || !pngSignature.every((value, index) => bytes[index] === value)) {
    throw new Error("Captured file is not a valid PNG.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = view.getUint8(25);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: view.getUint8(24),
    colorType,
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

export function readPngDimensions(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  const { width, height } = readPngMetadata(bytes);
  return { width, height };
}

export function normalizeStorePng(bytes: Uint8Array): Buffer {
  const png = PNG.sync.read(Buffer.from(bytes));
  return PNG.sync.write(png, {
    bitDepth: 8,
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

export function validateStoreAsset(
  spec: ShowcaseStoreAssetSpec,
  bytes: Uint8Array,
  label = "Screenshot",
): PngMetadata {
  const metadata = readPngMetadata(bytes);
  if (metadata.width !== spec.width || metadata.height !== spec.height) {
    throw new Error(
      `${label} is ${metadata.width}×${metadata.height}; ${spec.store} requires ${spec.width}×${spec.height}.`,
    );
  }
  if (metadata.bitDepth !== 8 || metadata.colorType !== 2 || metadata.hasAlpha) {
    throw new Error(
      `${label} must be an 8-bit, 24-bit RGB PNG without alpha (found bit depth ${metadata.bitDepth}, color type ${metadata.colorType}).`,
    );
  }
  if (spec.maximumFileSizeBytes && bytes.byteLength > spec.maximumFileSizeBytes) {
    throw new Error(
      `${label} is ${bytes.byteLength} bytes; ${spec.store} allows at most ${spec.maximumFileSizeBytes} bytes.`,
    );
  }
  if (spec.store === "google-play") {
    const shortestSide = Math.min(metadata.width, metadata.height);
    const longestSide = Math.max(metadata.width, metadata.height);
    if (shortestSide < 320 || longestSide > 3_840 || longestSide > shortestSide * 2) {
      throw new Error(
        `${label} does not meet Google Play's 320–3,840 px bounds and 2:1 maximum aspect ratio.`,
      );
    }
    if (metadata.width * 16 !== metadata.height * 9) {
      throw new Error(`${label} must use Google Play's recommended portrait 9:16 aspect ratio.`);
    }
  }
  return metadata;
}

export function validateStoreAssetCount(
  spec: ShowcaseStoreAssetSpec,
  count: number,
  requireMinimum: boolean,
): void {
  if (count > spec.maximumUploadCount) {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} allows at most ${spec.maximumUploadCount}.`,
    );
  }
  if (requireMinimum && count < spec.minimumUploadCount) {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} requires at least ${spec.minimumUploadCount}.`,
    );
  }
}

export function showcaseCaptureDirectory(
  outputDirectory: string,
  capture: Pick<ShowcaseCapture, "device" | "appearance" | "theme">,
): string {
  // Each palette owns a leaf folder so one upload slot never mixes themes and
  // every folder keeps a store-legal screenshot count of its own.
  return NodePath.join(
    outputDirectory,
    capture.device.storeAsset.directory,
    capture.appearance,
    capture.theme,
  );
}

export async function finalizeCapture(destination: string, device: ShowcaseDevice): Promise<void> {
  const normalized = normalizeStorePng(await NodeFSP.readFile(destination));
  await NodeFSP.writeFile(destination, normalized);
  const metadata = validateStoreAsset(
    device.storeAsset,
    normalized,
    NodePath.basename(destination),
  );
  NodeProcess.stdout.write(
    `Captured ${NodePath.relative(REPO_ROOT, destination)} (${metadata.width}×${metadata.height}, 24-bit RGB, validated for ${device.storeAsset.store})\n`,
  );
}

export async function validateCaptureSet(
  capture: ShowcaseCapture,
  outputDirectory: string,
  requireMinimum: boolean,
): Promise<void> {
  const directory = showcaseCaptureDirectory(outputDirectory, capture);
  const files = (await NodeFSP.readdir(directory)).filter((file) => file.endsWith(".png")).sort();
  const expectedFiles = capture.scenes.map((scene) => `${scene}.png`).sort();
  const missingFiles = expectedFiles.filter((file) => !files.includes(file));
  if (missingFiles.length > 0) {
    throw new Error(`${capture.device.id} is missing ${missingFiles.join(", ")} in ${directory}.`);
  }
  validateStoreAssetCount(capture.device.storeAsset, files.length, requireMinimum);
  for (const file of files) {
    const bytes = await NodeFSP.readFile(NodePath.join(directory, file));
    validateStoreAsset(capture.device.storeAsset, bytes, `${capture.device.id}/${file}`);
  }
  NodeProcess.stdout.write(
    `Validated ${files.length} upload-ready ${capture.device.storeAsset.store} screenshots in ${NodePath.relative(REPO_ROOT, directory)}/\n`,
  );
}
