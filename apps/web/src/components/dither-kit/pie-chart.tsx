"use client";

import type { ChartValue } from "./chartValue";

import type { ReactNode } from "react";
import type { ChartConfig, Margins } from "./chart-context";
import type { BloomInput } from "./dither-paint";
import { PieCanvas } from "./pie-canvas";
import { PolarRoot } from "./polar-root";

export type PieChartProps<TData extends Record<keyof TData, ChartValue>> = {
  data: TData[];
  config: ChartConfig;
  children: ReactNode;
  dataKey: string; // value field
  nameKey: string; // slice-name field (looked up in config for colour)
  innerRadius?: number; // 0–1 ratio for a donut
  margins?: Partial<Margins>;
  className?: string;
  animate?: boolean;
  animationDuration?: number;
  replayToken?: number;
  bloom?: BloomInput;
  bloomOnHover?: boolean;
  defaultSelectedDataKey?: string | null;
  onSelectionChange?: (key: string | null) => void;
};

/** Composable dither **pie / donut** chart. Compose `<Pie>`, `<Legend>`, … inside. */
export function PieChart<TData extends Record<keyof TData, ChartValue>>(
  props: PieChartProps<TData>,
) {
  return <PolarRoot chartType="pie" Canvas={PieCanvas} {...props} />;
}
