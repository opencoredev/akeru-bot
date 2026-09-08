# Scripts

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

## First checkout

Akeru Bot uses [Vite+](https://viteplus.dev/guide/). Install the global `vp` command, install
dependencies, then start the dev stack:

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

Node 24 is required. Bun is not: the server picks Bun adapters when it detects Bun and falls back to
Node otherwise, and nothing in contributor setup needs it.

`vp run dev` prints a one-time pairing URL. Open it so the first browser navigation is
authenticated.

## Dev

- `vp run dev`: Starts contracts, server, and web in watch mode.
- `vp run dev --share`: Also publishes the web port over HTTPS on this machine's tailnet. The
  startup pairing URL is built against the shared origin, and the mapping is removed on exit.
  Shared runs default to Vite's bundled dev mode (`T3CODE_BUNDLED_DEV=1`): a remote browser pays a
  network round trip per import level in unbundled dev, which turns a cold module graph into
  minutes of waterfall. Set `T3CODE_BUNDLED_DEV=0` to opt a shared run back out.
- `vp run dev --browser`: Auto-opens a browser. Off by default. The dev runner writes
  `T3CODE_NO_BROWSER` itself from this flag, so setting `T3CODE_NO_BROWSER=0` in your environment has
  no effect; use `--browser`.
- `vp run dev:server`: Starts just the server. It runs on Node (`node --watch src/bin.ts`), so
  without Bun present it selects `NodePtyAdapter` and `NodeHttpServer`.
- `vp run dev:web`: Starts just the Vite dev server for the web app.
- `vp run dev:desktop`: Starts the Electron shell against the dev server.
- `vp run dev:marketing`: Starts the Astro marketing site.
- Pass dev-runner flags directly after the root task name, for example:
  `vp run dev --home-dir /tmp/t3code-dev`

### Dev state directories

- Dev commands run from a linked **git worktree** default to that worktree's gitignored `.akeru`, even
  when `T3CODE_HOME` is set, storing state in `<worktree>/.akeru/userdata`. Pass `--home-dir <path>` to
  choose another isolated directory explicitly. Submodules are not worktrees and keep the normal
  precedence.
- From the **main checkout**, dev commands implicitly use `~/.akeru/dev`, keeping development state
  separate from `~/.akeru/userdata`. An explicit `--home-dir <path>` stores state under
  `<path>/userdata`; the base directory remains available for caches, worktrees, and other shared
  data.

### Dev status

Run `vp run dev:status` for a read-only status report. Use
`vp run dev:status --home-dir <path>` to inspect an explicit Akeru home.
The command uses the existing `server-runtime.json`; it does not scan ports or create a registry.

- Reports the checkout root, linked worktree, Akeru home, data directory, recorded server and web
  origins, trace path, and missing local prerequisites.
- Uses the same worktree home helper as the dev runner. An explicit `--home-dir` wins, then the
  worktree home, then `T3CODE_HOME`. The implicit main-checkout fallback is `~/.akeru/dev`.
  Explicit and worktree homes use `userdata`. `AKERU_HOME` is not a dev-runner override.
- Checks the recorded PID without sending a signal. Missing or stale runtime files remain unchanged.
  Recorded origins from stale files are historical, not proof that a server is running.
- Makes credential-free HTTP HEAD checks only on loopback. It does not follow redirects or contact
  remote origins. HTTP responses show availability, not verified application readiness.
- Reports desktop debug-port configuration and the command that resolves current mobile identity
  from app configuration. It does not duplicate bundle IDs or infer installed clients from settings.
  Provider credentials, native toolchains, and installed mobile apps are not checked.
- Does not print pairing URLs, URL credentials, queries, fragments, or arbitrary environment values.
  It does not read the database, start a server or browser, or change state, including in live homes.

### Worktree setup and verification

Worktree setup runs `scripts/setup-worktree-env.ts` after dependency installation. It copies optional
project `.env` configuration with private permissions, preserves an existing regular file, and
refuses a legacy symlink. Changes to the worktree copy do not change the source checkout.

Use `vp run dev:fixture --base-dir <empty-home> --case <empty|populated|edge>` for repeatable,
offline visual data. The command runs migrations, guards the home and database, and backs up repeated
fixture writes. After pairing or business activity, create a fresh fixture home. See
[the fixture recipe](../../.agents/skills/test-t3-app/references/sqlite-fixtures.md).

Follow [local verification](verification.md) for client coverage, evidence, and environment lifetime.
The app testing skill includes Electron debug attachment; mobile testing resolves development identity
from app configuration rather than copied identifiers.

## Build, check, test

- `vp run build`: Fans out over `apps/*`, `packages/*`, `oxlint-plugin-t3code`, and `scripts`.
  Workspaces that define a build task run one: desktop, marketing, server (which depends on web), and
  web. Shared packages are consumed and bundled transitively rather than built separately.
- `vp run build:desktop`: Builds the desktop pipeline (desktop plus server).
- `vp run test:desktop-smoke`: Launches the built app with the installed raw Electron runtime in
  temporary application and OS homes. Requires backend-ready and main-window-created logs without
  a fatal error or early exit, then stops its captured process group and removes its temporary data.
  This proves startup, not renderer interaction. See the desktop testing skill for that check.
- `vp run start`: Runs the production server (serves the built web app as static files).
- `vp check`: Vite+ format, lint, and type checks. This repo sets `typeCheck: false` in its lint
  options, so workspace type checking runs separately.
- `vp run typecheck`: Strict TypeScript checks for all packages.
- `vp run test`: Runs workspace tests.
- `vp run lint:mobile`: Mobile native static analysis (`scripts/mobile-native-static-check.ts`).
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...`: Inspects or seeds
  an isolated T3 SQLite database; writes create a private backup first.

## Desktop artifacts

- `vp run dist:desktop:artifact --platform <mac|linux|win> --target <target> --arch <arch>`: Builds a desktop artifact for a specific platform/target/arch.
- `vp run dist:desktop:dmg`: Builds a shareable macOS `.dmg` into `./release`. Architecture defaults
  to the host, so this produces an arm64 DMG on Apple Silicon. Use `dist:desktop:dmg:arm64` or
  `dist:desktop:dmg:x64`, or pass `--arch <arm64|x64|universal>`, to force one.
- `vp run dist:desktop:linux`: Builds a Linux AppImage into `./release`.
- `vp run dist:desktop:win`: Builds a Windows NSIS installer into `./release`. `:arm64` and `:x64`
  variants exist.

### Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing. Unsigned macOS builds still apply a
  sealed ad-hoc signature (`identity: "-"`) so Gatekeeper does not treat Electron's leftover
  linker-signed stub as a damaged app. Notarized Developer ID builds require `--signed`.
- Browser DMG downloads are still quarantined. The unsigned Mac path is a Terminal recipe that
  pins one GitHub release tag, downloads that tag's arm64 DMG and `SHA256SUMS`, verifies the
  checksum, then copies the app into `/Applications`. curl does not set `com.apple.quarantine`.
- The DMG build uses `assets/prod/akeru-macos-1024.png`, a safe-area export of the production
  favicon artwork, as the production app icon source.
- Production DMGs use neutral chrome. Blueprint artwork remains exclusive to Dev builds. Packaging
  rasterizes the selected SVG into standard and Retina PNGs inside the disposable staging
  directory.
- The Finder window is 540×412 while its background is 540×380; the extra 32px accounts for the
  title bar included in Finder's window bounds.
- Desktop production windows load the bundled UI from the `akeru://app/` root URL (not a
  `127.0.0.1` document URL, and not an explicit `index.html` path).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an
  auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first
  launch.
- To keep staging files for debugging package contents, run: `vp run dist:desktop:dmg --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Signed macOS CI builds use the Developer ID certificate and App Store Connect API secrets
  documented in `docs/operations/release.md`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Browser development

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset so the browser resolves the backend
from `window.location.origin`. Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the
server, allowing the same bundle to work from localhost or a tailnet hostname.

## Running multiple dev instances

Worktrees derive a preferred port offset from their path.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset`
- Example: `T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop`

Offset resolution, in order:

1. `T3CODE_PORT_OFFSET`, which must be a non-negative integer. Negative values are rejected.
2. `T3CODE_DEV_INSTANCE`. An all-digit value is used directly as the offset; any other non-empty
   value is hashed into one.
3. The worktree path hash.

Collision scanning depends on the mode. `dev:web` scans only the web port and shifts only the web
offset. `dev:server` scans only the server port. `dev` and `dev:desktop` scan both and shift them
together as one shared offset. Explicit server or dev-URL overrides remove the corresponding port
from the availability check. Treat the `[dev-runner]` output as authoritative.
