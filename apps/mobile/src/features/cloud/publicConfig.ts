import Constants from "expo-constants";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  return {
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
    },
    observability: {
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  } satisfies CloudPublicConfig;
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}
