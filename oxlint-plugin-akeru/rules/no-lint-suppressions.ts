import { defineRule } from "@oxlint/plugins";

// Lint and type-check suppressions hide problems instead of fixing them. Fix the code, or
// change the rule's configuration (vite.config.ts for lint, tsconfig.base.json overrides for
// Effect diagnostics) with a reason in docs/internals/lint.md.
const SUPPRESSION_PATTERN =
  /^\s*(?:(?:eslint|oxlint)-(?:disable|enable)\b|@ts-(?:ignore|nocheck|expect-error)\b|@effect-diagnostics\b)/u;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow lint-disable comments and TypeScript and Effect diagnostic suppression directives.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.replace(/^\*+/u, "");

          if (!SUPPRESSION_PATTERN.test(text)) continue;

          context.report({
            loc: comment.loc,
            message:
              "Do not suppress lint or type errors. Fix the code, or change the rule's configuration in vite.config.ts or tsconfig.base.json.",
          });
        }
      },
    };
  },
});
