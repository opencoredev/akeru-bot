import { useState, type PointerEvent } from "react";
import type { ChartSpec } from "./generativeSchemas";
import { GenerativeFrame } from "./GenerativeFrame";

const PLOT_WIDTH = 600;

const PLOT_HEIGHT = 160;

const MAX_SERIES = 4;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;

  return step * magnitude;
}

export function formatChartValue(value: number, unit: string | undefined): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  const text = rounded.toLocaleString();

  if (!unit) return text;

  return unit === "%" || unit === "s" || unit === "ms" ? `${text}${unit}` : `${text} ${unit}`;
}

function linePath(values: ReadonlyArray<number>, max: number, count: number): string {
  return values
    .map((value, index) => {
      const x = count <= 1 ? 0 : (index / (count - 1)) * PLOT_WIDTH;
      const y = PLOT_HEIGHT - (value / max) * PLOT_HEIGHT;

      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function ChartLegend({ spec }: { readonly spec: ChartSpec }) {
  if (spec.series.length < 2) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {spec.series.slice(0, MAX_SERIES).map((series, index) => (
        <span
          key={series.name}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          data-series={index}
        >
          <span className="gen-swatch size-2 rounded-full" />
          {series.name}
        </span>
      ))}
    </div>
  );
}

function ChartTooltip({ spec, index }: { readonly spec: ChartSpec; readonly index: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{spec.x[index]}</div>
      {spec.series.slice(0, MAX_SERIES).map((series, seriesIndex) => (
        <div
          key={series.name}
          className="flex items-center justify-between gap-4"
          data-series={seriesIndex}
        >
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="gen-swatch size-1.5 rounded-full" />
            {series.name}
          </span>
          <span className="font-mono tabular-nums">
            {formatChartValue(series.values[index] ?? 0, spec.unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

function XAxis({ labels }: { readonly labels: ReadonlyArray<string> }) {
  // Long axes show every other label so they never collide in a chat column.
  const stride = labels.length > 8 ? Math.ceil(labels.length / 6) : 1;

  return (
    <div className="mt-1.5 flex justify-between text-10px text-muted-foreground tabular-nums">
      {labels.map((label, index) => (
        <span key={label} className={index % stride === 0 ? "" : "invisible"}>
          {label}
        </span>
      ))}
    </div>
  );
}

function LineChart({ spec, max }: { readonly spec: ChartSpec; readonly max: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const count = spec.x.length;

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / bounds.width;
    setHoverIndex(Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1)))));
  };

  const hoverLeft = hoverIndex === null || count <= 1 ? 0 : (hoverIndex / (count - 1)) * 100;

  return (
    <div>
      <div
        className="relative h-40"
        onPointerMove={handlePointer}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <svg
          className="absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              className="gen-gridline"
              x1={0}
              x2={PLOT_WIDTH}
              y1={PLOT_HEIGHT * fraction}
              y2={PLOT_HEIGHT * fraction}
            />
          ))}
          {spec.series.slice(0, MAX_SERIES).map((series, index) => {
            const path = linePath(series.values, max, count);

            return (
              <g key={series.name} data-series={index}>
                {spec.type === "area" ? (
                  <path
                    className="gen-area"
                    d={`${path} L${PLOT_WIDTH},${PLOT_HEIGHT} L0,${PLOT_HEIGHT} Z`}
                  />
                ) : null}
                <path className="gen-line" d={path} />
              </g>
            );
          })}
        </svg>
        <span className="absolute top-0 left-0 -translate-y-1/2 bg-card pr-1 text-10px text-muted-foreground tabular-nums">
          {formatChartValue(max, spec.unit)}
        </span>
        {hoverIndex !== null ? (
          <>
            <div
              className="gen-crosshair pointer-events-none absolute inset-y-0 left-(--gen-x) w-px"
              style={{ "--gen-x": `${hoverLeft}%` }}
            />
            <div
              className={
                hoverLeft > 60
                  ? "pointer-events-none absolute top-1 right-(--gen-x-end) z-10 mr-2"
                  : "pointer-events-none absolute top-1 left-(--gen-x) z-10 ml-2"
              }
              style={{ "--gen-x": `${hoverLeft}%`, "--gen-x-end": `${100 - hoverLeft}%` }}
            >
              <ChartTooltip spec={spec} index={hoverIndex} />
            </div>
          </>
        ) : null}
      </div>
      <XAxis labels={spec.x} />
    </div>
  );
}

function BarChart({ spec, max }: { readonly spec: ChartSpec; readonly max: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const series = spec.series.slice(0, MAX_SERIES);

  return (
    <div>
      <div className="relative flex h-40 items-end gap-2 border-b border-border/70">
        <span className="absolute top-0 left-0 -translate-y-1/2 bg-card pr-1 text-10px text-muted-foreground tabular-nums">
          {formatChartValue(max, spec.unit)}
        </span>
        {spec.x.map((label, index) => (
          <div
            key={label}
            className="relative flex h-full flex-1 items-end justify-center gap-0.5"
            onPointerEnter={() => setHoverIndex(index)}
            onPointerLeave={() => setHoverIndex(null)}
          >
            {series.map((entry, seriesIndex) => (
              <div
                key={entry.name}
                className="gen-bar h-(--gen-h) w-full max-w-7 data-[dim=true]:opacity-45"
                data-series={seriesIndex}
                data-dim={hoverIndex !== null && hoverIndex !== index}
                style={{ "--gen-h": `${((entry.values[index] ?? 0) / max) * 100}%` }}
              />
            ))}
            {hoverIndex === index ? (
              <div className="pointer-events-none absolute bottom-full z-10 mb-1">
                <ChartTooltip spec={spec} index={index} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2 text-10px text-muted-foreground">
        {spec.x.map((label) => (
          <span key={label} className="flex-1 truncate text-center">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The chart's numbers as a table for screen readers; the drawing itself is hidden from them. */
function ChartDataTable({ spec }: { readonly spec: ChartSpec }) {
  return (
    <table className="sr-only">
      {spec.title ? <caption>{spec.title}</caption> : null}
      <thead>
        <tr>
          <th scope="col" />
          {spec.series.map((series) => (
            <th key={series.name} scope="col">
              {series.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {spec.x.map((label, index) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            {spec.series.map((series) => (
              <td key={series.name}>{formatChartValue(series.values[index] ?? 0, spec.unit)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function GenerativeChart({ spec }: { readonly spec: ChartSpec }) {
  const peak = Math.max(0, ...spec.series.flatMap((series) => series.values));
  const max = niceMax(peak);

  return (
    <GenerativeFrame
      kind="chart"
      title={spec.title}
      subtitle={spec.subtitle}
      aside={<ChartLegend spec={spec} />}
    >
      <div aria-hidden="true">
        {spec.type === "bar" ? (
          <BarChart spec={spec} max={max} />
        ) : (
          <LineChart spec={spec} max={max} />
        )}
      </div>
      <ChartDataTable spec={spec} />
    </GenerativeFrame>
  );
}
