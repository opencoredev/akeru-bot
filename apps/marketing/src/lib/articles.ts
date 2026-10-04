import { HERO_BOTS } from "./heroBots";

export type ArticleCoverKind = "grid" | "bars" | "path";

/** Blog articles, newest first. The blog index and each article header read this list. */
export interface Article {
  href: string;
  category: string;
  title: string;
  summary: string;
  readMinutes: number;
  cover: ArticleCoverKind;
  bot: (typeof HERO_BOTS)[number];
}

const bot = (name: string) => {
  const match = HERO_BOTS.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Unknown hero bot: ${name}`);
  return match;
};

export const ARTICLES: Article[] = [
  {
    href: "/open-source-grok-bot",
    category: "Open source",
    title: "An open-source alternative to Grok Bot",
    summary:
      "Named Grok bots with their own tools, instructions, and memory, in an MIT-licensed app you can run yourself.",
    readMinutes: 4,
    cover: "grid",
    bot: bot("Scout"),
  },
  {
    href: "/compare/akeru-vs-grok-bot",
    category: "Comparison",
    title: "Akeru Bot and Grok Bot compared",
    summary: "Where each one runs, who holds your data, and which providers you can bring.",
    readMinutes: 2,
    cover: "bars",
    bot: bot("Relay"),
  },
  {
    href: "/guides/self-hosted-grok-bot",
    category: "Guide",
    title: "Run a Grok bot on an environment you control",
    summary: "Install Akeru, connect your Grok subscription, and set up your first bot.",
    readMinutes: 3,
    cover: "path",
    bot: bot("Mira"),
  },
];

export const articleFor = (path: string) => ARTICLES.find((article) => article.href === path);
