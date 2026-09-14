import type {
  SubscriptionProviderId,
  UsagePlanWindow,
  UsageProviderKind,
  UsageProviderPlanLimits,
} from "@t3tools/contracts";
import { enumerateDays, formatDayShort, formatTokens } from "@t3tools/shared/usageFormat";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { Line } from "../dither-kit/area";
import { LineChart } from "../dither-kit/area-chart";
import { BlockLegend } from "../dither-kit/block-legend";
import type { ChartConfig } from "../dither-kit/chart-context";
import type { DitherColor } from "../dither-kit/palette";
import { Grid } from "../dither-kit/grid";
import { Tooltip } from "../dither-kit/tooltip";
import { XAxis } from "../dither-kit/x-axis";
import { YAxis } from "../dither-kit/y-axis";
import { ClaudeAI, CursorIcon, GrokIcon, OpenCodeIcon, type Icon, OpenAI } from "../Icons";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";

export const PLAN_PROVIDER_PRESENTATION: Record<
  SubscriptionProviderId,
  {
    readonly label: string;
    readonly icon: Icon | string;
    readonly color: DitherColor;
  }
> = {
  "openai-codex": { label: "ChatGPT", icon: OpenAI, color: "green" },
  anthropic: { label: "Claude", icon: ClaudeAI, color: "orange" },
  cursor: { label: "Cursor", icon: CursorIcon, color: "blue" },
  xai: { label: "Grok", icon: GrokIcon, color: "grey" },
  "kimi-for-coding": {
    label: "Kimi For Coding",
    icon: "/provider-icons/kimi-for-coding.svg",
    color: "purple",
  },
  "opencode-go": { label: "OpenCode Go", icon: OpenCodeIcon, color: "grey" },
};

export const PLAN_PROVIDER_ORDER: readonly SubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
  "cursor",
  "xai",
  "kimi-for-coding",
  "opencode-go",
];

function formatReset(resetsAt: string | null): string {
  if (resetsAt === null) return "Reset time unknown";
  const deltaMs = Date.parse(resetsAt) - Date.now();
  if (Number.isNaN(deltaMs) || deltaMs <= 0) return "Resets soon";
  const hours = Math.round(deltaMs / (60 * 60 * 1000));
  if (hours < 48) return `Resets in ${hours}h`;
  return `Resets in ${Math.round(hours / 24)}d`;
}

function remainingPercent(window: UsagePlanWindow): number {
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}

function ProviderMark({ icon }: { readonly icon: Icon | string }) {
  if (typeof icon !== "string") {
    const Mark = icon;
    return <Mark className="size-4 shrink-0" />;
  }
  return <img src={icon} alt="" className="size-4 shrink-0 brightness-0 dark:invert" />;
}

export function UsagePlanMeters(props: { readonly limits: UsageProviderPlanLimits }) {
  const presentation = PLAN_PROVIDER_PRESENTATION[props.limits.provider];
  const title =
    props.limits.plan === null
      ? presentation.label
      : `${presentation.label} · ${props.limits.plan}`;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-2 px-1 text-sm font-medium text-foreground">
        <ProviderMark icon={presentation.icon} />
        {title}
      </h2>
      {props.limits.windows.length === 0 ? (
        <p className="rounded-xl border border-border/70 px-4 py-5 text-sm text-muted-foreground">
          {props.limits.message ?? "No limit data yet."}
        </p>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
          {props.limits.windows.map((window) => {
            const left = remainingPercent(window);
            return (
              <div
                key={`${window.kind}:${window.label}`}
                className="grid gap-3 px-4 py-4 md:grid-cols-[10rem_minmax(0,1fr)_7rem] md:items-center md:gap-5"
              >
                <div className="flex items-baseline justify-between gap-3 md:block">
                  <span className="text-sm font-medium text-foreground">{window.label}</span>
                  <span className="text-2xl font-semibold text-foreground tabular-nums md:mt-1 md:block">
                    {Math.round(left)}%
                    <span className="ms-1 text-xs font-normal text-muted-foreground">left</span>
                  </span>
                </div>
                <div
                  role="img"
                  aria-label={`${window.label}: ${Math.round(left)}% left`}
                  className="relative h-7 overflow-hidden rounded-md bg-muted/70"
                >
                  <div
                    className="absolute inset-y-0 start-0 rounded-md opacity-75"
                    style={{
                      width: `${left}%`,
                      backgroundColor: `var(--color-${presentation.color}-500, var(--foreground))`,
                    }}
                  />
                  <div className="absolute inset-0 bg-[repeating-linear-gradient(135deg,transparent_0,transparent_4px,var(--border)_4px,var(--border)_5px)] opacity-30" />
                </div>
                <span className="text-xs text-muted-foreground tabular-nums md:text-end">
                  {formatReset(window.resetsAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const ACTIVITY_COLOR: Record<UsageProviderKind, DitherColor> = {
  claude: "orange",
  codex: "green",
  cursor: "purple",
  grok: "grey",
  kimi: "blue",
  opencode: "green",
};

export function UsageActivityChart(props: {
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly daily: readonly DailyTotals[];
  readonly providers: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[];
}) {
  const active = providersWithUsage(props.providers);
  const days = enumerateDays(props.sinceDay, props.untilDay);
  const byDay = new Map(props.daily.map((entry) => [entry.day, entry]));
  const data = days.map((day) => {
    const totals = byDay.get(day);
    const row: Record<string, string | number> = { label: formatDayShort(day) };
    for (const provider of PROVIDER_ORDER) {
      row[provider] = totals?.byProvider.get(provider)?.totalTokens ?? 0;
    }
    return row;
  });
  const config = Object.fromEntries(
    active.map((provider) => [
      provider,
      { label: PROVIDER_PRESENTATION[provider].label, color: ACTIVITY_COLOR[provider] },
    ]),
  ) as ChartConfig;

  if (active.length === 0 || days.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity in this window.</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <LineChart
        data={data}
        config={config}
        animate={false}
        bloom="off"
        className="h-52 w-full"
        margins={{ top: 8, right: 8, bottom: 22, left: 44 }}
      >
        <Grid vertical={false} />
        <XAxis dataKey="label" maxTicks={6} />
        <YAxis tickFormatter={formatTokens} tickCount={4} />
        <Tooltip valueFormatter={(value) => formatTokens(value)} />
        {active.map((provider) => (
          <Line key={provider} dataKey={provider} />
        ))}
      </LineChart>
      <BlockLegend config={config} align="start" />
    </div>
  );
}
