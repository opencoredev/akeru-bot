import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UsageProviderChart } from "./UsageProviderChart";

describe("UsageProviderChart", () => {
  it("says there is no activity instead of rendering an empty plot", () => {
    const markup = renderToStaticMarkup(
      <UsageProviderChart
        providers={["codex"]}
        days={["2026-09-18", "2026-09-19"]}
        daily={[]}
        hours={[]}
        hourly={[]}
        metric="cost"
        referenceTime={undefined}
        resolution="day"
        timeZone="UTC"
      />,
    );
    expect(markup).toContain("No activity in this window.");
    expect(markup).not.toContain("<svg");
  });
});
