# Dead code

> For Akeru Bot maintainers and the agents that work on the repo.

[Knip](https://knip.dev) finds files nothing imports, dependencies nothing uses, imports of
packages a workspace does not declare, and exports no other module reads. The configuration is
[`knip.jsonc`](../../knip.jsonc) at the repo root. CI runs it after lint:

```bash
vp run knip
```

A full run takes about six seconds. Unused files, dependencies, unlisted imports, unresolved
imports, binaries, and catalog entries fail the run. Unused exports, unused exported types, and
duplicate exports print as warnings and do not fail it yet (see [Exports](#exports)).

## Entry points

Knip follows imports from entry files. Its plugins read most entries from tool configuration:
`package.json` `bin` and `exports`, Vite and Vitest configs, Astro, Expo, and the workspace
scripts. `knip.jsonc` adds the ones a plugin cannot see:

| Workspace                                        | Extra entries                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `apps/server`                                    | `src/service-launcher.ts` (packed separately), `scripts/`, `integration/`, compile-only `*.types.ts` type tests |
| `apps/web`                                       | `index.html`, `scripts/`, the `test/` browser harnesses                                                         |
| `apps/desktop`                                   | Electron main and preload bundles, `scripts/`, `src/preview/Annotation.css` (read by a build script)            |
| `apps/mobile`                                    | Local Expo modules (installed as `file:` dependencies) and Metro platform files such as `Foo.ios.tsx`           |
| `apps/marketing`                                 | `middleware.ts`, the Vercel routing middleware                                                                  |
| `infra/feedback`                                 | `alchemy.run.ts`                                                                                                |
| `oxlint-plugin-akeru`                            | `index.ts`, loaded by `vite.config.ts` as a JS plugin                                                           |
| `packages/effect-acp`, `effect-codex-app-server` | Generator scripts and protocol probes                                                                           |
| `scripts`                                        | Every top-level script and `mobile-showcase/`                                                                   |

Test files are entries in every workspace, so code used only by tests counts as used.

## Exceptions

Each exception sits in `knip.jsonc` with its reason. They fall into a few groups:

- **Not ours to prune.** `.repos/` reference checkouts, the vendored anti-slop plugin, the
  dither-kit components installed from the tripwire.sh registry (`apps/web/dither-kit.json`
  tracks them), and the design-system primitives in `apps/web/src/components/ui/`.
- **Runtime dependencies with no static import.** The server's CLI bundle keeps `node-pty`,
  `libsql`, `execa`, `msgpackr-extract`, and `@effect/platform-node-shared` external
  (`scripts/lib/cli-external-packages.ts`). `@expo-google-fonts/dm-sans` is loaded by path from
  `app.config.ts`. `electron-builder` is driven by the desktop artifact build in `scripts/`.
- **Toolchain pins.** `@oxlint/plugins` matches the Oxlint version Vite+ resolves.
  `@babel/plugin-transform-react-jsx` is hoisted for `babel-preset-expo` in EAS builds.
  `@effect/language-service` comes from the `@effect/tsgo` patch.
- **System binaries** called from scripts and tests (`openssl`, `plutil`, `sips`, and others),
  plus the globally installed `eas` CLI.

Add an exception only when Knip cannot see a real use. Write the reason next to it.

## Backlog

These findings are real but need a product or device check before removal. Each is listed in
`knip.jsonc` under a "Backlog" comment. Remove the entry in the change that resolves it.

| Finding                                                             | Detail                                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/roster/ActiveBotHeaderChip.tsx`            | Nothing renders the chip. `BotSettingsPage.test.ts` still reads its source to assert the chat-header route into bot settings, so that test guards an entry point users cannot reach. |
| `apps/mobile/src/features/usage/UsageDailyChart.tsx` and `.ios.tsx` | No mobile screen imports the daily usage chart.                                                                                                                                      |
| `expo-system-ui` (unlisted in `apps/mobile`)                        | `app.config.ts` sets `userInterfaceStyle`, which Expo applies on Android only when `expo-system-ui` is installed. Check Android dark mode before adding it.                          |
| `msw` in `apps/web`                                                 | No test starts the MSW worker. Removing it also removes `apps/web/public/mockServiceWorker.js` and the root `msw` block in `package.json`.                                           |
| `@akeru/contracts` in `scripts`                                     | No script imports it; the dev runner names it only as a `--filter`.                                                                                                                  |

## Exports

Unused exports are on the same ratchet as lint warnings
([lint.md](./lint.md#severity-ratchet)). `ignoreExportsUsedInFile` is on, so an export the module
uses itself is not reported. Counts on 2026-10-30:

| Workspace                 | Unused exports | Unused exported types |
| ------------------------- | -------------- | --------------------- |
| `apps/web`                | 181            | 37                    |
| `apps/server`             | 170            | 60                    |
| `apps/desktop`            | 39             | 8                     |
| `apps/mobile`             | 30             | 13                    |
| `packages/client-runtime` | 1              | 0                     |
| Total                     | 421            | 118                   |

Knip also reports 13 duplicate exports, where one value is exported under two names.

Many unused exports are Effect service pieces, schema members, or helpers that lost their last
caller. Drop the `export`, or the code, when you touch the file. When a workspace reaches zero,
the exports rule can move from `warn` to `error` in `knip.jsonc`.
