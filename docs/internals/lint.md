# Lint rules

> For Akeru Bot maintainers and the agents that work on the repo.

Oxlint runs through Vite+. The whole configuration lives in the `lint` block of the root
[`vite.config.ts`](../../vite.config.ts). CI runs `vp run lint`, which fails on any finding.
Every enabled rule is an `error`; the codebase carries no warnings.

Lint the files you touched:

```bash
vp lint apps/web/src/components/chat/ChatView.tsx packages/shared/src
```

`vp lint --fix <paths>` applies autofixes. Run `vp fmt <paths>` afterwards.

## Rule groups

| Group                | Source                                                                                     | Scope          |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------- |
| Oxlint built-ins     | `plugins` and `categories` in the config                                                   | Whole repo     |
| `akeru/*`            | [`oxlint-plugin-akeru/`](../../oxlint-plugin-akeru)                                        | Whole repo     |
| `anti-slop/*`        | [`oxlint-plugin-anti-slop/index.ts`](../../oxlint-plugin-anti-slop/index.ts)               | Whole repo     |
| `anti-slop-effect/*` | [`oxlint-plugin-anti-slop/effect/index.ts`](../../oxlint-plugin-anti-slop/effect/index.ts) | Whole repo     |
| `shadcn/*`           | [`@shadcn/lint`](https://github.com/shadcn-ui/lint) from npm                               | `apps/web/src` |
| `eslint/max-lines`   | Oxlint built-in                                                                            | Whole repo     |

Generated and vendored files (`**/_generated/**`, `**/*.gen.ts`, `**/vendor/**`) skip the
anti-slop rules and `max-lines`. Fix those at the generator or upstream instead.

### anti-slop

Anti-slop rejects code that hides what it knows: values widened to `unknown`, casts with no
stated reason, ad hoc `typeof` narrowing instead of parsing at the boundary, and similar
patterns. Each diagnostic says what to do instead. The upstream
[README](https://github.com/dmmulroy/anti-slop#rules) has an example for every rule.

The Effect group pushes tagged values through Effect's own tools: `Match`, `Predicate.isTagged`,
`Effect.catchTag`, and Schema or `Data` constructors instead of hand-built `_tag` objects.

Two rules are off:

- `anti-slop/no-conditional-empty-object-spread`. The repo compiles with
  `exactOptionalPropertyTypes`, so `...(value !== undefined ? { value } : {})` is the standard way
  to omit a key. The rule's alternative is to build objects across mutable statements, which reads
  worse in Effect pipelines.
- `anti-slop/no-shape-in-symbol-names`. `FooShape` is the repo's name for the interface behind an
  Effect service (`ProviderRegistryShape`, `OrchestrationEngineShape`). Renaming them all would be
  churn with no change in meaning.

Every type assertion needs a `// SAFETY: <reason>` comment directly above it
(`require-safety-comment-for-type-assertion`).

### shadcn

`@shadcn/lint` checks Tailwind classes against the web app's design system. It reads
[`apps/web/components.json`](../../apps/web/components.json) to find the theme
(`apps/web/src/index.css`) and the primitives (`~/components/ui`), so there is no extra
`settings.shadcn` block.

| Rule                     | What it reports                                                     |
| ------------------------ | ------------------------------------------------------------------- |
| `no-restyle`             | Classes passed to a primitive that its variants or sizes should own |
| `no-raw-colors`          | Palette colors such as `bg-pink-500` instead of theme tokens        |
| `no-arbitrary-values`    | Arbitrary values such as `w-[13px]`                                 |
| `no-inline-styles`       | `style={{ ... }}` properties and `<style>` elements                 |
| `no-unknown-classes`     | Classes Tailwind cannot generate                                    |
| `require-static-classes` | Classes on a primitive that are built at runtime                    |

Inside `apps/web/src/components/ui/`, `no-restyle`, `no-arbitrary-values`, and
`require-static-classes` are off, because primitives define their own styling.

The `no-restyle` policy is the `NO_RESTYLE` constant in `vite.config.ts`. A call site may always
use layout classes on a primitive: margin, width, flex and grid placement, position, and
visibility. Everything else comes from a variant or size. Contracts open more for specific parts:

| Components                                                                                                                                       | Also allowed               | Reason                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `Card`, `Empty`, `Field`, `Fieldset`, `ScrollArea`, `InputGroup`, and names ending in `Header`, `Content`, `Footer`, `Panel`, `Group`, or `Body` | Spacing                    | The page owns a container's padding and gaps.                                    |
| Names ending in `Title`, `Description`, `Label`, `Legend`, or `Caption`                                                                          | Typography except `font-*` | Text size and alignment vary by page; family and weight stay with the primitive. |
| `TableHead`, `TableCell`, `TableRow`                                                                                                             | Spacing, typography        | Columns set their own padding and text style.                                    |
| `Skeleton`                                                                                                                                       | Shape                      | A skeleton takes the shape of what it stands in for.                             |

`Button`, `Badge`, `Toggle`, `Input`, `Textarea`, `Kbd`, triggers, popups, and menu items get the
default layout-only policy. When a call site needs a look no variant provides, add the variant to
the primitive and use it by name.

`apps/mobile` is out of scope. Its theme tokens live in uniwind `@layer theme` blocks that
`@shadcn/lint` does not read, so real classes such as `bg-screen` come back as unknown. React
Native also styles through `style` objects, which `no-inline-styles` would reject everywhere.

### max-lines

Files may have at most 800 lines, not counting blank lines and comments. When a file passes the
limit, split it along a real seam, such as a component, a service, or a group of tests that share
a fixture. Splitting at an arbitrary line count does not help.

`max-lines` and `anti-slop/require-readable-spacing` are errors. No hand-written file is over the
limit, and `vp lint --fix` applies the spacing rule, so run it on new files before committing.

## Severity ratchet

Every enabled rule is an `error`. A new rule lands as `error` with its findings fixed in the same
change. If a rule has too many findings to fix at once, it may land as `warn` with a recorded
count, and it moves to `error` in the pull request that brings that count to zero.

To count one rule:

```bash
vp lint --format json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const rule = process.argv[1];
    console.log(JSON.parse(s).diagnostics.filter((d) => d.code === rule).length);
  });' 'anti-slop(no-runtime-typeof)'
```

Do not add a `warn` rule without a count, and do not move a rule back from `error` to `warn` to
land a change. Fix the code or argue for turning the rule off, with the reason written next to it
in the config.

Test files (`*.test.*`, `test/`, `testUtils/`, `test-support/`) turn off
`require-safety-comment-for-type-assertion`, `no-manual-tagged-construction`,
`no-service-constructor-imports`, and `no-reflect-get`. Tests build partial fixtures, tagged
values, and service doubles by hand on purpose, and Proxy-based SDK doubles need `Reflect.get` to
keep getter receivers.

Provider composition roots (drivers, adapters, the agent controller, and the Grok session
runtime) turn off `no-service-constructor-imports`. Each configured provider instance builds its
own scoped runtime by calling `make*` constructors, so there is no singleton service to yield.
Grok text generation is on the same list because each request owns a scoped ACP process. The
file list lives in `vite.config.ts`; add a file only when it owns per-instance construction.

Standalone scripts (`apps/desktop/scripts/`, the `.mjs` and `.cjs` files in `scripts/`, and the
Codex mock peer fixture) and the plugin catalog in `plugins/` turn off `no-global-process-runtime`
and `no-runtime-typeof`. They run without the Effect runtime or any application dependency, so
there is no `HostProcessPlatform` to inject and no `Predicate` to import.

There are no inline exceptions. `akeru/no-lint-suppressions` reports every `oxlint-disable`,
`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, and `@effect-diagnostics`
comment, and
`typescript/no-explicit-any` reports `any`. A file-wide `oxlint-disable` would also silence that
rule, so `vp run lint` finishes with `scripts/check-lint-suppressions.ts`, which scans tracked
sources directly. Vendored and generated code is excluded and fixed at its source.

When a rule is wrong for a whole category of code, change its configuration in `vite.config.ts`
with the reason beside it, as the test-file override above does. To assert that a value fails to
type-check, use `expectTypeOf` from Vitest rather than `@ts-expect-error`.

## Effect diagnostics

The Effect language service (`@effect/tsgo`) runs inside every `tsgo` typecheck. Its rules ban
Node built-in imports, global `Date`, `fetch`, timers, `console`, and `JSON.parse` in favor of
Effect services, and flag Effect anti-patterns. Severities live in `tsconfig.base.json` under
`compilerOptions.plugins[0].diagnosticSeverity`, all at `error`.

Exceptions apply to whole categories of code through `overrides` in the same file, each with
its reason beside it. Today they cover tests and test harnesses, build and release scripts, and
the feedback Worker. Two quirks of the override matcher: globs match absolute paths, so each
needs a leading `**/`, and a glob must end in a file pattern such as `**/scripts/**/*.ts`
because a bare directory glob matches nothing. Overrides are also ignored in a project with
`composite: true`, which is why no app tsconfig sets it.

To find diagnostics, run `tsgo --noEmit -p <package>` and look for lines ending in
`effect(<rule>)`. Suggestion-level findings print without failing the exit code; fix them too.

## Updating the vendored anti-slop copy

Anti-slop has no npm package. The repo owns the copy in `oxlint-plugin-anti-slop/`, and its
[README](../../oxlint-plugin-anti-slop/README.md) records the upstream commit and our local
changes.

Follow the `install-anti-slop` skill in
[`.agents/skills/install-anti-slop/`](../../.agents/skills/install-anti-slop/SKILL.md). It stages
upstream in a temporary directory, merges against the recorded base commit, and keeps local
changes. After an update:

1. Run the plugin tests and typecheck:

   ```bash
   vp run --filter @akeru/oxlint-plugin-anti-slop test
   vp run --filter @akeru/oxlint-plugin-anti-slop typecheck
   ```

2. Add any new rule to `ANTI_SLOP_RULES` in `vite.config.ts`, counted and ratcheted as above.
3. Update the provenance section of the plugin README.

Keep `@oxlint/plugins` pinned to the exact Oxlint version Vite+ resolves (`1.72.0` with
`vite-plus` 0.2.2). The root `package.json` and the plugin's `package.json` both pin it. When
Vite+ moves Oxlint, move both pins with it.

## Known limits

- `@shadcn/lint` documents Oxlint 1.80 or later. The repo runs Oxlint 1.72 through Vite+ 0.2.2.
  The enabled rules load and report correctly there. Check again after upgrading Vite+.
- `@shadcn/lint` prints one warning per run because the web app depends on `cn` 0.2.4. It falls
  back to its bundled `cn` 0.3.2 grammar, so findings are unaffected. The message goes away when
  `apps/web` moves to `cn` 0.3.2 or later.
- Anti-slop rules read one file at a time. They do not follow imported types, so a few patterns
  slip through and a few findings need judgment. Each rule's limits are in the upstream README.
