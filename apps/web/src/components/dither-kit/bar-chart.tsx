import type { ChartValue } from "./chartValue";
import { BarCanvas } from "./bar-canvas";
import { type CartesianChartProps, CartesianRoot } from "./cartesian-root";

/** Composable dither **bar** chart — `<Bar>` series, grouped or stacked. */
export function BarChart<TData extends Record<keyof TData, ChartValue>>(
  props: CartesianChartProps<TData>,
) {
  return <CartesianRoot chartType="bar" Canvas={BarCanvas} {...props} />;
}
