import { EnvironmentId, USAGE_CONTRACT_VERSION, UsageDay } from "@t3tools/contracts";
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
import { saveUsagePagePreferences } from "./usagePagePreferences";

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
  saveUsagePagePreferences({ metric: "limits", windowDays: 30 });
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
    expect(markup).not.toContain("Activity");
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
    expect(markup).not.toContain("Activity");
    expect(markup).not.toContain("activity-chart");
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

  it("labels model activity by its recorded provider, not its model name", () => {
    saveUsagePagePreferences({ metric: "tokens", windowDays: 30 });
    testState.useUsage.mockReturnValue({
      merged: {
        ...mergeUsage([], USAGE_CONTRACT_VERSION),
        connectedProviders: ["openai-codex" as const, "anthropic" as const],
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

  it("does not show machine-wide transcript costs when no provider is connected", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 30 });
    const summary = {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-09-13T00:00:00.000Z",
      timeZone: "UTC",
      sinceDay: UsageDay.make("2026-08-15"),
      untilDay: UsageDay.make("2026-09-13"),
      buckets: [
        {
          day: UsageDay.make("2026-09-13"),
          provider: "codex" as const,
          model: "gpt-5.6-sol",
          totals: {
            uncachedInputTokens: 1_000,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 100,
            reasoningTokens: 0,
          },
          costUsd: 12.34,
          cacheSavingsUsd: 0,
          costSource: "modelPriced" as const,
          records: 1,
          unpricedRecords: 0,
          sessions: 1,
        },
      ],
      sources: [
        {
          fingerprint: {
            hostId: "test-machine",
            provider: "codex" as const,
            resolvedHomePath: "/home/test/.codex/sessions",
            volumeId: "1:1",
          },
          status: "ok" as const,
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 1,
          message: null,
        },
      ],
      planLimits: [],
      connectedProviders: [],
      pricing: { status: "fresh" as const, source: "litellm", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    };
    testState.useUsage.mockReturnValue({
      merged: mergeUsage(
        [{ environmentId: EnvironmentId.make("env-1"), label: "This Mac", summary }],
        USAGE_CONTRACT_VERSION,
      ),
      environments: [
        {
          environmentId: "env-1",
          label: "This Mac",
          isPending: false,
          error: null,
          summary,
        },
      ],
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).not.toContain("$12.34");
    expect(markup).toContain("Connect a provider in Settings");
  });

  it("explains stale environment coverage before suggesting a provider connection", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 30 });
    const staleSummary = {
      contractVersion: USAGE_CONTRACT_VERSION - 1,
      readAt: "2026-09-13T00:00:00.000Z",
      timeZone: "UTC",
      sinceDay: UsageDay.make("2026-08-15"),
      untilDay: UsageDay.make("2026-09-13"),
      buckets: [],
      sources: [],
      planLimits: [],
      connectedProviders: ["openai-codex" as const],
      pricing: { status: "fresh" as const, source: "litellm", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    };
    testState.useUsage.mockReturnValue({
      merged: mergeUsage(
        [
          {
            environmentId: EnvironmentId.make("env-1"),
            label: "This Mac",
            summary: staleSummary,
          },
        ],
        USAGE_CONTRACT_VERSION,
      ),
      environments: [
        {
          environmentId: "env-1",
          label: "This Mac",
          isPending: false,
          error: null,
          summary: staleSummary,
        },
      ],
      isPending: false,
      isPartial: false,
      refresh: vi.fn(),
    });

    const markup = renderToStaticMarkup(<UsagePage />);

    expect(markup).toContain("This Mac runs an older server version");
    expect(markup).not.toContain("Connect a provider in Settings");
  });
});
