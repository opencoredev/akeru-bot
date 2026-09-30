import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AkeruDelegationRecord,
  BotId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationState,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activities: [] as OrchestrationThreadActivity[],
  cancel: vi.fn(),
  retry: vi.fn(),
  toast: vi.fn(),
  // The in-flight action a mounted card would hold after a click.
  pendingAction: null as string | null,
  navigate: vi.fn(),
  recordChatPath: vi.fn(),
  setState: vi.fn(),
  thread: null as OrchestrationThreadShell | null,
  // When set, external stores subscribe like a mounted component would.
  clockCleanups: null as Array<() => void> | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T) => [
      initial === null ? (mocks.pendingAction as T) : initial,
      mocks.setState,
    ],
    useSyncExternalStore: <T,>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T,
    ) => {
      mocks.clockCleanups?.push(subscribe(() => undefined));
      return getSnapshot();
    },
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock("../../state/entities", () => ({
  useThreadActivities: () => mocks.activities,
  useThreadMessages: () => [],
  useThreadShell: () => mocks.thread,
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => text }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    cancelDelegation: "cancelDelegation",
    retryDelegation: "retryDelegation",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "retryDelegation" ? mocks.retry : mocks.cancel),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./rosterStore", () => ({
  useRosterStore: { getState: () => ({ recordChatPath: mocks.recordChatPath }) },
}));

import { DelegationCard, delegationUsageTokens } from "./DelegationCard";
import { DelegationDetail } from "./DelegationDetail";
import { delegationClockState } from "./delegationClock";
import { visitElements } from "../../test/reactElementTree";
import type { Bot } from "./types";

const decodeDelegationRecord = Schema.decodeUnknownSync(AkeruDelegationRecord);

const parentBot: Bot = {
  id: "bot-parent",
  name: "Mira",
  title: "Lead",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: "mira" },
  engine: null,
  sandbox: "local",
  runtimeMode: "approval-required",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  pinned: false,
  archivedAt: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const childBot: Bot = {
  id: "bot-child",
  name: "Mori",
  title: "Researcher",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: "mori" },
  engine: null,
  sandbox: "local",
  runtimeMode: "approval-required",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  pinned: false,
  archivedAt: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const childThread = {
  id: ThreadId.make("thread-child"),
  projectId: ProjectId.make("project-1"),
  botId: BotId.make("bot-child"),
  groupId: null,
  respondingBotId: BotId.make("bot-child"),
  title: "Delegated research",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-31T00:00:10.000Z",
  updatedAt: "2026-08-31T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} satisfies OrchestrationThreadShell;

const CHILD_RUN = {
  childThreadId: "thread-child",
  childTurnId: "turn-child",
  startedAt: "2026-08-31T00:00:10.000Z",
};
const FINISHED_AT = "2026-08-31T00:01:00.000Z";

function phaseFor(state: AkeruDelegationState) {
  switch (state) {
    case "queued":
      return { _tag: "Queued" };
    case "running":
      return { _tag: "Running", ...CHILD_RUN, progress: null };
    case "blocked":
      return { _tag: "Blocked", ...CHILD_RUN, reason: "The provider is blocked." };
    case "completed":
      return {
        _tag: "Completed",
        ...CHILD_RUN,
        completedAt: FINISHED_AT,
        acknowledgedAt: null,
        result: {
          summary: "Release comparison complete.",
          childThreadId: "thread-child",
          childTurnId: "turn-child",
        },
      };
    case "failed":
      return {
        _tag: "Failed",
        ...CHILD_RUN,
        completedAt: FINISHED_AT,
        acknowledgedAt: null,
        failure: { failureCode: "child_failed", message: "The provider stopped." },
      };
    case "canceled":
      return { _tag: "Canceled", ...CHILD_RUN, completedAt: FINISHED_AT, canceledBy: "user" };
  }
}

function delegation(state: AkeruDelegationState, overrides: Record<string, unknown> = {}) {
  return decodeDelegationRecord({
    delegationId: `delegation-${state}`,
    parentDelegationId: null,
    parentBotId: "bot-parent",
    childBotId: "bot-child",
    parentThreadId: "thread-parent",
    parentTurnId: "turn-parent",
    ancestorBotIds: ["bot-parent"],
    depth: 1,
    task: "Compare the release options.",
    expectedResult: "A short comparison.",
    deadline: null,
    access: {
      allowedToolIds: ["Read"],
      memoryScopes: ["project"],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "none",
    },
    billedBotId: "bot-child",
    phase: phaseFor(state),
    keep: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:01:00.000Z",
    ...overrides,
  });
}

function usage(turnId: string, totalProcessedTokens: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(`usage-${turnId}`),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens: totalProcessedTokens, totalProcessedTokens },
    turnId: TurnId.make(turnId),
    createdAt: "2026-08-31T00:00:40.000Z",
  };
}

function renderCard(
  state: AkeruDelegationState,
  bot: Bot | null = childBot,
  parent: Bot | null = parentBot,
) {
  return renderToStaticMarkup(
    <DelegationCard
      delegation={delegation(state)}
      delegations={[]}
      childBot={bot}
      parentBot={parent}
    />,
  );
}

function cardElement(state: AkeruDelegationState, bot: Bot | null = childBot) {
  return DelegationCard({
    delegation: delegation(state),
    delegations: [],
    childBot: bot,
    parentBot,
  }) as ReactElement<Record<string, unknown>>;
}

/** Finds an element by aria-label, calling nested function components on the way. */
function findByLabel(node: unknown, label: string): ReactElement<Record<string, unknown>> | null {
  let found: ReactElement<Record<string, unknown>> | null = null;
  visitElements(node, (element) => {
    if (found) return true;
    if (element.props["aria-label"] === label) {
      found = element;
      return true;
    }
    if (typeof element.type === "function" && element.type.name.startsWith("Delegation")) {
      found = findByLabel((element.type as (props: unknown) => unknown)(element.props), label);
    }
    return found !== null;
  });
  return found;
}

function detailElement(bot: Bot | null = childBot, onOpenChange = vi.fn()) {
  return DelegationDetail({
    delegation: delegation("running"),
    childBot: bot,
    parentBot,
    onOpenChange,
  });
}

describe("DelegationCard", () => {
  beforeEach(() => {
    mocks.activities = [usage("other-turn", 99_999), usage("turn-child", 1_234)];
    mocks.thread = childThread;
    mocks.cancel.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
    mocks.retry.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
    mocks.toast.mockReset();
    mocks.pendingAction = null;
    mocks.navigate.mockReset().mockResolvedValue(undefined);
    mocks.recordChatPath.mockReset();
    mocks.setState.mockReset();
    mocks.clockCleanups = null;
  });

  it.each(["queued", "running", "blocked", "failed", "canceled", "completed"] as const)(
    "shows the exact %s state",
    (state) => {
      const markup = renderCard(state);
      expect(markup).toContain(`aria-live="polite">${state}</span>`);
    },
  );

  it("shows result and failure text without mixing them", () => {
    const complete = renderCard("completed");
    expect(complete).toContain("Release comparison complete.");
    expect(complete).not.toContain("The provider stopped.");

    const failed = renderCard("failed");
    expect(failed).toContain("The provider stopped.");
    expect(failed).not.toContain("Release comparison complete.");
  });

  it("shows why blocked work is waiting", () => {
    expect(renderCard("blocked")).toContain("The provider is blocked.");
  });

  it("shows whether the parent bot has received a finished result", () => {
    expect(renderCard("completed")).toContain("Result waiting for the next reply");
    expect(renderCard("failed")).toContain("Result waiting for the next reply");
    expect(renderCard("running")).not.toContain("Result waiting");
    expect(renderCard("canceled")).not.toContain("Result");

    const completed = delegation("completed");
    if (completed.phase._tag !== "Completed") throw new Error("Expected a completed delegation");
    expect(
      renderToStaticMarkup(
        <DelegationCard
          delegation={{
            ...completed,
            phase: { ...completed.phase, acknowledgedAt: "2026-08-31T00:02:00.000Z" },
          }}
          delegations={[]}
          childBot={childBot}
          parentBot={parentBot}
        />,
      ),
    ).toContain("Result delivered to Mira");
  });

  it("shows fallback text when terminal details are missing", () => {
    const completed = delegation("completed");
    const failed = delegation("failed");
    if (completed.phase._tag !== "Completed" || failed.phase._tag !== "Failed") {
      throw new Error("Expected completed and failed delegations");
    }
    expect(
      renderToStaticMarkup(
        <DelegationCard
          delegation={{ ...completed, phase: { ...completed.phase, result: null as never } }}
          delegations={[]}
          childBot={childBot}
          parentBot={parentBot}
        />,
      ),
    ).toContain("Result unavailable");
    expect(
      renderToStaticMarkup(
        <DelegationCard
          delegation={{ ...failed, phase: { ...failed.phase, failure: null as never } }}
          delegations={[]}
          childBot={childBot}
          parentBot={parentBot}
        />,
      ),
    ).toContain("Failure details unavailable");
  });

  it("shows a start failure as the bot-named readable line", () => {
    const failed = delegation("failed");
    if (failed.phase._tag !== "Failed") throw new Error("Expected a failed delegation");
    const message =
      "Ren could not start: Provider instance 'codex' is disabled in Akeru Bot settings.";
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={{
          ...failed,
          phase: { ...failed.phase, failure: { failureCode: "child_failed", message } },
        }}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
      />,
    );

    expect(markup).toContain(
      "Ren could not start: Provider instance &#x27;codex&#x27; is disabled",
    );
    expect(markup).not.toContain("ProviderValidationError");
    expect(markup).not.toContain("file://");
  });

  it("shows elapsed time and the access grant", () => {
    const markup = renderCard("completed");
    expect(markup).toContain(">50s</span>");
    expect(markup).toContain("approval required · local sandbox · tools: Read");
    expect(markup).toContain("memory: project · MCP servers: 0 · no user computer · no approvals");
  });

  it("shows hours for work that ran an hour or more", () => {
    const completed = delegation("completed");
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={{
          ...completed,
          phase: {
            ...completed.phase,
            startedAt: "2026-08-30T16:12:17.000Z",
          } as typeof completed.phase,
        }}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
      />,
    );
    expect(markup).toContain(">7h 48m</span>");
  });

  it("uses only the delegated child turn usage", () => {
    expect(delegationUsageTokens(delegation("completed"), mocks.activities)).toBe(1_234);
    expect(delegationUsageTokens(delegation("queued"), mocks.activities)).toBeNull();
    const markup = renderCard("completed");
    expect(markup).toContain('aria-label="1,234 tokens billed to Mori"');
    expect(markup).not.toContain("100K");
  });

  it("cancels through the delegation command with keep disabled", async () => {
    const cancel = findByLabel(cardElement("running"), "Cancel delegation to Mori");
    (cancel?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: { delegationId: delegation("running").delegationId, keep: false },
    });
  });

  it.each(["failed", "canceled", "completed"] as const)(
    "hides cancel for the terminal %s state",
    (state) => {
      expect(renderCard(state)).not.toContain(`aria-label="Cancel delegation to Mori"`);
    },
  );

  it("offers let it finish and cancel while the work is live", () => {
    const markup = renderCard("running");
    expect(markup).toContain('aria-label="Let Mori finish the work"');
    expect(markup).toContain('aria-label="Cancel delegation to Mori"');
    expect(markup).not.toContain('aria-label="Ask Mori to try again"');
  });

  it("lets the work finish through the delegation command with keep enabled", async () => {
    const keep = findByLabel(cardElement("running"), "Let Mori finish the work");
    (keep?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(mocks.setState).toHaveBeenCalledWith("keep");
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: { delegationId: delegation("running").delegationId, keep: true },
    });
  });

  it("drops let it finish once the work is already kept", () => {
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={delegation("running", { keep: true })}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
      />,
    );
    expect(markup).not.toContain("Let Mori finish the work");
    expect(markup).toContain('aria-label="Cancel delegation to Mori"');
  });

  it.each(["failed", "canceled"] as const)("offers try again for %s work", async (state) => {
    expect(renderCard(state)).not.toContain("Let Mori finish the work");
    const retry = findByLabel(cardElement(state), "Ask Mori to try again");
    (retry?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(mocks.retry).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: { delegationId: delegation(state).delegationId },
    });
  });

  it("offers no try again once another card retries the work", () => {
    const failed = delegation("failed");
    const retry = delegation("running", {
      delegationId: "delegation-retry",
      retryOfDelegationId: failed.delegationId,
    });
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={failed}
        delegations={[failed, retry]}
        childBot={childBot}
        parentBot={parentBot}
      />,
    );
    expect(markup).not.toContain("Ask Mori to try again");
    expect(markup).toContain('aria-label="View Mori&#x27;s work"');
  });

  it("shows no reverse-state action for completed work", () => {
    const markup = renderCard("completed");
    expect(markup).not.toContain("Let Mori finish the work");
    expect(markup).not.toContain("Ask Mori to try again");
  });

  it("disables every action while one is in flight", () => {
    mocks.pendingAction = "keep";
    const card = cardElement("running");
    expect(findByLabel(card, "Let Mori finish the work")?.props.disabled).toBe(true);
    expect(findByLabel(card, "Let Mori finish the work")?.props["aria-busy"]).toBe(true);
    expect(findByLabel(card, "Cancel delegation to Mori")?.props.disabled).toBe(true);
  });

  it("explains a rejected retry in a toast and clears the busy state", async () => {
    mocks.retry.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("This bot already has 3 bot work items running.")),
    });
    const retry = findByLabel(cardElement("failed"), "Ask Mori to try again");
    await (retry?.props.onClick as (() => Promise<void>) | undefined)?.();
    expect(mocks.setState).toHaveBeenLastCalledWith(null);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not retry the work",
      description: "This bot already has 3 bot work items running.",
    });
  });

  it("opens the read-only work view from the card", () => {
    const view = findByLabel(cardElement("running"), "View Mori's work");
    (view?.props.onClick as (() => void) | undefined)?.();
    expect(mocks.setState).toHaveBeenCalledWith(true);
    expect(renderCard("queued")).toMatch(/aria-label="View Mori&#x27;s work" disabled=""/);
  });

  it("opens the child bot's own chat, not the child work thread, from the work view", () => {
    const onOpenChange = vi.fn();
    const open = findByLabel(detailElement(childBot, onOpenChange), "Open Mori chat");
    (open?.props.onClick as (() => void) | undefined)?.();
    expect(mocks.recordChatPath).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/bots/$botId",
      params: { botId: "bot-child" },
    });
  });

  it("handles a missing child without enabling a false route", () => {
    mocks.thread = null;
    const markup = renderCard("running", null);
    expect(markup).toContain("Unknown bot");
    expect(markup).not.toContain("tokens billed");
    expect(findByLabel(detailElement(null), "Open Unknown bot chat")?.props.disabled).toBe(true);
  });

  it("treats an archived child as unavailable", () => {
    const archived = { ...childBot, archivedAt: "2026-08-31T00:02:00.000Z" };
    expect(renderCard("running", archived)).toContain("Unknown bot");
    expect(findByLabel(detailElement(archived), "Open Unknown bot chat")?.props.disabled).toBe(
      true,
    );
  });

  it("names both actions for assistive technology", () => {
    const markup = renderCard("running");
    expect(markup).toContain('aria-label="Cancel delegation to Mori"');
    expect(markup).toContain('aria-label="View Mori&#x27;s work"');
  });

  it("keeps tool ids and MCP counts off the card face", () => {
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={delegation("running", {
          access: {
            allowedToolIds: ["ExternalShell", "WebFetch"],
            memoryScopes: ["project"],
            sandbox: "local",
            runtimeMode: "approval-required",
            hasUserComputer: false,
            enabledMcpServerIds: ["github", "linear"],
            disabledMcpServerIds: [],
            approvalCeiling: "none",
          },
        })}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
      />,
    );
    const [face, details] = markup.split("<details");
    expect(face).not.toContain("ExternalShell");
    expect(face).not.toContain("MCP servers");
    expect(face).not.toContain("tools:");
    expect(details).toContain("tools: ExternalShell, WebFetch");
    expect(details).toContain("MCP servers: 2");
  });

  it("names the asking bot on group cards", () => {
    const group = renderToStaticMarkup(
      <DelegationCard
        delegation={delegation("running")}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
        variant="group"
      />,
    );
    expect(group).toContain("Mira asked Mori");
    expect(renderCard("running")).not.toContain("asked");
    expect(
      renderToStaticMarkup(
        <DelegationCard
          delegation={delegation("running")}
          delegations={[]}
          childBot={childBot}
          parentBot={null}
          variant="group"
        />,
      ),
    ).toContain("Unknown bot asked Mori");
  });

  it("labels scheduled and retried work", () => {
    expect(renderCard("running")).not.toMatch(/>Scheduled<|>Retried</);
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={delegation("running", {
          trigger: "scheduled",
          retryOfDelegationId: "delegation-earlier",
        })}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
      />,
    );
    expect(markup).toContain(">Scheduled</span>");
    expect(markup).toContain(">Retried</span>");
  });

  it("lets the actions slot replace the default cancel control", () => {
    const markup = renderToStaticMarkup(
      <DelegationCard
        delegation={delegation("running")}
        delegations={[]}
        childBot={childBot}
        parentBot={parentBot}
        actions={<button type="button">Let it finish</button>}
      />,
    );
    expect(markup).toContain("Let it finish");
    expect(markup).not.toContain("Cancel delegation to Mori");
    expect(markup).toContain('aria-label="View Mori&#x27;s work"');
  });

  it("runs one shared timer for every live card and none for finished cards", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const cleanups: Array<() => void> = [];
    mocks.clockCleanups = cleanups;
    try {
      for (const state of ["running", "queued", "blocked", "completed", "failed"] as const) {
        renderCard(state);
      }
      expect(delegationClockState()).toEqual({ subscribers: 3, ticking: true });
      expect(setInterval).toHaveBeenCalledTimes(1);
    } finally {
      for (const cleanup of cleanups) cleanup();
      setInterval.mockRestore();
    }
    expect(delegationClockState()).toEqual({ subscribers: 0, ticking: false });
  });
});
