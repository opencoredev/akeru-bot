import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Predicate from "effect/Predicate";

// @shadcn/lint's no-raw-colors only reads className contexts, so palette colors in string
// constants, variant tables, and template literals slipped past it. This rule reads every string
// and template chunk instead, and also treats `black`, `white`, and custom palette steps such as
// `zinc-25` as raw colors. Use a semantic token from apps/web/src/index.css.

const COLOR_UTILITIES = [
  "accent",
  "bg",
  "border(?:-[xytrblse])?",
  "caret",
  "decoration",
  "divide",
  "drop-shadow",
  "fill",
  "from",
  "inset-ring",
  "inset-shadow",
  "outline",
  "placeholder",
  "ring(?:-offset)?",
  "shadow",
  "stroke",
  "text",
  "to",
  "via",
].join("|");

const PALETTE_HUES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
].join("|");

// One class after its variants are removed: optional important and negative markers, the
// utility, a palette color, and an optional opacity modifier (`/5`, `/[0.16]`, `/(--x)`).
const RAW_PALETTE_CLASS = new RegExp(
  `^!?-?(?:${COLOR_UTILITIES})-(?:(?:${PALETTE_HUES})-\\d+|black|white)(?:\\/(?:\\d+(?:\\.\\d+)?|\\[[^\\]]+\\]|\\([^)]+\\)))?!?$`,
  "u",
);

// Cheap pre-filter so ordinary strings skip tokenizing.
const MAY_CONTAIN_PALETTE = new RegExp(`(?:${PALETTE_HUES})-\\d|black|white`, "u");

// Variants end at the last `:` outside brackets and parentheses, so `[&_svg]:hover:stroke-white`
// yields `stroke-white` while `https://example.com` keeps its scheme and never matches.
function stripVariants(token: string): string {
  let depth = 0;
  let start = 0;

  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];

    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) start = index + 1;
  }

  return token.slice(start);
}

function findRawPaletteClasses(text: string): ReadonlyArray<string> {
  if (!MAY_CONTAIN_PALETTE.test(text)) return [];

  return text
    .split(/\s+/u)
    .filter((token) => token.length > 0 && RAW_PALETTE_CLASS.test(stripVariants(token)));
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Tailwind palette colors, including black, white, and custom palette steps, in any string.",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, text: string) => {
      for (const className of findRawPaletteClasses(text)) {
        context.report({
          node,
          message: `\`${className}\` is a raw palette color. Use a semantic token from apps/web/src/index.css, or add one with the same light and dark values.`,
        });
      }
    };

    return {
      Literal(node) {
        if (!Predicate.isString(node.value)) return;

        report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
