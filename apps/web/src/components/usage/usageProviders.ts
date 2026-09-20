import type { UsageProviderKind } from "@t3tools/contracts";

import {
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  KimiIcon,
  OpenCodeIcon,
  type Icon,
  OpenAI,
} from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 *
 * Cursor stays for historical usage series only. It is not a built-in Akeru
 * provider and must not appear in connectable or available-provider lists.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude",
    color: "#d97757",
    mark: ClaudeAI,
  },
  cursor: {
    label: "Cursor (historical)",
    color: "#a78bfa",
    mark: CursorIcon,
  },
  grok: {
    label: "Grok",
    color: "#94a3b8",
    mark: GrokIcon,
  },
  kimi: {
    label: "Kimi For Coding",
    color: "#60a5fa",
    mark: KimiIcon,
  },
  opencode: {
    label: "OpenCode",
    color: "#34d399",
    mark: OpenCodeIcon,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
