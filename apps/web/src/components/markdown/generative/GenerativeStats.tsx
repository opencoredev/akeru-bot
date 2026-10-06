import type { StatsSpec } from "./generativeSchemas";
import { GenerativeFrame } from "./GenerativeFrame";

const SPARK_WIDTH = 100;

const SPARK_HEIGHT = 24;

function Sparkline({ values }: { readonly values: ReadonlyArray<number> }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;

  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - 2 - ((value - min) / range) * (SPARK_HEIGHT - 4);

      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      className="h-6 w-full overflow-visible"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-series={0}
    >
      <path
        className="gen-area"
        d={`${path} L${SPARK_WIDTH},${SPARK_HEIGHT} L0,${SPARK_HEIGHT} Z`}
      />
      <path className="gen-line" d={path} />
    </svg>
  );
}

export function GenerativeStats({ spec }: { readonly spec: StatsSpec }) {
  return (
    <GenerativeFrame kind="stats" title={spec.title}>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
        {spec.stats.map((stat) => (
          <div key={stat.label} className="flex min-w-0 flex-col gap-1">
            <div className="truncate text-xs text-muted-foreground">{stat.label}</div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold tracking-tight text-foreground tabular-nums">
                {stat.value}
              </span>
              {stat.delta ? (
                <span
                  className="gen-tone-text text-xs font-medium tabular-nums"
                  data-tone={stat.tone ?? "neutral"}
                >
                  {stat.delta}
                </span>
              ) : null}
            </div>
            {stat.trend ? <Sparkline values={stat.trend} /> : null}
          </div>
        ))}
      </div>
    </GenerativeFrame>
  );
}
