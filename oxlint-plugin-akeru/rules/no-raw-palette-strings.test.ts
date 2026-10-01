import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("akeru/no-raw-palette-strings", {
  filename: "fixture.tsx",
});

describe("akeru/no-raw-palette-strings", () => {
  rule.valid(
    "allows semantic tokens",
    `const el = <span className="bg-warning text-muted-foreground ring-1 ring-border" />;`,
  );

  rule.valid(
    "allows semantic tokens with variants and opacity",
    `const dot = { warning: "bg-warning/80 dark:hover:bg-tint/5 ring-shade/40" };`,
  );

  rule.valid(
    "allows prose that mentions colors",
    `const copy = "Pick a white or black background, or try amber-400 for the dot.";`,
  );

  rule.valid(
    "allows URLs and identifiers containing color words",
    `const url = "https://example.com/bg-white/text-red-500"; const key = "text_white"; const id = "blackWhiteTheme";`,
  );

  rule.valid(
    "allows color utilities spelled without a palette step",
    `const cls = "text-sm border-2 shadow-xs/18 ring-offset-1 from-primary to-transparent";`,
  );

  rule.invalid(
    "reports a palette color in a string constant",
    `export const PROVIDER_STATUS_STYLES = { disabled: { dot: "bg-amber-400" } } as const;`,
    (output) => {
      assert.match(output, /`bg-amber-400` is a raw palette color/);
    },
  );

  rule.invalid(
    "reports palette colors in an object map",
    `const tones = { error: "text-red-600", info: "border-sky-500" };`,
    (output) => {
      assert.match(output, /`text-red-600`/);
      assert.match(output, /`border-sky-500`/);
    },
  );

  rule.invalid(
    "reports palette colors in a template literal",
    'const cls = (active: boolean) => `flex ${active ? "" : ""} text-white rounded-full`;',
    (output) => {
      assert.match(output, /`text-white`/);
    },
  );

  rule.invalid(
    "reports palette colors with opacity suffixes",
    `const cls = "bg-fuchsia-500/14 dark:bg-white/[0.16] bg-zinc-950/(--alpha)";`,
    (output) => {
      assert.match(output, /`bg-fuchsia-500\/14`/);
      assert.match(output, /`dark:bg-white\/\[0.16\]`/);
      assert.match(output, /`bg-zinc-950\/\(--alpha\)`/);
    },
  );

  rule.invalid(
    "reports palette colors behind dark and hover variants",
    `const cls = "dark:hover:bg-white/5 hover:text-zinc-900 [&_svg]:hover:stroke-white!";`,
    (output) => {
      assert.match(output, /`dark:hover:bg-white\/5`/);
      assert.match(output, /`hover:text-zinc-900`/);
      assert.match(output, /`\[&_svg\]:hover:stroke-white!`/);
    },
  );

  rule.invalid(
    "reports custom palette steps such as zinc-25",
    `const el = <ol className="rounded-xl bg-zinc-25 p-1" />;`,
    (output) => {
      assert.match(output, /`bg-zinc-25`/);
    },
  );

  rule.invalid(
    "reports black and white with opacity",
    `const el = <div className="ring-1 ring-black/5 dark:bg-white/2" />;`,
    (output) => {
      assert.match(output, /`ring-black\/5`/);
      assert.match(output, /`dark:bg-white\/2`/);
    },
  );

  rule.invalid(
    "reports variant table entries passed to cva",
    `const variants = cva("", { variants: { variant: { destructive: "bg-destructive text-white" } } });`,
  );
});
