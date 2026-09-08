# CI quality gates

> For Akeru Bot maintainers.

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on each ready pull request revision.
Draft pull requests do not use a runner. A new revision cancels the older run for that pull request.
Maintainers can also dispatch the workflow manually for diagnostics. The workflow uses one 4-vCPU
`tenki-standard-medium-4c-8g` Linux runner.
Issue-label, PR-vouch, and PR-size jobs also use Tenki Linux runners through GitHub Actions.

- **Repository checks.** The job rejects external local dependencies, installs the committed
  lockfile once, checks lint and formatting, runs workspace type checks,
  validates the plugin directory and contribution policy, builds the desktop pipeline, checks the
  preload output, builds the marketing site, tests shipped packages and the resource monitor, and
  checks release-only configuration. Relay and mobile-production packages are excluded. The same
  job runs the complete server suite. It excludes
  `orchestrationEngine.integration.test.ts` until the executor stack
  restores its test adapter and stops the fixture from calling OpenAI with a test credential.

The repository ruleset requires the `Repository checks` result before a pull request can
merge. Direct pushes to `main` cannot bypass this gate. Release workflows start after the validated
revision lands on `main`; version packaging is separate from pull-request CI. The version workflow
updates the pull request body after Tegami updates its branch, then dispatches CI for that branch.
This explicit dispatch is required because pushes made with the GitHub Actions token do not start
another pull-request workflow.

[`.github/workflows/release-smoke.yml`](../../.github/workflows/release-smoke.yml) is a manual,
non-publishing artifact smoke workflow. It uses a 4-vCPU Tenki runner for Linux and GitHub-hosted
Apple Silicon macOS and Windows runners. It builds a Developer ID signed macOS arm64 app.
Electron-builder notarizes and staples the
app before it packages the DMG. The workflow then submits and staples the DMG as a separate object.
It checks both objects with Apple's verification tools. Windows and Linux artifacts stay unsigned.
The workflow also builds and dry-runs the CLI package and checks the marketing site. It uploads
desktop artifacts for seven days. It does not create a GitHub release, publish a package, or deploy
a site.

Merging a stable version change to `main` starts
[the stable release workflow](../../.github/workflows/release.yml). A push that changes a watched
manifest without changing the stable version exits successfully before any release build starts.
A manual dispatch for an existing stable tag still fails. A Tenki Linux runner plus GitHub-hosted
Apple Silicon macOS and Windows runners build the advertised desktop targets before the workflow
creates the `vX.Y.Z` tag and GitHub Release. The final job verifies the exact asset names and
`SHA256SUMS`, then starts the next Version Packages update. Version automation waits for the current
stable tag before it prepares another version.
Missing signing credentials produce unsigned macOS and Windows artifacts.
Unsigned macOS builds still replace Electron's linker-signed stub with a sealed ad-hoc signature
and fail the release if `codesign --verify` fails or the identifier is not `dev.leodoes.akeru`.
Complete credentials use the existing Developer ID, notarization, and Azure Trusted Signing paths.

See the [release smoke runbook](../operations/release.md) for the exact validation path.
