import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  SubscriptionProviderStatus,
} from "@akeru/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ??
        "This provider is installed but disabled for new sessions in Akeru Bot.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}

/** Tone of the one-line status shown next to a provider or channel. */
export type ConnectionTone = "positive" | "neutral" | "attention" | "pending";

export interface ProviderConnectionState {
  readonly tone: ConnectionTone;
  readonly label: string;
  /** Why the provider needs attention, when the server said so. */
  readonly detail: string | null;
}

const ACCOUNT_PROBLEM_LABELS: Partial<
  Record<NonNullable<SubscriptionProviderStatus["health"]>, string>
> = {
  expired: "Sign-in expired",
  revoked: "Access revoked",
  failed: "Check failed",
  "failed-first-request": "First request failed",
};

/** Headline state of a subscription or API key account. */
export function accountConnectionState(
  status: SubscriptionProviderStatus | undefined,
  pending: boolean,
): ProviderConnectionState {
  if (!status) {
    return pending
      ? { tone: "pending", label: "Checking", detail: null }
      : { tone: "neutral", label: "Not connected", detail: null };
  }
  if (!status.connected) return { tone: "neutral", label: "Not connected", detail: null };
  // The server checks a new login on its own; say so rather than claiming it is ready.
  if (status.healthChecking === true) {
    return { tone: "pending", label: "Checking access", detail: null };
  }
  const problem = status.health ? ACCOUNT_PROBLEM_LABELS[status.health] : undefined;
  if (problem) {
    return {
      tone: "attention",
      label: "Needs attention",
      detail: problem,
    };
  }
  return { tone: "positive", label: "Connected", detail: null };
}

/** Headline state of a CLI-backed provider that has no account of its own. */
export function runtimeConnectionState(
  provider: ServerProvider | undefined,
): ProviderConnectionState {
  if (!provider) return { tone: "pending", label: "Checking", detail: null };
  if (!provider.enabled) return { tone: "neutral", label: "Disabled", detail: null };
  if (!provider.installed) {
    return { tone: "neutral", label: "Not installed", detail: provider.message ?? null };
  }
  if (provider.auth.status === "authenticated") {
    return { tone: "positive", label: "Connected", detail: null };
  }
  if (provider.status === "error" || provider.status === "warning") {
    return { tone: "attention", label: "Needs attention", detail: provider.message ?? null };
  }
  if (provider.auth.status === "unauthenticated") {
    return { tone: "neutral", label: "Not connected", detail: provider.message ?? null };
  }
  return { tone: "positive", label: "Available", detail: null };
}
