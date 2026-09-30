import { describe, expect, it } from "vite-plus/test";

import {
  classifyDesktopOnboardingGoal,
  DESKTOP_ONBOARDING_GOAL_EXAMPLES,
  DESKTOP_ONBOARDING_GOAL_THINKING_BEATS,
  DESKTOP_ONBOARDING_GOAL_THINKING_MS,
  desktopOnboardingBotBrief,
  desktopOnboardingGoalPlan,
  desktopOnboardingGoalThinkingMs,
  desktopOnboardingGoalThinkingStatus,
  normalizeDesktopOnboardingGoal,
  type GoalTopicId,
} from "./goalPlan.logic";

/** One answer per topic, phrased the way someone would actually write it. */
const ANSWERS: Readonly<Record<GoalTopicId, string>> = {
  social: "Keep my social accounts going",
  research: "Research this and keep the findings current",
  admin: "Take the paperwork off my desk",
  planning: "Plan my week for me",
  building: "Fix bugs and ship features",
  general: "Help me think through a hard conversation",
};

const TOPICS = Object.keys(ANSWERS) as readonly GoalTopicId[];

describe("goal topics", () => {
  it("reads the topic out of the answer", () => {
    expect(classifyDesktopOnboardingGoal("Write my LinkedIn posts for me")).toBe("social");
    expect(classifyDesktopOnboardingGoal("Compare competitor pricing every week")).toBe("research");
    expect(classifyDesktopOnboardingGoal("Sort my inbox and file the invoices")).toBe("admin");
    expect(classifyDesktopOnboardingGoal("Plan my week and my meals")).toBe("planning");
    expect(classifyDesktopOnboardingGoal("Fix bugs in my app and ship features")).toBe("building");
  });

  it("falls back to a plan that fits anything rather than guessing", () => {
    expect(classifyDesktopOnboardingGoal("Help me think through a hard conversation")).toBe(
      "general",
    );
    expect(classifyDesktopOnboardingGoal("")).toBe("general");
  });

  it("matches whole words only", () => {
    // "post" lives in the social list; "postpone" is not a social word.
    expect(classifyDesktopOnboardingGoal("Stop me from postponing hard things")).toBe("general");
  });

  it("wins on weight, not on the first word it sees", () => {
    // One planning word, three social ones.
    expect(classifyDesktopOnboardingGoal("Plan and write posts and captions for my audience")).toBe(
      "social",
    );
  });

  it("is deterministic across repeated reads", () => {
    const answer = "Keep my research current and plan the week around it";
    const first = classifyDesktopOnboardingGoal(answer);
    expect(classifyDesktopOnboardingGoal(answer)).toBe(first);
    expect(classifyDesktopOnboardingGoal(answer.toUpperCase())).toBe(first);
  });
});

describe("goal plan", () => {
  it("proposes three concrete moves and one detail it is leaving for later", () => {
    for (const topic of TOPICS) {
      const plan = desktopOnboardingGoalPlan(ANSWERS[topic]);
      expect(plan.topic).toBe(topic);
      expect(plan.steps).toHaveLength(3);
      for (const step of plan.steps) expect(step.trim().length).toBeGreaterThan(0);
      expect(plan.deferred).toMatch(/^I'll ask/);
    }
  });

  it("gives every topic its own plan", () => {
    const leads = new Set(
      TOPICS.map((topic) => desktopOnboardingGoalPlan(ANSWERS[topic]).steps[0]),
    );
    const deferrals = new Set(
      TOPICS.map((topic) => desktopOnboardingGoalPlan(ANSWERS[topic]).deferred),
    );
    expect(leads.size).toBe(TOPICS.length);
    expect(deferrals.size).toBe(TOPICS.length);
  });

  it("starts on what the answer actually named", () => {
    const plan = desktopOnboardingGoalPlan("Write my LinkedIn posts every week");
    expect(plan.topic).toBe("social");
    expect(plan.mentions).toEqual(["LinkedIn"]);
    expect(plan.steps[0]).toBe("Draft a first batch of posts for LinkedIn, in your voice");
  });

  it("says names back in the order they were written", () => {
    expect(desktopOnboardingGoalPlan("Post to LinkedIn and tweet the same thing").mentions).toEqual(
      ["LinkedIn", "X"],
    );
    expect(desktopOnboardingGoalPlan("Tweet it, then post to LinkedIn").mentions).toEqual([
      "X",
      "LinkedIn",
    ]);
  });

  it("stops at two names rather than reciting the whole sentence back", () => {
    const plan = desktopOnboardingGoalPlan("Post to LinkedIn, Instagram, TikTok and YouTube");
    expect(plan.mentions).toEqual(["LinkedIn", "Instagram"]);
    expect(plan.steps[0]).toBe(
      "Draft a first batch of posts for LinkedIn and Instagram, in your voice",
    );
  });

  it("names nothing it was not told, and still has somewhere to start", () => {
    const plan = desktopOnboardingGoalPlan("Keep my social accounts going");
    expect(plan.mentions).toEqual([]);
    expect(plan.steps[0]).toBe("Draft a first batch of posts in your voice");
  });

  it("never asks for a destination, a cadence, or an approval rule", () => {
    // The whole point of the step: those are the questions that were removed.
    for (const example of DESKTOP_ONBOARDING_GOAL_EXAMPLES) {
      const plan = desktopOnboardingGoalPlan(example.goal);
      const text = [...plan.steps, plan.deferred].join(" ");
      expect(text).not.toContain("?");
      expect(text.toLowerCase()).not.toContain("how often");
      expect(text.toLowerCase()).not.toContain("where does this go");
    }
  });

  it("is deterministic, so a re-render cannot change the plan under the user", () => {
    const goal = "Keep my LinkedIn posting without me writing every post";
    expect(desktopOnboardingGoalPlan(goal)).toEqual(desktopOnboardingGoalPlan(goal));
    // Casing and stray whitespace are the same answer.
    expect(desktopOnboardingGoalPlan(`  ${goal.toUpperCase()}\n`).steps).toEqual(
      desktopOnboardingGoalPlan(goal).steps,
    );
  });

  it("offers a starting point that lands on the plan it advertises", () => {
    expect(DESKTOP_ONBOARDING_GOAL_EXAMPLES.map((example) => example.topic)).toEqual([
      "social",
      "research",
      "admin",
      "planning",
    ]);
    for (const example of DESKTOP_ONBOARDING_GOAL_EXAMPLES) {
      expect(desktopOnboardingGoalPlan(example.goal).topic).toBe(example.topic);
    }
  });
});

describe("saved goals", () => {
  it("leaves an ordinary answer exactly as it was written", () => {
    expect(normalizeDesktopOnboardingGoal("Write my LinkedIn posts")).toBe(
      "Write my LinkedIn posts",
    );
    expect(normalizeDesktopOnboardingGoal("")).toBe("");
  });

  it("drops the answers to questions setup no longer asks", () => {
    expect(
      normalizeDesktopOnboardingGoal(
        "Write my posts\nChannels: LinkedIn and X\nCadence: Three a week, I sign off",
      ),
    ).toBe("Write my posts");
    expect(
      normalizeDesktopOnboardingGoal("Chase my invoices\nFirst pile: receipts\nAutonomy: ask me"),
    ).toBe("Chase my invoices");
  });

  it("keeps line breaks the user wrote themselves", () => {
    expect(normalizeDesktopOnboardingGoal("Write my posts\nand my newsletter")).toBe(
      "Write my posts\nand my newsletter",
    );
  });
});

describe("first message", () => {
  it("keeps labeled details from a new goal", () => {
    const brief = desktopOnboardingBotBrief("Build a dashboard\nProject: Client portal");
    expect(brief.description).toContain("Project: Client portal");
    expect(brief.prompt).toContain("Project: Client portal");
  });

  it("hands the bot the goal in the user's own words", () => {
    const goal = "Reconcile the card statement against our receipts every month";
    const brief = desktopOnboardingBotBrief(`  ${goal}\n`);

    expect(brief.description).toBe(goal);
    expect(brief.prompt).toContain(goal);
    expect(brief.prompt.startsWith("I want help with this:")).toBe(true);
  });

  it("writes out the same plan the user just agreed to", () => {
    const goal = "Write my LinkedIn posts every week";
    const brief = desktopOnboardingBotBrief(goal);
    for (const step of desktopOnboardingGoalPlan(goal).steps) {
      expect(brief.prompt).toContain(`- ${step}`);
    }
  });

  it("tells the bot to ask as it goes rather than interviewing the user first", () => {
    const brief = desktopOnboardingBotBrief("Plan my week");
    expect(brief.prompt).toContain("as it comes up");
    expect(brief.prompt).not.toContain("single most useful question");
  });
});

describe("goal thinking beat", () => {
  it("says what it is doing, and never claims to be thinking", () => {
    const statuses = DESKTOP_ONBOARDING_GOAL_THINKING_BEATS.map((beat) => beat.status);
    expect(statuses).toEqual(["Reading what you wrote", "Working out where to start"]);
  });

  it("moves through its lines and holds the last one", () => {
    expect(desktopOnboardingGoalThinkingStatus(0)).toBe("Reading what you wrote");
    expect(desktopOnboardingGoalThinkingStatus(459)).toBe("Reading what you wrote");
    expect(desktopOnboardingGoalThinkingStatus(460)).toBe("Working out where to start");
    expect(desktopOnboardingGoalThinkingStatus(DESKTOP_ONBOARDING_GOAL_THINKING_MS)).toBe(
      "Working out where to start",
    );
  });

  it("stays short enough that nobody waits on it", () => {
    expect(DESKTOP_ONBOARDING_GOAL_THINKING_MS).toBeLessThanOrEqual(1_200);
    for (const beat of DESKTOP_ONBOARDING_GOAL_THINKING_BEATS) {
      expect(beat.atMs).toBeLessThan(DESKTOP_ONBOARDING_GOAL_THINKING_MS);
    }
  });

  it("collapses the beat for reduced motion", () => {
    expect(desktopOnboardingGoalThinkingMs(false)).toBe(DESKTOP_ONBOARDING_GOAL_THINKING_MS);
    expect(desktopOnboardingGoalThinkingMs(true)).toBe(0);
  });
});
