import type { OnboardingTranslate } from "./onboardingTranslate";

export type GoalTopicId = "social" | "research" | "admin" | "planning" | "building" | "general";

/**
 * A concrete noun the answer used, and how to say it back. Matched whole-word,
 * so "post" does not fire on "postpone" and "api" does not fire on "rapid".
 */
export interface GoalSignal {
  readonly match: string;
  readonly label: (t: OnboardingTranslate) => string;
}

export interface GoalTopic {
  readonly id: GoalTopicId;
  /** Scored whole-word against the answer. Lowercase. */
  readonly keywords: readonly string[];
  readonly signals: readonly GoalSignal[];
  /**
   * The opening move, with and without something specific to name. The focused
   * form takes the names last, because two of them join with "and" and a slot
   * mid-sentence would leave the line reading "x and y and …". Topics with
   * nothing worth naming have the plain form only.
   */
  readonly lead: {
    readonly focused?: (t: OnboardingTranslate, focus: string) => string;
    readonly plain: (t: OnboardingTranslate) => string;
  };
  /** What follows the opening move. Short, and in the order they happen. */
  readonly rest: (t: OnboardingTranslate) => readonly [string, string];
  /**
   * The detail this kind of work eventually needs, and the moment it needs it.
   * Named out loud so deferring it reads as a decision rather than an omission.
   */
  readonly deferred: (t: OnboardingTranslate) => string;
}

/**
 * Order matters twice: topics are scored in this order, so a tie lands on the
 * earlier one rather than on whichever the engine happened to visit last.
 */
export const GOAL_TOPICS: readonly GoalTopic[] = [
  {
    id: "social",
    keywords: [
      "social",
      "social media",
      "post",
      "posts",
      "posting",
      "tweet",
      "tweets",
      "threads",
      "instagram",
      "linkedin",
      "tiktok",
      "youtube",
      "facebook",
      "reels",
      "caption",
      "captions",
      "audience",
      "followers",
      "engagement",
      "newsletter",
      "marketing",
    ],
    signals: [
      { match: "linkedin", label: () => "LinkedIn" },
      { match: "instagram", label: () => "Instagram" },
      { match: "tiktok", label: () => "TikTok" },
      { match: "youtube", label: () => "YouTube" },
      { match: "threads", label: () => "Threads" },
      { match: "facebook", label: () => "Facebook" },
      { match: "tweet", label: () => "X" },
      { match: "tweets", label: () => "X" },
      { match: "newsletter", label: (t) => t("your newsletter") },
    ],
    lead: {
      focused: (t, focus) =>
        t("Draft a first batch of posts for {focus}, in your voice", { focus }),
      plain: (t) => t("Draft a first batch of posts in your voice"),
    },
    rest: (t) => [
      t("Show them to you before anything goes out"),
      t("Write more like the ones you keep"),
    ],
    deferred: (t) => t("I'll ask which accounts to post from once there's a draft worth posting."),
  },
  {
    id: "research",
    keywords: [
      "research",
      "researching",
      "find out",
      "look up",
      "sources",
      "paper",
      "papers",
      "study",
      "studies",
      "compare",
      "comparison",
      "competitor",
      "competitors",
      "market",
      "news",
      "articles",
      "summarize",
      "summarise",
      "benchmark",
      "benchmarks",
      "investigate",
      "analysis",
    ],
    signals: [
      { match: "competitor", label: (t) => t("your competitors") },
      { match: "competitors", label: (t) => t("your competitors") },
      { match: "pricing", label: (t) => t("pricing") },
      { match: "market", label: (t) => t("the market") },
      { match: "news", label: (t) => t("the news") },
      { match: "papers", label: (t) => t("research") },
      { match: "benchmarks", label: (t) => t("the benchmarks") },
    ],
    lead: {
      focused: (t, focus) => t("Gather what is already out there on {focus}", { focus }),
      plain: (t) => t("Gather what is already out there on this"),
    },
    rest: (t) => [
      t("Put it on one page you can skim"),
      t("Flag what changed instead of making you re-read it"),
    ],
    deferred: (t) => t("I'll ask where that page should live once there's something on it."),
  },
  {
    id: "admin",
    keywords: [
      "admin",
      "inbox",
      "email",
      "emails",
      "invoice",
      "invoices",
      "receipt",
      "receipts",
      "expense",
      "expenses",
      "bookkeeping",
      "paperwork",
      "filing",
      "forms",
      "billing",
      "spreadsheet",
      "crm",
      "tickets",
      "support",
    ],
    signals: [
      { match: "inbox", label: (t) => t("inbox") },
      { match: "invoices", label: (t) => t("invoices") },
      { match: "invoice", label: (t) => t("invoices") },
      { match: "receipts", label: (t) => t("receipts") },
      { match: "expenses", label: (t) => t("expenses") },
      { match: "tickets", label: (t) => t("tickets") },
      { match: "paperwork", label: (t) => t("paperwork") },
    ],
    lead: {
      focused: (t, focus) => t("Go through what is sitting in your {focus}", { focus }),
      plain: (t) => t("Go through what has piled up"),
    },
    rest: (t) => [
      t("Separate what actually needs you from what does not"),
      t("Draft the replies and the filing for you to check"),
    ],
    deferred: (t) => t("I'll ask for access when something is ready to send."),
  },
  {
    id: "planning",
    keywords: [
      "plan",
      "plans",
      "planning",
      "schedule",
      "calendar",
      "week",
      "weekly",
      "routine",
      "routines",
      "habit",
      "habits",
      "todo",
      "to-do",
      "tasks",
      "trip",
      "travel",
      "itinerary",
      "meals",
      "workout",
      "workouts",
      "budget",
      "goals",
      "reminders",
      "agenda",
    ],
    signals: [
      { match: "week", label: (t) => t("your week") },
      { match: "trip", label: (t) => t("your trip") },
      { match: "travel", label: (t) => t("your trip") },
      { match: "routine", label: (t) => t("your routine") },
      { match: "budget", label: (t) => t("your budget") },
      { match: "meals", label: (t) => t("your meals") },
      { match: "workouts", label: (t) => t("your training") },
    ],
    lead: {
      focused: (t, focus) => t("Lay out what is actually on your plate for {focus}", { focus }),
      plain: (t) => t("Lay out what is actually on your plate"),
    },
    rest: (t) => [t("Turn it into an order you can follow"), t("Say something when a piece slips")],
    deferred: (t) => t("I'll ask about your calendar when putting it there would help."),
  },
  {
    id: "building",
    keywords: [
      "code",
      "coding",
      "app",
      "apps",
      "bug",
      "bugs",
      "feature",
      "features",
      "repo",
      "repository",
      "refactor",
      "test",
      "tests",
      "build",
      "website",
      "site",
      "api",
      "database",
      "deploy",
      "frontend",
      "backend",
      "ship",
    ],
    signals: [
      { match: "repo", label: (t) => t("your repo") },
      { match: "repository", label: (t) => t("your repo") },
      { match: "app", label: (t) => t("your app") },
      { match: "site", label: (t) => t("your site") },
      { match: "website", label: (t) => t("your site") },
      { match: "api", label: (t) => t("your API") },
      { match: "database", label: (t) => t("your database") },
      { match: "tests", label: (t) => t("your tests") },
    ],
    lead: {
      focused: (t, focus) => t("Read through {focus} to find where this belongs", { focus }),
      plain: (t) => t("Read through the project to find where this belongs"),
    },
    rest: (t) => [
      t("Make the smallest change that proves it works"),
      t("Show you the diff before anything else"),
    ],
    deferred: (t) => t("I'll ask about your setup when I need to run something."),
  },
];

/**
 * Used when nothing in the answer matches a topic. True of any goal, and with
 * nothing specific to name it has no focused form.
 */
export const GENERAL_TOPIC: Omit<GoalTopic, "id" | "keywords"> = {
  signals: [],
  lead: { plain: (t) => t("Work out what a good result looks like here") },
  rest: (t) => [
    t("Take the first real step and show you what came of it"),
    t("Adjust from what you say about it"),
  ],
  deferred: (t) => t("I'll ask for whatever I need, at the point I need it."),
};

export interface GoalExample {
  readonly topic: GoalTopicId;
  /** What the chip writes into the answer. Editable afterwards. */
  readonly goal: string;
}

/**
 * Starting points for the question. Not categories: picking one fills the
 * answer in the user's field, which they are free to rewrite.
 */
export const DESKTOP_ONBOARDING_GOAL_EXAMPLES: readonly GoalExample[] = [
  {
    topic: "social",
    goal: "Keep my social accounts posting without me writing every post",
  },
  {
    topic: "research",
    goal: "Research a topic for me and keep one page of findings current",
  },
  {
    topic: "admin",
    goal: "Take the admin off my desk: inbox, invoices, and filing",
  },
  {
    topic: "planning",
    goal: "Plan my week and keep me on top of what I said I would do",
  },
];

export interface GoalThinkingBeat {
  readonly status: string;
  /** Milliseconds after the answer was given. */
  readonly atMs: number;
}

/**
 * The beat between the answer and the plan. It is short and it is honest: the
 * app really is reading the answer and choosing what to start on, and it says
 * exactly that rather than claiming to think.
 */
export const DESKTOP_ONBOARDING_GOAL_THINKING_BEATS: readonly GoalThinkingBeat[] = [
  { status: "Reading what you wrote", atMs: 0 },
  { status: "Working out where to start", atMs: 460 },
];

/**
 * How long the beat holds. Long enough to read as a considered pause rather
 * than a flicker, short enough that nobody waits on it. Reduced motion skips
 * it: the plan is already decided, so there is nothing to wait for.
 */
export const DESKTOP_ONBOARDING_GOAL_THINKING_MS = 980;
