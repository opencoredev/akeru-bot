# CI quality gates

> For Akeru Bot maintainers.

[`ci.yml`](../../.github/workflows/ci.yml) runs on pull requests and pushes to `main`.
All jobs use Depot's 8-vCPU `depot-ubuntu-24.04-8` GitHub Actions runner.
The issue-label, PR-vouch, and PR-size maintenance workflows use the same Depot runner.

- **Public dependency install.** The job rejects `file:` and `link:` dependencies that resolve
  outside the repository, then runs `vp install --frozen-lockfile`.
- **Lint, types, and builds.** The job checks lint and formatting, runs workspace type checks,
  builds the desktop pipeline, checks the preload output, and builds the marketing site.
- **Focused tests.** Separate jobs run the shipped desktop and shared-package tests, the sharded
  server tests, and the resource-monitor tests. Relay and mobile-production packages are excluded.
- **Release smoke.** `scripts/release-smoke.ts` checks the public dependency rule, the supported
  artifact matrix, Akeru naming, and the absence of retired publishing and deployment paths.

[`release.yml`](../../.github/workflows/release.yml) is a manual, non-publishing artifact smoke
workflow. It uses 8-vCPU Depot runners for Linux and Windows, plus Apple Silicon macOS. It builds a
Developer ID signed macOS arm64 app. Electron-builder notarizes and staples the app before it packages
the DMG. The workflow then submits and staples the DMG as a separate object. It checks both objects
with Apple's verification tools. Windows and Linux artifacts stay unsigned. The workflow also builds
and dry-runs the CLI package and checks the marketing site. It uploads desktop artifacts for seven
days. It does not create a GitHub release, publish a package, or deploy a site.

See the [release smoke runbook](../operations/release.md) for the exact validation path.
