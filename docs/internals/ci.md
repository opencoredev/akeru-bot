# CI quality gates

> For Akeru Bot maintainers.

[`.depot/workflows/ci.yml`](../../.depot/workflows/ci.yml) runs on pull requests and pushes to `main`.
All jobs use Depot CI on the 8-vCPU `depot-ubuntu-24.04-8` runner.
Issue-label, PR-vouch, and PR-size jobs stay in GitHub Actions on `ubuntu-24.04` because they write GitHub issue and pull-request labels.

- **Public dependency install.** The job rejects `file:` and `link:` dependencies that resolve
  outside the repository, then runs `vp install --frozen-lockfile`.
- **Lint, types, and builds.** The job checks lint and formatting, runs workspace type checks,
  validates the plugin directory and contribution policy, builds the desktop pipeline, checks the
  preload output, and builds the marketing site.
- **Focused tests.** Separate jobs run the shipped desktop and shared-package tests, the sharded
  server tests, and the resource-monitor tests. Relay and mobile-production packages are excluded.
  The server shards exclude `orchestrationEngine.integration.test.ts` until the executor stack
  restores its test adapter and stops the fixture from calling OpenAI with a test credential.
- **Release smoke.** `scripts/release-smoke.ts` checks the public dependency rule, the supported
  artifact matrix, Akeru naming, and the absence of retired publishing and deployment paths.

[`.depot/workflows/release-smoke.yml`](../../.depot/workflows/release-smoke.yml) is a manual, non-publishing
artifact smoke workflow. It uses 8-vCPU Depot runners for Linux and Windows, plus Apple Silicon
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
