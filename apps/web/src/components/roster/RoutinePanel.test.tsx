import { createTranslator } from "@akeru/client-runtime/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  boundedRunHistory,
  relativeRunTime,
  routineScheduleLabel,
  routineStatus,
  runSummaryLine,
  toRoutineSchedule,
  type RoutineAdapterItem,
  type RoutineAdapterRun,
} from "@akeru/client-runtime/routines";

import {
  focusTargetAfterRoutineDelete,
  RoutineDetail,
  RoutinePanel,
  showsWorkspacePicker,
  routineFormClosesOnOpenChange,
  runStatusPresentation,
} from "./RoutinePanel";

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
  delegateToBotId: null,
  procedureApproved: true,
  enabled: true,
  paused: false,
  pausedByAkeru: false,
  nextRunAt: "2026-09-01T13:00:00.000Z",
  lastRunAt: "2026-08-31T12:00:00.000Z",
  latestRun: run,
  runHistory: [run],
};

const detail = (item: RoutineAdapterItem, doneBy: string | null = null) =>
  renderToStaticMarkup(
    <RoutineDetail
      routine={item}
      projectName="Akeru"
      doneBy={doneBy}
      busy={false}
      onBack={() => undefined}
      onEdit={() => undefined}
      onDeleteRequest={() => undefined}
      onApproveProcedure={() => undefined}
      onDryRun={() => undefined}
      onRunNow={() => undefined}
      onSetEnabled={() => undefined}
      onSetPaused={() => undefined}
    />,
  );

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

  it("labels schedules, run times, and statuses in the client's language", () => {
    const i18n = createTranslator("zh-CN", {
      Friday: "星期五",
      "{frequency} at {time} ({timezone})": "{frequency} {time}（{timezone}）",
      "{count}h": "{count} 小时",
      "{count}d": "{count} 天",
      "in {span}": "{span}后",
      "{span} ago": "{span}前",
      Failed: "失败",
    });
    expect(
      routineScheduleLabel(
        { frequency: "weekly", time: "14:00", timezone: "Europe/London", weekday: 5 },
        i18n,
      ),
    ).toBe("星期五 14:00（Europe/London）");
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    expect(relativeRunTime("2026-09-01T15:00:00.000Z", now, i18n)).toBe("3 小时后");
    expect(relativeRunTime("2026-08-30T12:00:00.000Z", now, i18n)).toBe("2 天前");
    expect(runSummaryLine({ ...run, error: null, summary: null }, i18n)).toBe("失败");
    expect(runSummaryLine(run, i18n)).toBe("Connector timed out");
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
        delegateToBotId: null,
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

  it("names each lifecycle state with its own semantic colour", () => {
    expect(routineStatus(routine)).toEqual({ label: "Active", variant: "success" });
    expect(routineStatus({ ...routine, paused: true })).toEqual({
      label: "Paused",
      variant: "warning",
    });
    // Turned off and never approved both sit at enabled: false, but they are not
    // the same thing and do not take the same route back on.
    expect(routineStatus({ ...routine, enabled: false })).toEqual({
      label: "Off",
      variant: "secondary",
    });
    expect(routineStatus({ ...routine, enabled: false, procedureApproved: false })).toEqual({
      label: "Draft",
      variant: "secondary",
    });
  });

  it("gives every run status its own wording and dot", () => {
    expect(runStatusPresentation("completed")).toEqual({
      label: "Completed",
      variant: "success",
      dot: "bg-success",
    });
    expect(runStatusPresentation("failed").label).toBe("Failed");
    expect(runStatusPresentation("running").variant).toBe("info");
    expect(runStatusPresentation("waiting-for-approval").label).toBe("Needs approval");
    expect(runStatusPresentation("blocked").label).toBe("Blocked");
    expect(runStatusPresentation("queued").label).toBe("Queued");
    expect(runStatusPresentation("canceled").label).toBe("Canceled");
  });

  it("reduces a run to one scannable line", () => {
    expect(runSummaryLine(run)).toBe("Connector timed out");
    expect(runSummaryLine({ ...run, error: null, summary: "Sent the brief\nwith 4 links" })).toBe(
      "Sent the brief",
    );
    expect(runSummaryLine({ ...run, status: "running", error: null, summary: null })).toBe(
      "Running",
    );
  });

  it("reads times relative to now on whichever side of it they fall", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    expect(relativeRunTime("2026-09-01T15:00:00.000Z", now)).toBe("in 3h");
    expect(relativeRunTime("2026-09-01T12:20:00.000Z", now)).toBe("in 20m");
    expect(relativeRunTime("2026-08-30T12:00:00.000Z", now)).toBe("2d ago");
    expect(relativeRunTime("2026-09-01T11:59:30.000Z", now)).toBe("now");
    expect(relativeRunTime("not a date", now)).toBe("");
  });

  it("explains that a new bot's chat must start before a routine can be added", () => {
    const markup = renderToStaticMarkup(
      <RoutinePanel botName="Rivet" status="ready" routines={[]} createNeedsChat />,
    );
    expect(markup).not.toContain("New routine");
    expect(markup).toContain(
      "Routines report to your chat with Rivet. Send Rivet a message to start the chat, then add a routine here.",
    );
    expect(markup).not.toContain("ask Rivet");

    const ready = renderToStaticMarkup(
      <RoutinePanel botName="Scout" status="ready" routines={[]} onCreate={() => {}} />,
    );
    expect(ready).toContain("New routine");
    expect(ready).toContain("None yet. Ask Scout to create one.");
  });

  it("offers a header-level New routine button once the list is non-empty", () => {
    const markup = renderToStaticMarkup(
      <RoutinePanel botName="Akeru" status="ready" routines={[routine]} onCreate={() => {}} />,
    );
    expect(markup).toContain('aria-label="New routine"');
  });

  it("lists routines as cards that open, without burying destructive actions in the list", () => {
    const markup = renderToStaticMarkup(
      <RoutinePanel botName="Akeru" status="ready" routines={[routine]} />,
    );

    expect(markup).toContain(">Routines</h3>");
    expect(markup).toContain('aria-label="Open Morning brief"');
    expect(markup).toContain(">Morning brief</span>");
    expect(markup).toContain("Weekdays at 09:00 (America/New_York)");
    expect(markup).toContain(">Active</span>");
    // The card carries the run's outcome so the list reads without opening anything.
    expect(markup).toContain(">Failed</span>");
    expect(markup).toContain("Connector timed out");
    expect(markup).toContain("Next run ");
    // History stays behind its count until asked for.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("1 run");
    // Without onCreate there is still no dead create affordance anywhere.
    expect(markup).not.toContain("New routine");
    // The destructive and run controls belong to the opened routine, not to every card.
    expect(markup).not.toContain(">Run now</button>");
    expect(markup).not.toContain(">Delete</button>");
  });

  it("puts the way back on a paused or disabled card, and mutes it", () => {
    const paused = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[{ ...routine, enabled: false, paused: true }]}
        onSetPaused={() => undefined}
        onSetEnabled={() => undefined}
      />,
    );
    expect(paused).toContain(">Paused</span>");
    expect(paused).toContain(">Resume</button>");
    expect(paused).not.toContain(">Enable</button>");
    expect(paused).toContain("Paused until you resume it.");
    expect(paused).toContain("bg-muted/20");

    const off = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[{ ...routine, enabled: false }]}
        onSetEnabled={() => undefined}
      />,
    );
    expect(off).toContain(">Off</span>");
    expect(off).toContain(">Enable</button>");
    expect(off).toContain("Off until you turn it back on.");

    // A never-approved routine is approved from the detail, so the card offers no switch.
    const draft = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[{ ...routine, enabled: false, procedureApproved: false }]}
        onSetEnabled={() => undefined}
      />,
    );
    expect(draft).toContain(">Draft</span>");
    expect(draft).not.toContain(">Enable</button>");
    expect(draft).toContain("Approve its procedure to schedule it.");
  });

  it("gives an opened routine its instruction, cadence, and lifecycle actions", () => {
    const markup = detail(routine);

    expect(markup).toContain('data-testid="routine-detail"');
    expect(markup).toContain('aria-label="Back to routines"');
    expect(markup).toContain(">Instructions</h5>");
    expect(markup).toContain("Summarize the inbox and prepare the daily brief.");
    expect(markup).toContain(">When to run</h5>");
    expect(markup).toContain("Weekdays at 09:00 (America/New_York)");
    expect(markup).toContain("Sep 1");
    expect(markup).toContain(">Latest run</h5>");
    expect(markup).toContain(">Failed</span>");
    expect(markup).toContain("Connector timed out");
    expect(markup).toContain("1 run");
    expect(markup).toContain(">Test</button>");
    expect(markup).toContain(">Run now</button>");
    expect(markup).toContain(">Pause</button>");
    expect(markup).toContain(">Edit</button>");
    expect(markup).toContain(">Delete</button>");
    expect(markup).not.toContain("Done by");
  });

  it("names the bot a routine hands its work to", () => {
    const markup = detail({ ...routine, delegateToBotId: "bot-helper" }, "Scout");
    expect(markup).toContain("<dt>Done by</dt>");
    expect(markup).toContain(">Scout</dd>");
  });

  it("offers only the reverse state a routine is actually in", () => {
    const paused = detail({ ...routine, enabled: false, paused: true });
    expect(paused).toContain(">Resume</button>");
    expect(paused).not.toContain(">Pause</button>");
    expect(paused).not.toContain(">Enable</button>");

    const draft = detail({ ...routine, enabled: false });
    expect(draft).toContain(">Enable</button>");
    expect(draft).not.toContain(">Pause</button>");

    const unapproved = detail({ ...routine, enabled: false, procedureApproved: false });
    expect(unapproved).toContain(">Approve procedure</button>");
    expect(unapproved).not.toContain(">Enable</button>");
  });

  it("offers creating a routine from the empty state, keeping the chat hint secondary", () => {
    const withCreate = renderToStaticMarkup(
      <RoutinePanel
        botName="Akeru"
        status="ready"
        routines={[]}
        onCreate={() => undefined}
        projectOptions={[{ id: "project-1", name: "Akeru" }]}
      />,
    );
    expect(withCreate).toContain("New routine");
    expect(withCreate).toContain("None yet. Ask Akeru to create one.");
    // One muted line and a ghost row, not a centered card with a primary button.
    expect(withCreate).not.toContain("text-center");
    expect(withCreate).not.toContain("No routines");

    // Nothing to create with means no button that cannot do anything.
    const withoutCreate = renderToStaticMarkup(
      <RoutinePanel botName="Akeru" status="ready" routines={[]} />,
    );
    expect(withoutCreate).not.toContain("New routine");
    expect(withoutCreate).toContain("None yet. Ask Akeru to create one.");
  });

  it("keeps a saving routine form open, so one submit cannot become two routines", () => {
    // Every way out of the form — Escape, an outside press, the corner X, Cancel —
    // arrives here as a close. Honouring one mid-save unmounts the guard on the
    // request already in flight, and the next submit mints a second routine.
    expect(routineFormClosesOnOpenChange(false, true)).toBe(false);
    // Idle, it dismisses normally.
    expect(routineFormClosesOnOpenChange(false, false)).toBe(true);
    // Opening is never a close, saving or not.
    expect(routineFormClosesOnOpenChange(true, true)).toBe(false);
    expect(routineFormClosesOnOpenChange(true, false)).toBe(false);
  });

  it("sends focus to a routine that survives the delete, or to the heading when none does", () => {
    const ids = ["routine-1", "routine-2", "routine-3"];

    // The row that takes the deleted one's place in the list.
    expect(focusTargetAfterRoutineDelete(ids, "routine-2")).toBe("routine-3");
    expect(focusTargetAfterRoutineDelete(ids, "routine-1")).toBe("routine-2");
    // Nothing below it, so focus steps up instead of falling off the end.
    expect(focusTargetAfterRoutineDelete(ids, "routine-3")).toBe("routine-2");
    // The last routine leaves an empty list: null means the Routines heading.
    expect(focusTargetAfterRoutineDelete(["routine-1"], "routine-1")).toBe(null);
    expect(focusTargetAfterRoutineDelete([], "routine-1")).toBe(null);
    // A routine already gone from the projection still leaves focus in the list.
    expect(focusTargetAfterRoutineDelete(ids, "routine-9")).toBe("routine-1");
  });

  it("makes the Routines heading focusable, so a delete that empties the list has a target", () => {
    const markup = renderToStaticMarkup(
      <RoutinePanel botName="Akeru" status="ready" routines={[routine]} />,
    );

    expect(markup).toContain('tabindex="-1"');
    expect(markup).toMatch(/<h3[^>]*tabindex="-1"[^>]*>Routines<\/h3>/);
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
    // An environment that cannot run routines shows nothing to act on.
    expect(renderToStaticMarkup(<RoutinePanel botName="Akeru" status="unavailable" />)).toBe("");
  });
});

describe("showsWorkspacePicker", () => {
  it("only offers the workspace picker when there is more than one workspace", () => {
    expect(showsWorkspacePicker([])).toBe(false);
    expect(showsWorkspacePicker([{ id: "project-1", name: "Workspace" }])).toBe(false);
    expect(
      showsWorkspacePicker([
        { id: "project-1", name: "Workspace" },
        { id: "project-2", name: "Research" },
      ]),
    ).toBe(true);
  });
});
