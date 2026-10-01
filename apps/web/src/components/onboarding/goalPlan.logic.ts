/**
 * Everything setup infers from one sentence. The user says what they want in
 * their own words and the app answers with a plan it can actually start on,
 * with no second and third question, no destination or cadence asked for before
 * anything exists to send.
 *
 * All of it runs locally and deterministically: the same answer always yields
 * the same plan, so the step never waits on a model, never stalls a user who
 * is offline, and never invents work the app is not doing.
 */

import { condense, desktopOnboardingGoalPlan } from "./goalClassification.logic";
import {
  DESKTOP_ONBOARDING_GOAL_THINKING_BEATS,
  DESKTOP_ONBOARDING_GOAL_THINKING_MS,
} from "./goalPlanData";

export {
  classifyDesktopOnboardingGoal,
  desktopOnboardingGoalPlan,
  type GoalPlan,
} from "./goalClassification.logic";

export {
  DESKTOP_ONBOARDING_GOAL_EXAMPLES,
  DESKTOP_ONBOARDING_GOAL_THINKING_BEATS,
  DESKTOP_ONBOARDING_GOAL_THINKING_MS,
  type GoalExample,
  type GoalThinkingBeat,
  type GoalTopicId,
} from "./goalPlanData";

/**
 * Labels written by the follow-up questions setup used to ask, before the
 * destination and the cadence were deferred to the moment the bot needs them.
 * Historical: they exist to be read off old drafts, never to be written.
 */
const LEGACY_FOLLOW_UP_LABELS: readonly string[] = [
  "Channels",
  "Cadence",
  "Watching",
  "Findings",
  "First pile",
  "Autonomy",
  "Planning",
  "Check-ins",
  "Project",
  "Done means",
  "Good result",
  "Keeping me posted",
];

/**
 * Converts a goal saved by the former follow-up flow. Call only while parsing
 * a draft identified as legacy; fresh goals may contain these same labels.
 */
export function normalizeDesktopOnboardingGoal(goal: string): string {
  const lines = goal.split("\n");
  const kept = [lines[0] ?? ""];

  for (const line of lines.slice(1)) {
    const legacy = LEGACY_FOLLOW_UP_LABELS.some((label) => line.startsWith(`${label}: `));

    if (!legacy) kept.push(line);
  }

  return kept.join("\n").trim();
}

/**
 * What the bot is created with, and what it is first asked to do. The prompt
 * is the plan the user just agreed to, written out, so the first turn starts
 * on the work rather than on another round of questions, and says plainly
 * that the details come up when they matter.
 *
 * Legacy drafts are normalized when read, so this receives exactly the goal
 * the user saw and preserves all new instructions they entered.
 */
export function desktopOnboardingBotBrief(goal: string) {
  const description = condense(goal);
  const plan = desktopOnboardingGoalPlan(description);
  const steps = plan.steps.map((step) => `- ${step}`).join("\n");

  return {
    description,
    prompt: `I want help with this:\n\n${description}\n\nStart here:\n${steps}\n\nAsk me for anything you need as it comes up.`,
  };
}

export function desktopOnboardingGoalThinkingMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : DESKTOP_ONBOARDING_GOAL_THINKING_MS;
}

/** Which line the beat is on. Holds the last one rather than blanking out. */
export function desktopOnboardingGoalThinkingStatus(elapsedMs: number): string {
  let status = DESKTOP_ONBOARDING_GOAL_THINKING_BEATS[0]?.status ?? "";

  for (const beat of DESKTOP_ONBOARDING_GOAL_THINKING_BEATS) {
    if (elapsedMs >= beat.atMs) status = beat.status;
  }

  return status;
}
