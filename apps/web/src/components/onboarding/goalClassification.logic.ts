import { GENERAL_TOPIC, GOAL_TOPICS, type GoalSignal, type GoalTopicId } from "./goalPlanData";
import { englishOnboardingTranslate, type OnboardingTranslate } from "./onboardingTranslate";

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word match so "post" does not fire on "postpone". Hyphens and
 * apostrophes count as part of a word, which keeps "to-do" intact.
 */
function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![\\w-])${escapeForRegExp(word)}(?![\\w-])`, "u");
}

function countKeywords(answer: string, keywords: readonly string[]): number {
  let matches = 0;

  for (const keyword of keywords) {
    if (wordPattern(keyword).test(answer)) matches += 1;
  }

  return matches;
}

/**
 * Which plan the answer earns. Scored by how many of a topic's words the
 * answer uses, so a sentence that leans one way gets that topic even when it
 * brushes another. Ties go to the earlier topic, and an answer that matches
 * nothing gets the general plan rather than a wrong guess.
 */
export function classifyDesktopOnboardingGoal(answer: string): GoalTopicId {
  const normalized = answer.toLowerCase();
  let best: GoalTopicId = "general";
  let bestScore = 0;

  for (const topic of GOAL_TOPICS) {
    const score = countKeywords(normalized, topic.keywords);

    if (score > bestScore) {
      best = topic.id;
      bestScore = score;
    }
  }

  return best;
}

/** How many of the things the answer named are said back to it. */
const MAX_MENTIONS = 2;

/**
 * The concrete things the answer named, in the order it named them. Reading
 * order is what makes the echo feel like listening rather than like matching:
 * someone who wrote "LinkedIn and X" is told "LinkedIn and X", not "X and
 * LinkedIn" because of how the table happens to be sorted.
 */
function mentionsIn(
  answer: string,
  signals: readonly GoalSignal[],
  t: OnboardingTranslate,
): readonly string[] {
  const found: Array<{ readonly label: string; readonly at: number }> = [];

  for (const signal of signals) {
    const at = answer.search(wordPattern(signal.match));
    const label = signal.label(t);

    if (at === -1 || found.some((entry) => entry.label === label)) continue;
    found.push({ label, at });
  }

  return found
    .sort((left, right) => left.at - right.at)
    .slice(0, MAX_MENTIONS)
    .map((entry) => entry.label);
}

function joinMentions(mentions: readonly string[], t: OnboardingTranslate): string | null {
  const [first, second] = mentions;

  if (first === undefined) return null;

  if (second === undefined) return first;

  return t("{first} and {second}", { first, second });
}

export interface GoalPlan {
  readonly topic: GoalTopicId;
  /** What the bot says it will do, in the order it will do it. */
  readonly steps: readonly [string, string, string];
  /** Things the answer named, said back to it. Empty when it named none. */
  readonly mentions: readonly string[];
  /** The detail this work needs later, and when it will be asked for. */
  readonly deferred: string;
}

/**
 * The plan behind one answer. Deterministic and local: the topic decides the
 * shape, and anything concrete the answer named leads the first step, so the
 * plan reads as a response to what was written rather than as a template that
 * happened to be picked.
 *
 * `t` translates the plan for display. The bot brief keeps the English default,
 * because the plan it writes out is the user's first message, not interface copy.
 */
export function desktopOnboardingGoalPlan(
  goal: string,
  t: OnboardingTranslate = englishOnboardingTranslate,
): GoalPlan {
  const answer = condense(goal).toLowerCase();
  const id = classifyDesktopOnboardingGoal(answer);
  const topic = GOAL_TOPICS.find((candidate) => candidate.id === id) ?? GENERAL_TOPIC;
  const mentions = mentionsIn(answer, topic.signals, t);
  const focus = joinMentions(mentions, t);
  const lead = focus === null ? null : topic.lead.focused?.(t, focus);

  return {
    topic: id,
    steps: [lead ?? topic.lead.plain(t), ...topic.rest(t)],
    mentions,
    deferred: topic.deferred(t),
  };
}

/** One line per answer: the goal is quoted back to the user and to the bot. */
export function condense(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}
