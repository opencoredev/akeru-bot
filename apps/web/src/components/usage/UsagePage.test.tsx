import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
}));

vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/dialog", () => ({
  DialogHeader: "header",
  DialogPanel: "div",
  DialogTitle: "h1",
  DialogClose: (props: { children?: ReactNode }) => <button type="button">{props.children}</button>,
}));
vi.mock("./UsageCharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./UsageCharts")>();
  return {
    ...actual,
    UsagePlanMeters: (props: {
      limits: { provider: string; windows: { label: string; usedPercent: number }[] };
    }) => (
      <div>
        {props.limits.provider}{" "}
        {props.limits.windows
          .map((window) => `${window.label} ${Math.round(100 - window.usedPercent)}% left`)
          .join(" ")}
      </div>
    ),
    UsageActivityChart: () => <div>activity-chart</div>,
  };
});

import { UsagePage } from "./UsagePage";

const connectedPlanLimits = [
  {
    provider: "openai-codex" as const,
    status: "ok" as const,
    plan: "Pro",
    message: null,
    windows: [
      { kind: "weekly" as const, label: "Weekly", usedPercent: 45, resetsAt: null },
      { kind: "session" as const, label: "Spark 5-hour", usedPercent: 0, resetsAt: null },
    ],
  },
  {
    provider: "anthropic" as const,
    status: "failed" as const,
    plan: null,
    message: "Run claude and sign in.",
    windows: [],
  },
];

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: {
      ...mergeUsage([], USAGE_CONTRACT_VERSION),
      planLimits: connectedPlanLimits,
    },
    environments: [
      {
        environmentId: "env-1",
        label: "This Mac",
        isPending: false,
        error: null,
        summary: { contractVersion: USAGE_CONTRACT_VERSION },
      },
    ],
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage", () => {
  it("shows remaining plan for connected providers only", () => {
    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("Weekly 55% left");
    expect(markup).toContain("Spark 5-hour 100% left");
    expect(markup).toContain("openai-codex");
    expect(markup).not.toContain("Run claude and sign in");
    expect(markup).not.toContain("anthropic");
  });

  it("stays quiet while the first scan is still in flight", () => {
    testState.useUsage.mockReturnValue({
      merged: mergeUsage([], USAGE_CONTRACT_VERSION),
      environments: [
        {
          environmentId: "env-1",
          label: "This Mac",
          isPending: true,
          error: null,
          summary: null,
        },
      ],
      isPending: true,
      isPartial: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).not.toContain("Reading plan limits");
    expect(markup).not.toContain("Weekly 55% left");
    expect(markup).not.toContain("Connect a subscription");
    expect(markup).not.toContain("Connect an environment");
    expect(markup).toContain("Activity");
    expect(markup).not.toContain("animate-spin");
  });

  it("keeps arrived plan limits visible while another environment is still reporting", () => {
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        planLimits: connectedPlanLimits,
      },
      environments: [
        {
          environmentId: "env-1",
          label: "This Mac",
          isPending: false,
          error: null,
          summary: { contractVersion: USAGE_CONTRACT_VERSION },
        },
        {
          environmentId: "env-2",
          label: "Office",
          isPending: true,
          error: null,
          summary: null,
        },
      ],
      isPending: false,
      isPartial: true,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("Weekly 55% left");
    expect(markup).not.toContain("Reading plan limits");
    expect(markup).toContain("Activity");
    expect(markup).toContain("activity-chart");
    expect(markup).not.toContain("animate-spin");
  });

  it("shows a connected Claude card when windows have not arrived yet", () => {
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        planLimits: [
          {
            provider: "anthropic" as const,
            status: "ok" as const,
            plan: null,
            message: null,
            windows: [],
          },
        ],
      },
      environments: [
        {
          environmentId: "env-1",
          label: "This Mac",
          isPending: false,
          error: null,
          summary: { contractVersion: USAGE_CONTRACT_VERSION },
        },
      ],
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);
    expect(markup).toContain("anthropic");
  });

  it("labels model activity by its transcript provider, not its model name", () => {
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        models: [
          {
            provider: "codex" as const,
            model: "claude-opus-5",
            costUsd: 0,
            totalTokens: 31_000_000,
            records: 1,
            costShare: 0,
          },
          {
            provider: "claude" as const,
            model: "gpt-5.6-sol",
            costUsd: 0,
            totalTokens: 1_000,
            records: 1,
            costShare: 0,
          },
        ],
      },
      environments: [
        {
          environmentId: "env-1",
          label: "This Mac",
          isPending: false,
          error: null,
          summary: { contractVersion: USAGE_CONTRACT_VERSION },
        },
      ],
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("Codex · claude-opus-5");
    expect(markup).toContain("Claude · gpt-5.6-sol");
    expect(markup).not.toContain("Claude · claude-opus-5");
  });
});
