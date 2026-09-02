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
import { Bar } from "../dither-kit/bar";
import { BarChart } from "../dither-kit/bar-chart";
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
  const data = props.limits.windows.map((window) => ({
    label: window.label,
    left: remainingPercent(window),
  }));

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderMark icon={presentation.icon} />
        {title}
      </h2>
      {props.limits.windows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {props.limits.message ?? "No limit data yet."}
        </p>
      ) : (
        <>
          <BarChart
            data={data}
            config={{ left: { label: "Left", color: presentation.color } }}
            animate={false}
            bloom="off"
            className="h-48 w-full"
            margins={{ top: 8, right: 8, bottom: 22, left: 36 }}
          >
            <Grid vertical={false} />
            <XAxis dataKey="label" />
            <YAxis tickFormatter={(value) => `${Math.round(value)}%`} tickCount={5} />
            <Tooltip valueFormatter={(value) => `${Math.round(value)}% left`} />
            <Bar dataKey="left" variant="gradient" />
          </BarChart>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {props.limits.windows.map((window) => (
              <li
                key={`${window.kind}:${window.label}`}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="text-foreground">
                  {window.label} {Math.round(remainingPercent(window))}% left
                </span>
                <span className="tabular-nums">{formatReset(window.resetsAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const ACTIVITY_COLOR: Record<UsageProviderKind, DitherColor> = {
  claude: "orange",
  codex: "green",
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
