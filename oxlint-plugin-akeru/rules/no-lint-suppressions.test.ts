import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("akeru/no-lint-suppressions", {
  filename: "fixture.ts",
});

describe("akeru/no-lint-suppressions", () => {
  rule.valid("allows ordinary comments", `// Disable the button while saving.\nconst a = 1;`);

  rule.valid(
    "allows prose that mentions a directive",
    `// We never use oxlint-disable here.\nconst a = 1;`,
  );

  rule.invalid(
    "reports a next-line oxlint disable",
    `// oxlint-disable-next-line eslint/no-console -- reason\nconsole.log(1);`,
    (output) => {
      assert.match(output, /Do not suppress lint or type errors/);
    },
  );

  rule.invalid(
    "reports a rule-scoped block eslint disable",
    `/* eslint-disable no-console */\nconsole.log(1);`,
  );

  rule.invalid(
    "reports a JSX-style block disable",
    `/** oxlint-disable shadcn/no-inline-styles */\nconst a = 1;`,
  );

  rule.invalid("reports ts-ignore", `// @ts-ignore\nconst a: number = "x";`);

  rule.invalid(
    "reports ts-expect-error",
    `// @ts-expect-error intentional\nconst a: number = "x";`,
  );

  rule.invalid("reports ts-nocheck", `// @ts-nocheck\nconst a = 1;`);
});
