import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  boundedRunHistory,
  RoutinePanel,
  routineScheduleLabel,
  type RoutineAdapterItem,
  type RoutineAdapterRun,
} from "./RoutinePanel";
import { toRoutineSchedule } from "./routineAdapter";

const run: RoutineAdapterRun = {
  id: "run-1",
  status: "failed",
  startedAt: "2026-08-31T12:00:00.000Z",
  finishedAt: "2026-08-31T12:01:00.000Z",
  summary: null,
  error: "Connector timed out",
  usage: "1,240 tokens",
};

const routine: RoutineAdapterItem = {
  id: "routine-1",
  name: "Morning brief",
  prompt: "Summarize the inbox and prepare the daily brief.",
  projectId: "project-1",
  sandbox: "local",
  schedule: {
    frequency: "weekdays",
    time: "09:00",
    timezone: "America/New_York",
    weekday: null,
  },
  approval: "approval-required",
  skills: ["research"],
  connectors: ["Gmail"],
  procedureApproved: true,
  enabled: true,
  paused: false,
  nextRunAt: "2026-09-01T13:00:00.000Z",
  lastRunAt: "2026-08-31T12:00:00.000Z",
  latestRun: run,
  runHistory: [run],
};

describe("RoutinePanel", () => {
  it("formats each supported schedule", () => {
    expect(routineScheduleLabel(routine.schedule)).toBe("Weekdays at 09:00 (America/New_York)");
    expect(
      routineScheduleLabel({
        frequency: "daily",
        time: "08:30",
        timezone: "UTC",
        weekday: null,
      }),
    ).toBe("Daily at 08:30 (UTC)");
    expect(
      routineScheduleLabel({
        frequency: "weekly",
        time: "14:00",
        timezone: "Europe/London",
        weekday: 5,
      }),
    ).toBe("Friday at 14:00 (Europe/London)");
  });

  it("maps the selected weekly day to the routine contract", () => {
    expect(
      toRoutineSchedule({
        name: "Friday review",
        prompt: "Review the week.",
        projectId: "project-1",
        sandbox: "local",
        schedule: {
          frequency: "weekly",
          time: "14:00",
          timezone: "Europe/London",
          weekday: 5,
        },
        approval: "approval-required",
        skills: [],
        connectors: [],
      }),
    ).toEqual({ kind: "weekly", weekdays: ["friday"], time: "14:00" });
  });

  it("limits rendered run history data", () => {
    const history = Array.from({ length: 7 }, (_, index) => ({
      ...run,
      id: `run-${index}`,
    }));
    expect(boundedRunHistory(history).map((item) => item.id)).toEqual([
      "run-0",
      "run-1",
      "run-2",
      "run-3",
      "run-4",
    ]);
  });

  it("renders routine controls and the latest failure", () => {
    const markup = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[routine]}
        onDryRun={() => undefined}
        onRunNow={() => undefined}
        onSetPaused={() => undefined}
      />,
    );

    expect(markup).toContain(">Routines</h3>");
    expect(markup).not.toContain("New routine");
    expect(markup).toContain(">Morning brief</h4>");
    expect(markup).toContain("Weekdays at 09:00 (America/New_York)");
    expect(markup).toContain("Connector timed out");
    expect(markup).not.toContain("Usage reference: 1,240 tokens");
    expect(markup).toContain("Next Sep 1");
    expect(markup).toContain(">Dry run</button>");
    expect(markup).toContain(">Run now</button>");
    expect(markup).toContain(">Pause</button>");
    expect(markup).toContain(">Edit</button>");
  });

  it("renders loading, empty, error, and unavailable states", () => {
    expect(renderToStaticMarkup(<RoutinePanel botName="Akeru" status="loading" />)).toContain(
      'aria-label="Loading routines"',
    );
    expect(
      renderToStaticMarkup(<RoutinePanel botName="Akeru" status="ready" routines={[]} />),
    ).toContain("Ask Akeru to create one.");
    expect(
      renderToStaticMarkup(<RoutinePanel botName="Akeru" status="error" error="Request failed" />),
    ).toContain("Request failed");
    expect(renderToStaticMarkup(<RoutinePanel botName="Akeru" status="unavailable" />)).toContain(
      "Routines are not available for this environment.",
    );
  });

  it("shows approval and reverse-state actions", () => {
    const needsApproval: RoutineAdapterItem = {
      ...routine,
      procedureApproved: false,
      latestRun: { ...run, status: "waiting-for-approval", error: null },
    };
    const disabled = { ...routine, id: "disabled", enabled: false };
    const paused = { ...routine, id: "paused", enabled: false, paused: true };
    const markup = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[needsApproval, disabled, paused]}
        onApproveProcedure={() => undefined}
        onSetEnabled={() => undefined}
        onSetPaused={() => undefined}
      />,
    );

    expect(markup).toContain(">Approve procedure</button>");
    expect(markup).toContain(">Enable</button>");
    expect(markup).toContain(">Resume</button>");
    expect(markup).toContain(">Delete</button>");

    const needsApprovalMarkup = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[{ ...needsApproval, enabled: false }]}
        onApproveProcedure={() => undefined}
        onSetEnabled={() => undefined}
        onSetPaused={() => undefined}
      />,
    );
    expect(needsApprovalMarkup).not.toContain(">Enable</button>");
    expect(needsApprovalMarkup).not.toContain(">Pause</button>");

    const pausedMarkup = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[paused]}
        onSetEnabled={() => undefined}
        onSetPaused={() => undefined}
      />,
    );
    expect(pausedMarkup).toContain(">Resume</button>");
    expect(pausedMarkup).not.toContain(">Enable</button>");
  });
});
