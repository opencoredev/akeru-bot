import type { ChartValue } from "./chartValue";
import { CartesianCanvas } from "./cartesian-canvas";
import { type CartesianChartProps, CartesianRoot } from "./cartesian-root";

/** Composable dither **area** chart. Compose `<Area>`, `<Grid>`, axes, … inside. */
export function AreaChart<TData extends Record<keyof TData, ChartValue>>(
  props: CartesianChartProps<TData>,
) {
  return <CartesianRoot chartType="area" Canvas={CartesianCanvas} {...props} />;
}

/** Composable dither **line** chart — `<Line>` series with a glow under the line. */
export function LineChart<TData extends Record<keyof TData, ChartValue>>(
  props: CartesianChartProps<TData>,
) {
  return <CartesianRoot chartType="line" Canvas={CartesianCanvas} {...props} />;
}

export type AreaChartProps<TData extends Record<keyof TData, ChartValue>> =
  CartesianChartProps<TData>;
