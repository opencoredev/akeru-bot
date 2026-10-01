import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@akeru/shared/usageMerge";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useUsage } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@akeru/shared/usageFormat";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PLAN_PROVIDER_ORDER } from "./UsageCharts";
import { UsageProviderChart } from "./UsageProviderChart";
import { PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import {
  isUsageMetric,
  isUsageWindowDays,
  METRIC_OPTIONS,
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsageMetric,
  WINDOW_OPTIONS,
} from "./usagePagePreferences";
import {
  Metric,
  ProviderMark,
  UsageCoverageNotice,
  UsageDeviceStrip,
  UsageLimitsOverview,
  UsageSkeleton,
} from "./UsagePageSections";

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);

  const [windowSelection, setWindowSelection] = useState(() => ({
    days: preferences.windowDays,
    window: makeWindow(
      preferences.windowDays,
      undefined,
      preferences.windowDays === 1 ? "hour" : "day",
    ),
  }));

  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);
  const refreshMinutes = useClientSettings((settings) => settings.usageRefreshMinutes);

  const planLimits = PLAN_PROVIDER_ORDER.map((provider) =>
    merged.planLimits.find((entry) => entry.provider === provider && entry.status === "ok"),
  ).filter((entry) => entry !== undefined);

  useEffect(() => {
    const timer = globalThis.setInterval(refresh, Math.max(1, refreshMinutes) * 60 * 1000);

    return () => globalThis.clearInterval(timer);
  }, [refresh, refreshMinutes]);

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );

  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );

  // Newest first: the window can run 90 periods, so the interesting end
  // belongs at the top of the table.
  const breakdownPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed(),
    [isPast24Hours, merged.daily, merged.hourly],
  );

  const breakdownModels = useMemo(
    () =>
      breakdown === "model" && metric === "tokens"
        ? merged.models.toSorted(
            (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
          )
        : merged.models,
    [breakdown, merged.models, metric],
  );

  const activeProviders = useMemo(() => providersWithUsage(merged.providers), [merged.providers]);
  const timeValueColumnWidth = `${60 / (activeProviders.length + 2)}%`;

  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    const nextPreferences = { metric, windowDays: days };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };

  const selectMetric = (nextMetric: UsageMetric) => {
    const nextPreferences = { metric: nextMetric, windowDays };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };

  const refreshWindow = () => {
    if (showingLimits) {
      refresh();

      return;
    }

    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");

    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
  };

  const windowLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
      : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`;

  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>Usage</h1>
        </WorkspaceBreadcrumbItem>
        {showingLimits ? null : (
          <>
            <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
            <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink md:flex">
              <span className="truncate">{windowLabel}</span>
            </WorkspaceBreadcrumbItem>
          </>
        )}
      </WorkspaceBreadcrumb>
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 lg:flex">
        <ToggleGroup
          aria-label="Usage metric"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];

            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end gap-1 lg:hidden">
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          <SelectTrigger
            aria-label="Usage metric"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {METRIC_OPTIONS.find((option) => option.value === metric)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable">
            {showingLimits ? (
              <UsageLimitsOverview
                planLimits={planLimits}
                environments={environments}
                isPending={isPending}
              />
            ) : isPending ? (
              <>
                {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
                <UsageSkeleton />
              </>
            ) : merged.staleEnvironments.length > 0 && merged.connectedProviders.length === 0 ? (
              <UsageCoverageNotice
                environments={environments}
                duplicateSources={merged.duplicateSources}
                staleEnvironments={merged.staleEnvironments}
              />
            ) : merged.connectedProviders.length === 0 ? (
              <div className="rounded-xl border border-border/70 px-5 py-6">
                <h2 className="text-sm font-medium text-foreground">No provider usage yet</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Connect a provider in Settings to start tracking usage.
                </p>
              </div>
            ) : (
              <>
                {isPartial && environments.length > 1 ? (
                  <UsageDeviceStrip environments={environments} />
                ) : null}
                <UsageCoverageNotice
                  environments={environments}
                  duplicateSources={merged.duplicateSources}
                  staleEnvironments={merged.staleEnvironments}
                />

                <section className="grid gap-6 lg:grid-cols-18rem-1fr">
                  <div className="flex min-w-0 flex-col gap-5">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-semibold text-foreground tabular-nums">
                        {metric === "cost"
                          ? formatUsd(merged.costUsd)
                          : formatTokens(merged.totalTokens)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost"
                          ? merged.costQuality.unpricedShare > 0
                            ? `${formatCount(merged.sessions)} sessions · estimate excludes ${formatPercent(merged.costQuality.unpricedShare)} unpriced records`
                            : `${formatCount(merged.sessions)} sessions · API estimate`
                          : `${formatCount(merged.sessions)} sessions`}
                      </span>
                    </div>

                    {activeProviders.map((provider) => {
                      const totals = merged.providers.find((entry) => entry.provider === provider);

                      const share =
                        metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);

                      const providerSessions = totals?.sessions ?? 0;

                      const sessionLabel = `${formatCount(providerSessions)} ${
                        providerSessions === 1 ? "session" : "sessions"
                      }`;

                      return (
                        <div key={provider} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-full"
                                /* oxlint-disable shadcn/no-inline-styles -- Provider identity color from usage presentation data. */
                                style={{
                                  backgroundColor: PROVIDER_PRESENTATION[provider].color,
                                }}
                                /* oxlint-enable shadcn/no-inline-styles */
                              />
                              <ProviderMark provider={provider} className="size-4" />
                              <span className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate">
                                  {PROVIDER_PRESENTATION[provider].label}
                                </span>
                                <span className="shrink-0 whitespace-nowrap text-11px text-muted-foreground tabular-nums">
                                  {sessionLabel}
                                </span>
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                              {metric === "cost"
                                ? formatUsd(totals?.costUsd ?? 0)
                                : formatTokens(totals?.totalTokens ?? 0)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {metric === "cost"
                              ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                              : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    {/* The period only shapes the time series and the breakdown
                        below it, so it sits with them instead of competing with
                        the metric control in the top bar. */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-medium text-foreground">
                        {isPast24Hours ? "Hourly" : "Daily"}{" "}
                        {metric === "tokens" ? "processed tokens" : "cost"}
                      </h2>
                      <ToggleGroup
                        aria-label="Usage period"
                        variant="segmented"
                        value={[String(windowDays)]}
                        onValueChange={(next) => {
                          const value = next[0];

                          if (value) selectWindow(Number(value));
                        }}
                      >
                        {WINDOW_OPTIONS.map((option) => (
                          <Toggle key={option.days} value={String(option.days)}>
                            {option.label}
                          </Toggle>
                        ))}
                      </ToggleGroup>
                    </div>
                    <UsageProviderChart
                      providers={activeProviders}
                      days={days}
                      daily={merged.daily}
                      hours={hours}
                      hourly={merged.hourly}
                      metric={metric}
                      referenceTime={window.untilTime}
                      resolution={isPast24Hours ? "hour" : "day"}
                      timeZone={window.timeZone}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium text-foreground">Totals</h2>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                    <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
                    <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
                    <Metric
                      label="Uncached input"
                      value={formatTokens(merged.uncachedInputTokens)}
                    />
                    <Metric label="Output" value={formatTokens(merged.outputTokens)} />
                    <Metric
                      label="Cache savings"
                      value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                    />
                  </div>
                </section>

                <section className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
                    <ToggleGroup
                      aria-label="Usage breakdown"
                      variant="segmented"
                      value={[breakdown]}
                      onValueChange={(next) => {
                        const value = next[0];

                        if (value === "model" || value === "time") setBreakdown(value);
                      }}
                    >
                      {(
                        [
                          { value: "model", label: "Model" },
                          { value: "time", label: isPast24Hours ? "Hour" : "Day" },
                        ] as const
                      ).map((option) => (
                        <Toggle key={option.value} value={option.value}>
                          {option.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>

                  {breakdown === "model" ? (
                    // Model names and five numeric columns stop fitting well
                    // before the narrowest supported width, so the table keeps a
                    // readable minimum and scrolls rather than crushing columns.
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-136 table-fixed text-sm">
                        <colgroup>
                          <col className="w-2/5" />
                          <col className="w-1/5" />
                          <col className="w-1/5" />
                          <col className="w-1/5" />
                        </colgroup>
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="py-2 font-normal">Model</th>
                            <th className="py-2 text-right font-normal">Cost</th>
                            <th className="py-2 text-right font-normal">Share</th>
                            <th className="py-2 text-right font-normal">Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakdownModels.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="py-6 text-center text-muted-foreground">
                                No activity in this window.
                              </td>
                            </tr>
                          ) : (
                            breakdownModels.map((model) => (
                              <tr
                                key={`${model.provider}:${model.model}`}
                                className="border-b border-border/50 transition-colors hover:bg-muted/50"
                              >
                                <td className="py-2 text-foreground">
                                  <span className="flex items-center gap-2">
                                    <ProviderMark provider={model.provider} className="size-3.5" />
                                    {PROVIDER_PRESENTATION[model.provider].label} · {model.model}
                                  </span>
                                </td>
                                <td className="py-2 text-right text-foreground tabular-nums">
                                  {formatUsd(model.costUsd)}
                                </td>
                                <td className="py-2 text-right text-muted-foreground tabular-nums">
                                  {formatPercent(model.costShare)}
                                </td>
                                <td className="py-2 text-right text-muted-foreground tabular-nums">
                                  {formatTokens(model.totalTokens)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-160 table-fixed text-sm">
                        <colgroup>
                          <col className="w-2/5" />
                          {activeProviders.map((provider) => (
                            // oxlint-disable-next-line shadcn/no-inline-styles -- Column width depends on how many providers are shown.
                            <col key={provider} style={{ width: timeValueColumnWidth }} />
                          ))}
                          {/* oxlint-disable-next-line shadcn/no-inline-styles -- Column width depends on how many providers are shown. */}
                          <col style={{ width: timeValueColumnWidth }} />
                          {/* oxlint-disable-next-line shadcn/no-inline-styles -- Column width depends on how many providers are shown. */}
                          <col style={{ width: timeValueColumnWidth }} />
                        </colgroup>
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-muted-foreground">
                            <th className="py-2 font-normal">{isPast24Hours ? "Hour" : "Day"}</th>
                            {activeProviders.map((provider) => (
                              <th key={provider} className="py-2 text-right font-normal">
                                {PROVIDER_PRESENTATION[provider].label}
                              </th>
                            ))}
                            <th className="py-2 text-right font-normal">Total</th>
                            <th className="py-2 text-right font-normal">Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakdownPeriods.length === 0 ? (
                            <tr>
                              <td
                                colSpan={activeProviders.length + 3}
                                className="py-6 text-center text-muted-foreground"
                              >
                                No activity in this window.
                              </td>
                            </tr>
                          ) : (
                            breakdownPeriods.map((period) => (
                              <tr
                                key={"hourStart" in period ? period.hourStart : period.day}
                                className="border-b border-border/50 transition-colors hover:bg-muted/50"
                              >
                                <td className="py-2 text-foreground">
                                  {"hourStart" in period
                                    ? formatHourShort(period.hourStart, window.timeZone)
                                    : formatDayShort(period.day)}
                                </td>
                                {activeProviders.map((provider) => (
                                  <td
                                    key={provider}
                                    className="py-2 text-right text-muted-foreground tabular-nums"
                                  >
                                    {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                                  </td>
                                ))}
                                <td className="py-2 text-right text-foreground tabular-nums">
                                  {formatUsd(period.costUsd)}
                                </td>
                                <td className="py-2 text-right text-muted-foreground tabular-nums">
                                  {formatTokens(period.totalTokens)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
