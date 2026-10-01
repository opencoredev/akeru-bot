# oxlint-plugin-anti-slop

Vendored copy of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), an Oxlint plugin
that rejects low-evidence TypeScript patterns. Akeru owns this copy. Edit rules here when our
policy differs, and record the change below.

The root `vite.config.ts` registers two entry points: `index.ts` (generic rules) and
`effect/index.ts` (Effect rules). Severities and the reasons behind them live in
[docs/internals/lint.md](../docs/internals/lint.md).

## Provenance

- Source: `https://github.com/dmmulroy/anti-slop`, commit
  `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10).
- Copied: the upstream `src/` tree, including `*.test.ts` suites and
  `vendor/eslint-stylistic/` with its `LICENSE` and `UPSTREAM.md`. Upstream `LICENSE` is kept
  at the root of this directory.
- Vendored: 2026-09-30.
- Base for future three-way merges: the commit above. `git log -- oxlint-plugin-anti-slop` shows
  the pristine import as the first commit that touched this directory.

## Local deviations

- `rules/no-widen-then-assert.ts` and `shared/function-parameters.ts`: type-only changes marked
  `AKERU:`. Upstream targets `@oxlint/plugins` 1.78, whose typings allow a type annotation on a
  binding identifier. We pin 1.72 to match the Oxlint that Vite+ resolves, and its typings say
  `null`. Runtime behavior is unchanged. Drop both once Oxlint reaches 1.78 here.
- `package.json` and `tsconfig.json` are Akeru's. Tests run with `node --test` instead of `tsx`.

## Tests

```bash
vp run --filter @akeru/oxlint-plugin-anti-slop test
vp run --filter @akeru/oxlint-plugin-anti-slop typecheck
```

To update this copy, use the `install-anti-slop` skill in `.agents/skills/`.
