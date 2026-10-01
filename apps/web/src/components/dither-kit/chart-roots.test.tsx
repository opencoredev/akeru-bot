import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChartConfig } from "./chart-context";
import { CartesianRoot } from "./cartesian-root";
import { PolarRoot } from "./polar-root";

vi.mock("./use-chart-dimensions", () => ({
  useChartDimensions: () => ({
    ref: { current: null },
    size: { width: 320, height: 240 },
  }),
}));

const EmptyCanvas = () => null;

const data = [{ name: "First", value: 5 }];

const config = { value: { color: "green" } } satisfies ChartConfig;

const fragment = (
  <>
    <text>Fragment content</text>
  </>
);

describe("chart fragment children", () => {
  it("renders cartesian fragment content in the front SVG layer", () => {
    const html = renderToStaticMarkup(
      <CartesianRoot chartType="line" Canvas={EmptyCanvas} data={data} config={config}>
        {fragment}
      </CartesianRoot>,
    );

    expect(html).toMatch(
      /<svg[^>]*role="img"[^>]*><g[^>]*><text>Fragment content<\/text><\/g><\/svg>/,
    );
  });

  it("renders polar fragment content in the front SVG layer", () => {
    const html = renderToStaticMarkup(
      <PolarRoot
        chartType="pie"
        Canvas={EmptyCanvas}
        data={data}
        config={config}
        dataKey="value"
        nameKey="name"
      >
        {fragment}
      </PolarRoot>,
    );

    expect(html).toMatch(
      /<svg[^>]*role="img"[^>]*><g[^>]*><text>Fragment content<\/text><\/g><\/svg>/,
    );
  });
});
