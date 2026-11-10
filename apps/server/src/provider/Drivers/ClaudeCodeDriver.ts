/**
 * ClaudeCodeDriver — Claude through the user's own Claude Code login.
 *
 * Turns run through the Claude Agent SDK, which starts the installed `claude`
 * program; that program uses the login from `claude auth login`. Akeru never
 * reads or forwards a Claude credential. The instance uses the native
 * ClaudeAdapter on the legacy bridge, not the Mastra controller, because the
 * login only works inside Claude Code.
 *
 * @module provider/Drivers/ClaudeCodeDriver
 */
import * as NodeCrypto from "node:crypto";
import { ClaudeSettings, type ServerProvider } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  CLAUDE_CODE_DRIVER_KIND,
  claudeCodeProviderDraft,
  probeClaudeCodeLogin,
} from "../claudeCode/ClaudeCodeLogin.ts";
import {
  claudeCodeAdapterOptions,
  claudeCodeAssignedConfigDirectory,
  claudeCodeInstanceEnvironment,
} from "../claudeCode/ClaudeCodeSession.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  packageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  providerSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { isClaudeNativeCommandPath } from "./ClaudeDriver.ts";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const UPDATE = packageManagedProviderMaintenanceResolver({
  provider: CLAUDE_CODE_DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

/**
 * Chats that can continue each other share one Claude Code config folder. The snapshot reaches
 * remote clients, so the key names the folder by digest, never by path.
 */
export const claudeCodeContinuationKey = (configDirectory: string) =>
  `claude-code:home:${NodeCrypto.createHash("sha256").update(configDirectory).digest("hex").slice(0, 32)}`;

export type ClaudeCodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const ClaudeCodeDriver: ProviderDriver<ClaudeSettings, ClaudeCodeDriverEnv> = {
  driverKind: CLAUDE_CODE_DRIVER_KIND,
  metadata: {
    displayName: "Claude Agent",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;

      const serverConfig = yield* ServerConfig;

      // The instance's own CLAUDE_CONFIG_DIR keeps a second login apart. A
      // separate account that names no folder gets one under Akeru's state.
      const assignedConfigDirectory = yield* claudeCodeAssignedConfigDirectory(
        instanceId,
        serverConfig.stateDir,
      );

      const {
        command,
        executable,
        configDirectory,
        publishedConfigDirectory,
        environment: loginEnvironment,
      } = yield* claudeCodeInstanceEnvironment(
        effectiveConfig,
        environment,
        process.env,
        assignedConfigDirectory,
      );

      if (configDirectory !== undefined && configDirectory === assignedConfigDirectory) {
        yield* fileSystem.makeDirectory(configDirectory, { recursive: true, mode: 0o700 }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: CLAUDE_CODE_DRIVER_KIND,
                instanceId,
                detail: `Failed to create the Claude Code config folder for this account: ${cause.message}`,
                cause,
              }),
          ),
        );
      }

      const { options: adapterOptions } = yield* claudeCodeAdapterOptions({
        instanceId,
        command,
        loginEnvironment,
      });

      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: command,
        env: loginEnvironment,
      });

      const continuationIdentity = {
        ...defaultProviderContinuationIdentity({ driverKind: CLAUDE_CODE_DRIVER_KIND, instanceId }),
        continuationKey: claudeCodeContinuationKey(
          configDirectory ?? (yield* resolveClaudeHomePath({ homePath: "" })),
        ),
      };

      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: CLAUDE_CODE_DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        // Clients quote these in the login command, so it names the same program and folder.
        ...(executable ? { executable } : {}),
        ...(publishedConfigDirectory ? { configDirectory: publishedConfigDirectory } : {}),
      });

      const adapter = yield* makeClaudeAdapter(
        // The adapter sees the one normalized config folder, never a relative path.
        { ...effectiveConfig, binaryPath: command, homePath: configDirectory ?? "" },
        {
          ...adapterOptions,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );

      const checkProvider = (
        enabled
          ? probeClaudeCodeLogin(command, loginEnvironment).pipe(
              Effect.flatMap((state) => claudeCodeProviderDraft(effectiveConfig, state)),
            )
          : claudeCodeProviderDraft(effectiveConfig, undefined)
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = providerSnapshotSettingsSource(effectiveConfig, serverSettings);

      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          claudeCodeProviderDraft(effectiveConfig, undefined).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: CLAUDE_CODE_DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Claude Code login snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: CLAUDE_CODE_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: undefined,
      } satisfies ProviderInstance;
    }),
};
