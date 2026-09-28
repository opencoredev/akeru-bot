import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  type DesktopOnboardingDraft,
} from "./desktopOnboarding.logic";

const state = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    // The step's only effect clears the pending beat on unmount, which a
    // plain-function render never reaches.
    useEffect: () => {},
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: unknown }) => children,
  motion: { div: "div", li: "li" },
  useReducedMotion: () => state.reducedMotion,
}));

import { OnboardingGoalStep } from "./OnboardingGoalStep";

type Element = ReactElement<Record<string, unknown>>;

/**
 * The step renders through small local components, and a plain-function render
 * never calls them, so the walk expands those on the way past. UI primitives
 * are left alone: their element props are exactly what the assertions read.
 */
const LOCAL_COMPONENTS = new Set(["GoalExamples", "GoalThinking", "GoalPlanView"]);

function visitElements(node: unknown, visitor: (element: Element) => boolean): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = visitElements(child, visitor);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as Element;
  if (visitor(element)) return element;
  const type = element.type as { name?: string };
  if (typeof type === "function" && LOCAL_COMPONENTS.has(type.name ?? "")) {
    const found = visitElements(
      (type as unknown as (props: unknown) => unknown)(element.props),
      visitor,
    );
    if (found) return found;
  }
  for (const value of Object.values(element.props as Record<string, unknown>)) {
    const found = visitElements(value, visitor);
    if (found) return found;
  }
  return null;
}

/** Flattens the visible text under a node, so assertions read what a user would. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as Element).props.children);
  return "";
}

let draft: DesktopOnboardingDraft;
const onChange = vi.fn((next: DesktopOnboardingDraft) => {
  draft = next;
});
const onBack = vi.fn();
const onContinue = vi.fn();

function render(): Element {
  hooks.beginRender();
  return OnboardingGoalStep({ draft, onChange, onBack, onContinue }) as Element;
}

/** Controls are matched on what a user would click: their label or their text. */
function button(tree: Element, label: string): Element {
  const found = visitElements(
    tree,
    (element) =>
      typeof element.props.onClick === "function" &&
      (element.props["aria-label"] === label || textOf(element.props.children).trim() === label),
  );
  expect(found, `no "${label}" control`).not.toBeNull();
  return found as Element;
}

function press(tree: Element, label: string): void {
  (button(tree, label).props.onClick as (() => void) | undefined)?.();
}

function heading(tree: Element): string {
  const found = visitElements(tree, (element) => element.props.id === "onboarding-goal-heading");
  return textOf(found?.props.children);
}

function field(tree: Element): Element | null {
  return visitElements(
    tree,
    (element) => element.props["aria-labelledby"] === "onboarding-goal-heading",
  );
}

function type(tree: Element, value: string): void {
  const answer = field(tree);
  expect(answer, "no answer field").not.toBeNull();
  (answer?.props.onChange as ((event: { currentTarget: { value: string } }) => void) | undefined)?.(
    { currentTarget: { value } },
  );
}

function statusText(tree: Element): string {
  const found = visitElements(
    tree,
    (element) => element.props.role === "status" && element.props["aria-live"] === "polite",
  );
  return textOf(found?.props.children);
}

function byTestId(tree: Element, testId: string): Element | null {
  return visitElements(tree, (element) => element.props["data-testid"] === testId);
}

/** The steps as a user reads them: the move itself, not the number beside it. */
function planSteps(tree: Element): readonly string[] {
  const list = byTestId(tree, "onboarding-goal-plan-steps");
  const children = list?.props.children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => {
    const parts = isValidElement(child) ? (child as Element).props.children : null;
    return textOf(Array.isArray(parts) ? parts.at(-1) : child).trim();
  });
}

/** Answers the one question and plays the beat that leads to the plan. */
function answer(value: string): void {
  type(render(), value);
  press(render(), "Continue");
  vi.advanceTimersByTime(2_000);
}

function stubWindow(): void {
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  state.reducedMotion = false;
  draft = { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, step: "goal" };
  stubWindow();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("onboarding goal step", () => {
  it("asks one open question and nothing else", () => {
    const tree = render();
    expect(heading(tree)).toBe("What do you want help with?");
    expect(byTestId(tree, "onboarding-goal-thinking")).toBeNull();
    expect(byTestId(tree, "onboarding-goal-plan")).toBeNull();
  });

  it("offers starting points the user can rewrite", () => {
    press(render(), "Social media");
    expect(draft.goal).toBe("Keep my social accounts posting without me writing every post");
    // The chip fills the field rather than committing an answer, so the next
    // render still shows the question with the text in it.
    expect(heading(render())).toBe("What do you want help with?");
    expect(field(render())?.props.value).toBe(draft.goal);
  });

  it("answers with a plan instead of another question", () => {
    answer("Write and schedule my LinkedIn posts");

    const tree = render();
    expect(heading(tree)).toBe("I'll start by…");
    expect(planSteps(tree)[0]).toBe("Draft a first batch of posts for LinkedIn, in your voice");
    expect(planSteps(tree)).toHaveLength(3);
    // The point of the step: no destination, cadence, or approval question.
    expect(textOf(tree.props.children)).not.toContain("?");
  });

  it("says what it will ask for later rather than asking for it now", () => {
    answer("Chase the invoices sitting in my inbox");
    expect(textOf(byTestId(render(), "onboarding-goal-plan")?.props.children)).toContain(
      "I'll ask for access when something is ready to send.",
    );
  });

  it("shapes the plan around the answer it was given", () => {
    answer("Plan my week and keep me honest about it");
    expect(planSteps(render())[0]).toBe("Lay out what is actually on your plate for your week");
  });

  it("holds the answer on screen while it works the plan out", () => {
    type(render(), "Write my LinkedIn posts");
    press(render(), "Continue");

    const thinking = render();
    const block = byTestId(thinking, "onboarding-goal-thinking");
    expect(block).not.toBeNull();
    // Nothing blanks out: the answer stays put under an honest status line.
    expect(textOf(block?.props.children)).toContain("Write my LinkedIn posts");
    expect(statusText(thinking)).toBe("Reading what you wrote");
    // Continue is inert mid-beat, so a second press cannot double-advance.
    expect(button(thinking, "Continue").props.disabled).toBe(true);

    vi.advanceTimersByTime(500);
    expect(statusText(render())).toBe("Working out where to start");

    vi.advanceTimersByTime(2_000);
    expect(byTestId(render(), "onboarding-goal-thinking")).toBeNull();
    expect(byTestId(render(), "onboarding-goal-plan")).not.toBeNull();
  });

  it("skips the beat entirely under reduced motion", () => {
    state.reducedMotion = true;
    type(render(), "Write my LinkedIn posts");
    press(render(), "Continue");
    expect(byTestId(render(), "onboarding-goal-thinking")).toBeNull();
    expect(heading(render())).toBe("I'll start by…");
  });

  it("saves the answer, and only the answer", () => {
    answer("Write my LinkedIn posts");
    press(render(), "Looks right");

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(draft.goal).toBe("Write my LinkedIn posts");
  });

  it("will not move on until the question is answered", () => {
    expect(button(render(), "Continue").props.disabled).toBe(true);
    type(render(), "   ");
    expect(button(render(), "Continue").props.disabled).toBe(true);
  });

  it("lets the user correct the answer from the plan", () => {
    answer("Write my LinkedIn posts");
    press(render(), "Edit");
    expect(heading(render())).toBe("What do you want help with?");
    expect(field(render())?.props.value).toBe("Write my LinkedIn posts");

    type(render(), "Chase the invoices in my inbox");
    press(render(), "Continue");
    vi.advanceTimersByTime(2_000);

    // Named back in the order they were written, not the order of the table.
    expect(planSteps(render())[0]).toBe("Go through what is sitting in your invoices and inbox");
    expect(draft.goal).toBe("Chase the invoices in my inbox");
  });

  it("walks back through the plan before leaving the step", () => {
    answer("Write my LinkedIn posts");
    press(render(), "Back");
    expect(onBack).not.toHaveBeenCalled();
    expect(heading(render())).toBe("What do you want help with?");

    press(render(), "Back");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("returns to the plan the user already agreed to", () => {
    // What a reload, or a step back from the next screen, hands this step.
    draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "goal",
      goal: "Write my LinkedIn posts",
      goalPhase: "plan",
    };
    expect(heading(render())).toBe("I'll start by…");
  });

  it("keeps labeled instructions typed in a new goal", () => {
    draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "goal",
      goal: "Write my LinkedIn posts\nChannels: LinkedIn and X\nCadence: Three a week",
    };
    expect(field(render())?.props.value).toBe(draft.goal);
    expect(heading(render())).toBe("What do you want help with?");
  });
});
