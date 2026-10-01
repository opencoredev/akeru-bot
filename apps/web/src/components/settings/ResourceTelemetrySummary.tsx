import type {
  ResourceTelemetryAggregate,
  ResourceTelemetrySourceHealth,
  ResourceTelemetrySourceStatus,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { type ComponentProps, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { formatBytes, formatRate, sourceStatusTone } from "./resourceTelemetryPresentation";
import { useRelativeTimeTick } from "./settingsLayout";

const SOURCE_STATUS_VARIANTS = {
  neutral: "telemetry-neutral",
  default: "telemetry-healthy",
  warning: "telemetry-warning",
  danger: "telemetry-danger",
} satisfies Record<string, ComponentProps<typeof Badge>["variant"]>;

export function SourceStatusBadge({
  label,
  status,
  presentation,
}: {
  label: string;
  status: ResourceTelemetrySourceStatus;
  presentation?:
    | {
        readonly label: string;
        readonly tone: "neutral";
      }
    | undefined;
}) {
  const tone = presentation?.tone ?? sourceStatusTone(status);

  return (
    <Badge size="telemetry-health" variant={SOURCE_STATUS_VARIANTS[tone]}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "neutral" && "bg-muted-foreground/55",
          tone === "default" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "danger" && "bg-destructive",
        )}
      />
      {label} {presentation?.label ?? status}
    </Badge>
  );
}

export function LastSampleLabel({ sampledAt }: { sampledAt: DateTime.Utc | null }) {
  useRelativeTimeTick();

  if (!sampledAt) {
    return <span className="text-11px text-muted-foreground/55">Waiting for sample</span>;
  }

  const relative = formatRelativeTime(DateTime.formatIso(sampledAt));

  if (!relative) {
    return <span className="text-11px text-muted-foreground/55">Waiting for sample</span>;
  }

  return (
    <span className="text-11px text-muted-foreground/60">
      Updated <span className="font-mono tabular-nums">{relative.value}</span>
      {relative.suffix ? ` ${relative.suffix}` : ""}
    </span>
  );
}

export function IconStat({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="group min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-10px font-semibold uppercase tracking-caps-wide text-muted-foreground/70">
        <span className="text-muted-foreground/55 transition-colors group-hover:text-foreground/65">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2.5 truncate font-mono text-2xl font-semibold tracking-tighter tabular-nums text-foreground",
          tone === "warning" && "text-telemetry-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 truncate text-10px text-muted-foreground/60">{detail}</div>
      ) : null}
    </div>
  );
}

export function AggregateCard({
  label,
  accentClass,
  aggregate,
}: {
  label: string;
  accentClass: string;
  aggregate: ResourceTelemetryAggregate;
}) {
  return (
    <div className="relative overflow-hidden border-t border-border/60 px-4 py-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 sm:px-5">
      <span className={cn("absolute inset-x-5 top-0 h-0.5 rounded-full opacity-75", accentClass)} />
      <div className="flex items-center justify-between gap-3">
        <div className="text-10px font-semibold uppercase tracking-caps-wide text-muted-foreground/75">
          {label}
        </div>
        <div className="rounded-md bg-muted/55 px-1.5 py-0.5 font-mono text-9px tabular-nums text-muted-foreground/70">
          {aggregate.processCount} {aggregate.processCount === 1 ? "process" : "processes"}
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair label="CPU" value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label="Memory" value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label="Read" value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label="Write" value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

export function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-9px font-semibold uppercase tracking-caps text-muted-foreground/45">
        {label}
      </div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground/90">
        {value}
      </div>
    </div>
  );
}

export function HealthSource({
  label,
  health,
}: {
  label: string;
  health: ResourceTelemetrySourceHealth;
}) {
  const expectedInBrowser =
    health.status === "unavailable" &&
    Option.exists(health.lastError, (error) => error.includes("'web' mode"));

  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/50 py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-13px font-medium text-foreground">{label}</div>
        <div className="mt-1 text-11px leading-relaxed text-muted-foreground/65">
          {expectedInBrowser
            ? "Available when this page runs inside the desktop app."
            : Option.match(health.lastError, {
                onNone: () => "No reported errors",
                onSome: (error) => error,
              })}
        </div>
      </div>
      <SourceStatusBadge
        label=""
        status={health.status}
        presentation={
          expectedInBrowser
            ? {
                label: "Desktop only",
                tone: "neutral",
              }
            : undefined
        }
      />
    </div>
  );
}

export function DetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <span className="text-11px text-muted-foreground/75">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-11px tabular-nums text-foreground/85",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}
