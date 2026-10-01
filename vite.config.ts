import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

// Anti-slop rules from the vendored oxlint-plugin-anti-slop. Every enabled rule is an error.
// See docs/internals/lint.md.
const ANTI_SLOP_RULES = {
  "oxc/no-accumulating-spread": "error",
  "anti-slop/no-array-filter-map": "error",
  "anti-slop/no-reduce-accumulator-copy": "error",
  "anti-slop/no-chained-type-assertions": "error",
  // Off: exactOptionalPropertyTypes makes a conditional spread the standard way to omit a key.
  "anti-slop/no-conditional-empty-object-spread": "off",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "error",
  // Off: `FooShape` is this repo's name for an Effect service interface.
  "anti-slop/no-shape-in-symbol-names": "off",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-readable-spacing": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
  "anti-slop-effect/no-manual-effect-error-tag": "error",
  "anti-slop-effect/no-manual-tag-comparison": "error",
  "anti-slop-effect/no-manual-tagged-construction": "error",
  "anti-slop-effect/no-service-constructor-imports": "error",
  "anti-slop-effect/prefer-effect-match": "error",
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
      correctness: "error",
      suspicious: "error",
      perf: "error",
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
      "akeru/no-inline-schema-compile": "error",
      "akeru/no-lint-suppressions": "error",
      "akeru/no-manual-effect-runtime-in-tests": "error",
      "akeru/no-native-title-tooltip": "error",
      "akeru/namespace-node-imports": "error",
      "typescript/no-explicit-any": "error",
      "eslint/max-lines": ["error", { max: 800, skipBlankLines: true, skipComments: true }],
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
        // Tests build partial fixtures and tagged values by hand on purpose; a SAFETY comment on
        // every fixture cast or a constructor for every literal error adds noise, not safety.
        files: ["**/*.test.{ts,tsx}", "**/test/**", "**/testUtils/**", "**/test-support/**"],
        rules: {
          "anti-slop/require-safety-comment-for-type-assertion": "off",
          "anti-slop-effect/no-manual-tagged-construction": "off",
          // The rule already exempts *.test.ts; shared test harnesses build doubles the same way.
          "anti-slop-effect/no-service-constructor-imports": "off",
          // Proxy-based SDK doubles forward getters with their receiver, which needs Reflect.get.
          "anti-slop/no-reflect-get": "off",
        },
      },
      {
        // Composition roots for per-instance provider runtimes. Each configured provider
        // instance (or Grok text-generation request) gets its own scoped adapter, logger, and
        // session runtime, so these files call the make* constructors directly instead of
        // yielding a singleton service.
        files: [
          "apps/server/src/provider/Drivers/**",
          "apps/server/src/provider/Layers/*Adapter.ts",
          "apps/server/src/provider/Layers/AgentController.ts",
          "apps/server/src/provider/Layers/GrokProvider.ts",
          "apps/server/src/provider/Layers/agentController/Harness.ts",
          "apps/server/src/provider/Layers/agentController/Workers.ts",
          "apps/server/src/provider/Layers/grok/GrokSessionLifecycle.ts",
          "apps/server/src/provider/acp/GrokAcpSupport.ts",
          "apps/server/src/provider/providerMaintenanceRunner.ts",
          "apps/server/src/textGeneration/GrokTextGeneration.ts",
        ],
        rules: {
          "anti-slop-effect/no-service-constructor-imports": "off",
        },
      },
      {
        // Standalone scripts and the plugin catalog run without the Effect runtime or any
        // application dependency, so they read the host and check primitives directly.
        files: [
          "apps/desktop/scripts/**",
          "packages/effect-codex-app-server/test/fixtures/**",
          "plugins/**",
          "scripts/**/*.{mjs,cjs}",
        ],
        rules: {
          "akeru/no-global-process-runtime": "off",
          "anti-slop/no-runtime-typeof": "off",
        },
      },
      {
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "shadcn/no-restyle": ["error", NO_RESTYLE],
          "shadcn/no-raw-colors": "error",
          "shadcn/no-arbitrary-values": "error",
          "shadcn/no-inline-styles": "error",
          "shadcn/no-unknown-classes": "error",
          "shadcn/require-static-classes": "error",
          "akeru/no-raw-palette-strings": "error",
        },
      },
      {
        // Tests pass hardcoded palette classes to class helpers (cn merging, theme inspection)
        // to prove those helpers handle them. The strings are inputs, never rendered UI.
        files: ["apps/web/src/**/*.test.{ts,tsx}"],
        rules: {
          "akeru/no-raw-palette-strings": "off",
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
