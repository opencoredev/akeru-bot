import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

// Anti-slop rules from the vendored oxlint-plugin-anti-slop. Rules with existing findings
// start at "warn" and move to "error" once their count reaches zero. See docs/internals/lint.md.
const ANTI_SLOP_RULES = {
  "oxc/no-accumulating-spread": "error",
  "anti-slop/no-array-filter-map": "warn",
  "anti-slop/no-reduce-accumulator-copy": "error",
  "anti-slop/no-chained-type-assertions": "warn",
  // Off: exactOptionalPropertyTypes makes a conditional spread the standard way to omit a key.
  "anti-slop/no-conditional-empty-object-spread": "off",
  "anti-slop/no-known-value-widening": "warn",
  "anti-slop/no-module-mocking": "warn",
  "anti-slop/no-object-parameters": "warn",
  "anti-slop/no-reflect-apply": "warn",
  "anti-slop/no-reflect-get": "warn",
  "anti-slop/no-runtime-typeof": "warn",
  // Off: `FooShape` is this repo's name for an Effect service interface.
  "anti-slop/no-shape-in-symbol-names": "off",
  "anti-slop/no-unknown-parameters": "warn",
  "anti-slop/no-unknown-returns": "warn",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "warn",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-readable-spacing": "warn",
  "anti-slop/require-safety-comment-for-type-assertion": "warn",
  "anti-slop-effect/no-manual-effect-error-tag": "warn",
  "anti-slop-effect/no-manual-tag-comparison": "warn",
  "anti-slop-effect/no-manual-tagged-construction": "warn",
  "anti-slop-effect/no-service-constructor-imports": "warn",
  "anti-slop-effect/prefer-effect-match": "warn",
} as const;

// @shadcn/lint no-restyle policy for apps/web. Call sites may place a primitive (layout:
// margin, width, flex, position) but must pick a variant or size for everything else.
// Contracts open extra categories only where the page legitimately owns them.
const NO_RESTYLE = {
  allow: ["layout"],
  contracts: [
    {
      // Containers: the page owns their padding and gaps.
      pattern:
        "^(Card|Empty|Field|Fieldset|ScrollArea|InputGroup)$|(Header|Content|Footer|Panel|Group|Body)$",
      allow: ["layout", "spacing"],
    },
    {
      // Text parts may change size and alignment, but not family or weight.
      pattern: "(Title|Description|Label|Legend|Caption)$",
      allow: ["layout", "typography"],
      deny: ["font-*"],
    },
    {
      // Table cells carry per-column spacing and typography.
      pattern: "^Table(Head|Cell|Row)$",
      allow: ["layout", "spacing", "typography"],
    },
    {
      // Skeletons take the shape of whatever they stand in for.
      pattern: "^Skeleton$",
      allow: ["layout", "shape"],
    },
  ],
};

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
      // Upstream RuleTester suites run under node --test from that package.
      "oxlint-plugin-anti-slop/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    // Formatter only for now — no lint or typecheck on commit.
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
      "oxlint-plugin-anti-slop/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      "oxlint-plugin-anti-slop/**",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: [
      "./oxlint-plugin-akeru/index.ts",
      { name: "anti-slop", specifier: "./oxlint-plugin-anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./oxlint-plugin-anti-slop/effect/index.ts" },
      "@shadcn/lint",
    ],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@akeru/client-runtime",
              message:
                "Import from an explicit @akeru/client-runtime/* subpath. The package has no root export.",
            },
            {
              name: "@pierre/diffs/react",
              importNames: ["CodeView"],
              message:
                "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
            },
          ],
        },
      ],
      "akeru/no-global-process-runtime": "error",
      "akeru/no-inline-schema-compile": "warn",
      "akeru/no-manual-effect-runtime-in-tests": "error",
      "akeru/no-native-title-tooltip": "error",
      "akeru/namespace-node-imports": "error",
      "eslint/max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
      ...ANTI_SLOP_RULES,
    },
    overrides: [
      {
        // Generated and vendored code is fixed at its source, not at the call site.
        files: ["**/_generated/**", "**/*.gen.ts", "**/vendor/**"],
        rules: {
          "eslint/max-lines": "off",
          ...Object.fromEntries(Object.keys(ANTI_SLOP_RULES).map((rule) => [rule, "off"])),
        },
      },
      {
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "shadcn/no-restyle": ["warn", NO_RESTYLE],
          "shadcn/no-raw-colors": "warn",
          "shadcn/no-arbitrary-values": "warn",
          "shadcn/no-inline-styles": "warn",
          "shadcn/no-unknown-classes": "warn",
          "shadcn/require-static-classes": "warn",
        },
      },
      {
        // Primitives own their styling, so the call-site rules stop at this directory.
        files: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/no-restyle": "off",
          "shadcn/no-arbitrary-values": "off",
          "shadcn/require-static-classes": "off",
        },
      },
    ],
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
