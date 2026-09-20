import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PLAN_PROVIDER_ORDER, UsagePlanMeters } from "./UsageCharts";

describe("PLAN_PROVIDER_ORDER", () => {
  it("lists current Akeru plan providers without Cursor", () => {
    expect(PLAN_PROVIDER_ORDER).toEqual([
      "openai-codex",
      "anthropic",
      "xai",
      "kimi-for-coding",
      "opencode-go",
    ]);
  });
});

describe("UsagePlanMeters", () => {
  it("renders the ChatGPT logo without a public asset request", () => {
    const markup = renderToStaticMarkup(
      <UsagePlanMeters
        limits={{
          provider: "openai-codex",
          status: "ok",
          plan: "Pro",
          message: null,
          windows: [],
        }}
      />,
    );

    expect(markup).toContain("ChatGPT · Pro");
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("/provider-icons/openai.svg");
  });
});
