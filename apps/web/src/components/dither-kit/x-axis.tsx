import type { ChartValue } from "./chartValue";
import { useChartPart } from "./chart-context";

export function XAxis({
  dataKey,
  tickFormatter,
  tickMargin = 8,
  maxTicks = 8,
}: {
  dataKey?: string;
  tickFormatter?: (value: ChartValue, index: number) => string;
  tickMargin?: number;
  maxTicks?: number;
}) {
  const ctx = useChartPart("XAxis");

  if (!ctx.ready) return null;

  const step = Math.max(1, Math.ceil(ctx.dataLength / maxTicks));
  const y = ctx.plot.height + tickMargin;

  return (
    <g className="fill-current font-mono text-10px text-muted-foreground">
      {ctx.dataMarks.map(({ row, index: i, key }) => {
        if (i % step !== 0) return null;
        const raw = dataKey ? row[dataKey] : i;
        const label = tickFormatter ? tickFormatter(raw, i) : String(raw ?? "");

        return (
          <text
            key={key}
            x={ctx.xCenter(i) ?? 0}
            y={y}
            textAnchor="middle"
            dominantBaseline="hanging"
            fill="currentColor"
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}
