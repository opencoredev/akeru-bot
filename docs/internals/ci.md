# CI quality gates

> For Akeru Bot maintainers.

[`.depot/workflows/ci.yml`](../../.depot/workflows/ci.yml) runs on each ready pull request revision.
Draft pull requests do not use a Depot runner. A new revision cancels the older run for that pull
request. Maintainers can also dispatch the workflow manually for diagnostics. The workflow uses one
4-vCPU `depot-ubuntu-24.04-4` runner.
Issue-label, PR-vouch, and PR-size jobs stay in GitHub Actions on `ubuntu-24.04` because they write GitHub issue and pull-request labels.

- **Repository checks.** The job rejects external local dependencies, installs the committed
  lockfile once, checks lint and formatting, runs workspace type checks,
  validates the plugin directory and contribution policy, builds the desktop pipeline, checks the
  preload output, builds the marketing site, tests shipped packages and the resource monitor, and
  checks release-only configuration. Relay and mobile-production packages are excluded. The same
  job runs the complete server suite. It excludes
  `orchestrationEngine.integration.test.ts` until the executor stack
  restores its test adapter and stops the fixture from calling OpenAI with a test credential.

The repository ruleset requires the Depot `Repository checks` result before a pull request can
merge. Direct pushes to `main` cannot bypass this gate. Release workflows start after the validated
revision lands on `main`; version packaging is separate from pull-request CI.

[`.depot/workflows/release-smoke.yml`](../../.depot/workflows/release-smoke.yml) is a manual, non-publishing
artifact smoke workflow. It uses 4-vCPU Depot runners for Linux, 8-vCPU Windows, plus Apple Silicon
macOS. It builds a Developer ID signed macOS arm64 app. Electron-builder notarizes and staples the
app before it packages the DMG. The workflow then submits and staples the DMG as a separate object.
It checks both objects with Apple's verification tools. Windows and Linux artifacts stay unsigned.
The workflow also builds and dry-runs the CLI package and checks the marketing site. It uploads
desktop artifacts for seven days. It does not create a GitHub release, publish a package, or deploy
a site.

Merging a stable version change to `main` starts [the native stable workflow](../../.github/workflows/release.yml).
GitHub-hosted macOS, Windows, and Linux runners build the advertised desktop targets before the
workflow creates the `vX.Y.Z` tag and GitHub Release. The final job verifies the exact asset names
and `SHA256SUMS`. Missing signing credentials produce unsigned macOS and Windows artifacts.
Complete credentials use the existing Developer ID, notarization, and Azure Trusted Signing paths.

See the [release smoke runbook](../operations/release.md) for the exact validation path.
