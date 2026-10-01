// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@akeru/contracts";
import { compareSemverVersions } from "@akeru/shared/semver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  type ProviderMaintenanceCapabilities,
  manualProviderMaintenanceCapabilities,
  nonEmptyString,
} from "./ProviderMaintenanceCapabilities.ts";

export const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;

export const LATEST_VERSION_TIMEOUT_MS = 4_000;

export const PROVIDER_UPDATE_ACTION_TOAST_MESSAGE =
  "Install the update now or review provider settings.";

export interface ProviderVersionCacheEntry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export const ProviderVersionCache = Context.Reference<Map<string, ProviderVersionCacheEntry>>(
  "@akeru/server/providerMaintenance/ProviderVersionCache",
  {
    defaultValue: () => new Map(),
  },
);

export const NpmLatestVersionResponse = Schema.Struct({
  version: Schema.optional(Schema.String),
});

export function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion) {
    return { status: "unknown", message: null };
  }

  if (!input.latestVersion) {
    return { status: "unknown", message: null };
  }

  if (compareSemverVersions(input.currentVersion, input.latestVersion) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_TOAST_MESSAGE,
    };
  }

  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ?? manualProviderMaintenanceCapabilities(input.driver);

  const latestVersion = input.latestVersion ?? null;

  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
  };
}

export const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (
  packageName: string,
) {
  const client = yield* HttpClient.HttpClient;

  const request = HttpClientRequest.get(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  ).pipe(HttpClientRequest.setHeader("accept", "application/json"));

  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(LATEST_VERSION_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );

  if (Option.isNone(response)) {
    return null;
  }

  const httpResponse = response.value;

  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }

  const payload = yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestVersionResponse)),
    Effect.orElseSucceed(() => null),
  );

  return payload ? nonEmptyString(payload.version) : null;
});

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  const packageName = maintenanceCapabilities.packageName;

  if (!packageName) {
    return null;
  }

  const latestVersionCache = yield* ProviderVersionCache;
  const cached = latestVersionCache.get(packageName);
  const now = DateTime.toEpochMillis(yield* DateTime.now);

  if (cached && cached.expiresAt > now) {
    return cached.version;
  }

  const version = yield* fetchNpmLatestVersion(packageName);
  latestVersionCache.set(packageName, {
    expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
    version,
  });

  return version;
});

export const enrichProviderSnapshotWithVersionAdvisory = Effect.fn(
  "enrichProviderSnapshotWithVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities?: ProviderMaintenanceCapabilities,
  options?: {
    readonly enableProviderUpdateChecks: boolean | undefined;
  },
) {
  const capabilities =
    maintenanceCapabilities ?? manualProviderMaintenanceCapabilities(snapshot.driver);

  const shouldResolveLatestVersion =
    options?.enableProviderUpdateChecks !== false &&
    snapshot.enabled &&
    snapshot.installed &&
    Boolean(snapshot.version);

  if (!shouldResolveLatestVersion) {
    return {
      ...snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        checkedAt: snapshot.checkedAt,
        maintenanceCapabilities: capabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersion(capabilities);

  return {
    ...snapshot,
    versionAdvisory: createProviderVersionAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
      latestVersion,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: capabilities,
    }),
  };
});
