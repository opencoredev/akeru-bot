import { Option, Schema } from "effect";

// Bots emit these as JSON inside fenced blocks such as ```akeru-chart. The
// model only fills data slots; every color, size, and font comes from the theme.

const Tone = Schema.Literals(["neutral", "good", "warn", "bad"]);

export type GenerativeTone = typeof Tone.Type;

const ChartSeries = Schema.Struct({
  name: Schema.String,
  values: Schema.Array(Schema.Finite),
});

export const ChartSpec = Schema.Struct({
  type: Schema.Literals(["line", "area", "bar"]),
  title: Schema.optionalKey(Schema.String),
  subtitle: Schema.optionalKey(Schema.String),
  unit: Schema.optionalKey(Schema.String),
  x: Schema.Array(Schema.String),
  series: Schema.Array(ChartSeries),
});

export type ChartSpec = typeof ChartSpec.Type;

const StatTile = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  delta: Schema.optionalKey(Schema.String),
  tone: Schema.optionalKey(Tone),
  trend: Schema.optionalKey(Schema.Array(Schema.Finite)),
});

export const StatsSpec = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  stats: Schema.Array(StatTile),
});

export type StatsSpec = typeof StatsSpec.Type;

const TaskItem = Schema.Struct({
  label: Schema.String,
  state: Schema.Literals(["done", "running", "todo", "blocked"]),
  note: Schema.optionalKey(Schema.String),
});

export const TasksSpec = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(TaskItem),
});

export type TasksSpec = typeof TasksSpec.Type;

const FlowNode = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  tone: Schema.optionalKey(Tone),
});

const FlowEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  label: Schema.optionalKey(Schema.String),
  highlight: Schema.optionalKey(Schema.Boolean),
});

export const FlowSpec = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  nodes: Schema.Array(FlowNode),
  edges: Schema.Array(FlowEdge),
});

export type FlowSpec = typeof FlowSpec.Type;

const ChoiceOption = Schema.Struct({
  label: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  reply: Schema.String,
  recommended: Schema.optionalKey(Schema.Boolean),
});

export const ChoicesSpec = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(ChoiceOption),
});

export type ChoicesSpec = typeof ChoicesSpec.Type;

const TimelineEvent = Schema.Struct({
  time: Schema.String,
  label: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  tone: Schema.optionalKey(Tone),
});

export const TimelineSpec = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  events: Schema.Array(TimelineEvent),
});

export type TimelineSpec = typeof TimelineSpec.Type;

export type GenerativeBlockSpec =
  | { readonly kind: "chart"; readonly spec: ChartSpec }
  | { readonly kind: "stats"; readonly spec: StatsSpec }
  | { readonly kind: "tasks"; readonly spec: TasksSpec }
  | { readonly kind: "flow"; readonly spec: FlowSpec }
  | { readonly kind: "choices"; readonly spec: ChoicesSpec }
  | { readonly kind: "timeline"; readonly spec: TimelineSpec };

const decoders = {
  chart: Schema.decodeUnknownOption(Schema.fromJsonString(ChartSpec)),
  stats: Schema.decodeUnknownOption(Schema.fromJsonString(StatsSpec)),
  tasks: Schema.decodeUnknownOption(Schema.fromJsonString(TasksSpec)),
  flow: Schema.decodeUnknownOption(Schema.fromJsonString(FlowSpec)),
  choices: Schema.decodeUnknownOption(Schema.fromJsonString(ChoicesSpec)),
  timeline: Schema.decodeUnknownOption(Schema.fromJsonString(TimelineSpec)),
} as const;

type GenerativeKind = keyof typeof decoders;

const GENERATIVE_KINDS: ReadonlyArray<GenerativeKind> = [
  "chart",
  "stats",
  "tasks",
  "flow",
  "choices",
  "timeline",
];

const FENCE_PREFIX = "akeru-";

export function generativeKindForLanguage(language: string): GenerativeKind | null {
  const normalized = language.toLowerCase();

  if (!normalized.startsWith(FENCE_PREFIX)) return null;
  const suffix = normalized.slice(FENCE_PREFIX.length);

  return GENERATIVE_KINDS.find((kind) => kind === suffix) ?? null;
}

export function decodeGenerativeBlock(
  kind: GenerativeKind,
  code: string,
): GenerativeBlockSpec | null {
  // Each branch keeps the kind and spec paired for the discriminated union.
  switch (kind) {
    case "chart":
      return Option.match(decoders.chart(code), {
        onNone: () => null,
        onSome: (spec) => ({ kind, spec }),
      });
    case "stats":
      return Option.match(decoders.stats(code), {
        onNone: () => null,
        onSome: (spec) => ({ kind, spec }),
      });
    case "tasks":
      return Option.match(decoders.tasks(code), {
        onNone: () => null,
        onSome: (spec) => ({ kind, spec }),
      });
    case "flow":
      return Option.match(decoders.flow(code), {
        onNone: () => null,
        onSome: (spec) => ({ kind, spec }),
      });
    case "choices":
      return Option.match(decoders.choices(code), {
        onNone: () => null,
        onSome: (spec) => ({ kind, spec }),
      });
    case "timeline":
      return Option.match(decoders.timeline(code), {
        onNone: () => null,
        onSome: (spec) => ({ kind, spec }),
      });
  }
}

const KIND_LABELS: Record<GenerativeKind, string> = {
  chart: "Chart",
  stats: "Stats",
  tasks: "Tasks",
  flow: "Diagram",
  choices: "Options",
  timeline: "Timeline",
};

/** One-line stand-in for a block in plain-text previews, such as the roster sidebar. */
export function generativeBlockSummary(kind: GenerativeKind, code: string): string {
  const block = decodeGenerativeBlock(kind, code);
  const heading = block?.kind === "choices" ? block.spec.question : block?.spec.title;

  return heading ? `${KIND_LABELS[kind]}: ${heading}` : KIND_LABELS[kind];
}
