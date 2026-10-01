#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodeChildProcess from "node:child_process";

import * as NodeFSP from "node:fs/promises";

import * as NodeOS from "node:os";

import * as NodePath from "node:path";

import * as NodeProcess from "node:process";

import showcaseConfig, {
  type ShowcaseAndroidDevice,
  type ShowcaseIosDevice,
} from "./mobile-showcase.config.ts";

import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_PROJECTS,
  seedShowcaseEnvironment,
} from "./mobile-showcase-environment.ts";

import {
  REPO_ROOT,
  IOS_APP_PATH,
  ANDROID_APK_PATH,
  type ShowcaseCapture,
  type IosCaptureCleanup,
  type AndroidCaptureCleanup,
} from "./lib/mobile-showcase/paths.ts";

import {
  readPngDimensions,
  showcaseCaptureDirectory,
  validateCaptureSet,
} from "./lib/mobile-showcase/assets.ts";

import {
  parseShowcaseCliArgs,
  planShowcaseCaptures,
  printUsage,
} from "./lib/mobile-showcase/options.ts";

import {
  runCommand,
  stopProcess,
  waitForPort,
  waitForFileContent,
  reserveAvailablePort,
  existingArtifact,
} from "./lib/mobile-showcase/process.ts";

import {
  lanIpv4Address,
  createShowcaseShell,
  createShowcaseLabelProbe,
  startShowcaseServer,
  issuePairingCredential,
  buildShowcasePairingUrl,
  encodeAndroidPairingUrls,
  startMetro,
  warmMetroBundle,
} from "./lib/mobile-showcase/environment.ts";

import { buildIos, captureIos } from "./lib/mobile-showcase/ios.ts";

import {
  buildAndroid,
  runAdb,
  captureAndroid,
  cleanupAndroidViewport,
} from "./lib/mobile-showcase/android.ts";

export {
  selectLanIpv4Address,
  parsePairingCredentialOutput,
  showcaseSceneUrl,
  encodeAndroidPairingUrls,
} from "./lib/mobile-showcase/environment.ts";

export { parseShowcaseCliArgs, planShowcaseCaptures } from "./lib/mobile-showcase/options.ts";

export {
  type PngMetadata,
  readPngMetadata,
  readPngDimensions,
  normalizeStorePng,
  validateStoreAsset,
  validateStoreAssetCount,
  showcaseCaptureDirectory,
} from "./lib/mobile-showcase/assets.ts";

export { resolveAndroidSdkRoot, type ShowcaseCapture } from "./lib/mobile-showcase/paths.ts";

async function main(): Promise<void> {
  const options = parseShowcaseCliArgs(NodeProcess.argv.slice(2));
  if (options.list) {
    printUsage(showcaseConfig);
    return;
  }
  const captures = planShowcaseCaptures(showcaseConfig, options);
  const outputDirectory = NodePath.resolve(REPO_ROOT, showcaseConfig.outputDirectory);
  if (options.validateOnly) {
    for (const capture of captures) {
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      );
    }
    return;
  }
  const hasIos = captures.some((capture) => capture.device.platform === "ios");
  const hasAndroid = captures.some((capture) => capture.device.platform === "android");
  const metroHost = hasIos ? lanIpv4Address() : "127.0.0.1";
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  for (const capture of captures) {
    const directory = showcaseCaptureDirectory(outputDirectory, capture);
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await NodeFSP.mkdir(directory, { recursive: true });
  }

  const showcaseRootDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-mobile-showcase-"),
  );
  const showcaseServers: NodeChildProcess.ChildProcess[] = [];
  const showcaseEnvironments: Array<{
    readonly baseDir: string;
    readonly environmentId: string;
    readonly label: string;
    readonly port: number;
  }> = [];
  let metro: NodeChildProcess.ChildProcess | null = null;
  const iosCleanups: IosCaptureCleanup[] = [];
  const androidCleanups: AndroidCaptureCleanup[] = [];

  try {
    for (const environment of SHOWCASE_ENVIRONMENTS) {
      const projectId = environment.projectIds[0];
      const project = SHOWCASE_PROJECTS.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Showcase environment '${environment.id}' has no project.`);

      const baseDir = NodePath.join(showcaseRootDir, "environments", environment.id);
      const workspaceRoot = NodePath.join(baseDir, "workspace", project.directory);
      const port = await reserveAvailablePort();
      await NodeFSP.mkdir(workspaceRoot, { recursive: true });
      const shellPath = await createShowcaseShell(baseDir);
      const labelProbeDirectory = await createShowcaseLabelProbe(baseDir, environment.label);
      const server = startShowcaseServer(
        baseDir,
        workspaceRoot,
        port,
        shellPath,
        labelProbeDirectory,
      );
      showcaseServers.push(server);
      await waitForPort(port, `${environment.label} server`);
      await seedShowcaseEnvironment({ baseDir, projectIds: environment.projectIds });
      // The server begins listening before the ServerEnvironment layer
      // persists the environment id, so poll rather than read once.
      const environmentId = await waitForFileContent(
        NodePath.join(baseDir, "userdata", "environment-id"),
        `${environment.label} environment id`,
      );
      showcaseEnvironments.push({ baseDir, environmentId, label: environment.label, port });
    }

    if (!options.skipMetro) {
      metro = startMetro(showcaseConfig);
      await waitForPort(showcaseConfig.metroPort, "Metro");
      await Promise.all([
        hasIos ? warmMetroBundle("ios", metroHost, showcaseConfig) : Promise.resolve(),
        hasAndroid ? warmMetroBundle("android", "127.0.0.1", showcaseConfig) : Promise.resolve(),
      ]);
    }

    const iosAppPath = hasIos
      ? options.skipBuild
        ? await existingArtifact(IOS_APP_PATH)
        : await buildIos()
      : null;
    const androidAbis = captures.flatMap((capture) =>
      capture.device.platform === "android" && capture.device.abi ? [capture.device.abi] : [],
    );
    const androidApkPath = hasAndroid
      ? options.skipBuild
        ? await existingArtifact(ANDROID_APK_PATH)
        : await buildAndroid([...new Set(androidAbis)])
      : null;

    for (const capture of captures) {
      const pairingHost = capture.device.platform === "ios" ? "127.0.0.1" : "10.0.2.2";
      const pairingUrls = await Promise.all(
        showcaseEnvironments.map(async (environment) => {
          const credential = await issuePairingCredential(environment.baseDir);
          return buildShowcasePairingUrl(pairingHost, environment.port, credential);
        }),
      );
      if (capture.device.platform === "ios") {
        await captureIos(
          capture as ShowcaseCapture & { readonly device: ShowcaseIosDevice },
          iosAppPath,
          outputDirectory,
          showcaseConfig,
          metroHost,
          pairingUrls,
          (cleanup) => iosCleanups.push(cleanup),
        );
      } else {
        await captureAndroid(
          capture as ShowcaseCapture & { readonly device: ShowcaseAndroidDevice },
          androidApkPath,
          outputDirectory,
          showcaseConfig,
          pairingUrls,
          (cleanup) => androidCleanups.push(cleanup),
        );
      }
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      );
    }

    NodeProcess.stdout.write(
      `\nDone. Upload-ready screenshots are in ${NodePath.relative(REPO_ROOT, outputDirectory)}/apple/ and ${NodePath.relative(REPO_ROOT, outputDirectory)}/google-play/.\n`,
    );
    if (options.keepRunning) {
      const serverSummary = showcaseEnvironments
        .map((environment) => `${environment.label}:${environment.port}`)
        .join(", ");
      NodeProcess.stdout.write(
        `Showcase environments kept at ${showcaseRootDir} (${serverSummary}).\n`,
      );
    }
  } finally {
    if (options.keepRunning) {
      metro?.unref();
      for (const server of showcaseServers) server.unref();
    } else {
      for (const cleanup of androidCleanups) {
        await cleanupAndroidViewport(cleanup.device, cleanup.serial).catch(() => undefined);
        if (cleanup.startedByRunner) {
          await runAdb(cleanup.serial, ["emu", "kill"]).catch(() => undefined);
        }
      }
      for (const cleanup of iosCleanups) {
        if (cleanup.startedByRunner || cleanup.createdByRunner) {
          await runCommand("xcrun", ["simctl", "shutdown", cleanup.udid]).catch(() => undefined);
        }
        if (cleanup.createdByRunner) {
          await runCommand("xcrun", ["simctl", "delete", cleanup.udid]).catch(() => undefined);
        }
      }
      await Promise.all([
        ...(metro ? [stopProcess(metro)] : []),
        ...showcaseServers.map((server) => stopProcess(server)),
      ]);
      await NodeFSP.rm(showcaseRootDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    // Stack over message: the harness only fails in CI, where the line that
    // threw is the whole diagnosis and there is nobody at a terminal to
    // re-run it with more output.
    NodeProcess.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    NodeProcess.exit(1);
  });
}
