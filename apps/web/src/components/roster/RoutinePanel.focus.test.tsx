// @effect-diagnostics nodeBuiltinImport:off - The focus contract reads its source.
import * as NodeFS from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { RoutineAdapterItem } from "@t3tools/client-runtime/routines";

import { RoutineDetail, RoutinePanel } from "./RoutinePanel";

/*
 * The unit project runs in node with no DOM, and neither jsdom nor happy-dom is
 * installed, so focus movement itself cannot be exercised here. These assert the
 * two halves that are checkable: the focus targets exist in the rendered markup,
 * and the effect that moves focus between them exists in the source.
 */

const routine: RoutineAdapterItem = {
  id: "routine-1",
  name: "Morning brief",
  prompt: "Summarize the inbox.",
  projectId: "project-1",
  sandbox: "local",
  schedule: { frequency: "weekdays", time: "09:00", timezone: "UTC", weekday: null },
  approval: "approval-required",
  skills: [],
  connectors: [],
  delegateToBotId: null,
  procedureApproved: true,
  enabled: true,
  paused: false,
  pausedByAkeru: false,
  nextRunAt: null,
  lastRunAt: null,
  latestRun: null,
  runHistory: [],
};

describe("RoutinePanel focus targets", () => {
  it("marks each row so the one you came from can be restored", () => {
    const markup = renderToStaticMarkup(
      <RoutinePanel botName="Akeru" status="ready" routines={[routine]} />,
    );
    expect(markup).toContain('data-routine-row="routine-1"');
  });

  it("marks the detail's Back control as the target focus moves to", () => {
    const markup = renderToStaticMarkup(
      <RoutineDetail
        routine={routine}
        projectName="Akeru"
        busy={false}
        onBack={() => undefined}
        onEdit={() => undefined}
        onDeleteRequest={() => undefined}
      />,
    );
    expect(markup).toContain("data-routine-back");
  });

  it("moves focus in on open and back to the originating row on return", () => {
    const source = NodeFS.readFileSync(new URL("./RoutinePanel.tsx", import.meta.url), "utf8");

    expect(source).toContain('querySelector<HTMLElement>("[data-routine-back]")?.focus()');
    expect(source).toContain('querySelectorAll<HTMLElement>("[data-routine-row]")');
    expect(source).toContain("previousOpenId");
    expect(source).toContain("row.focus()");
  });
});
