# Release smoke runbook

> Do not publish a signed Akeru Bot build until qualified legal counsel approves the current Terms
> of Use and Privacy Policy versions in `packages/contracts/src/settings.ts`.

> For Akeru Bot maintainers.

`.depot/workflows/release-smoke.yml` validates release inputs without publishing or releasing anything.
Dispatch it from Depot with a version such as `0.0.0-smoke.0`.

## What it checks

- Public dependencies install from the committed lockfile. No dependency may resolve through a
  local path outside the repository.
- The release configuration passes `scripts/release-smoke.ts`.
- macOS builds one arm64 DMG with the `dev.leodoes.akeru` bundle identifier.
- Unsigned macOS builds use a sealed ad-hoc signature. The workflow verifies the signature and the
  `dev.leodoes.akeru` identifier.
- Signed macOS builds use a Developer ID Application certificate. Electron-builder submits and
  staples the app before it packages the DMG. The workflow submits and staples the DMG separately.
- Signed apps include the Electron hardened-runtime and microphone entitlements. The workflow
  validates the notarization tickets, then runs `codesign` and `spctl`.
- Windows builds one unsigned x64 NSIS installer.
- Linux builds one unsigned x64 AppImage.
- The CLI build includes the web client, then completes a package publish dry-run.
- The marketing site passes its type check and production build.

Each desktop job uploads its artifact to the workflow run for seven days. The workflow does not
create tags, create GitHub releases, publish npm packages, deploy a site, update AUR, or send
release announcements.

## Depot setup

CI and release smoke run on Depot CI. Code Access is already installed for `opencoredev/akeru-bot`.
GitHub Actions owns the publishing workflow because Depot does not provide the macOS runner and
rejects the Windows runner needed for stable desktop artifacts. All Depot smoke jobs use a Depot
runner label:

- Linux uses the 4-vCPU `depot-ubuntu-24.04-4` runner.
- Windows uses the 8-vCPU `depot-windows-2025-8` runner.
- macOS uses the Apple Silicon `depot-macos-15` image.

## macOS secrets

Add these Depot CI secrets before running the workflow:

- `MACOS_CERTIFICATE_P12` contains the base64-encoded `.p12` export of the Developer ID Application
  certificate and its private key.
- `MACOS_CERTIFICATE_PASSWORD` contains the `.p12` export password.
- `MACOS_SIGNING_IDENTITY` contains the full certificate identity. It must start with
  `Developer ID Application:`.
- `APPSTORE_API_KEY_P8` contains the App Store Connect API private key text.
- `APPSTORE_API_KEY_ID` contains the API key ID.
- `APPSTORE_ISSUER_ID` contains the App Store Connect issuer ID.

The workflow writes the API private key to the temporary runner directory. It imports the
certificate into an ephemeral keychain. Neither file enters an uploaded artifact.

## Local checks

Run the focused checks before using the manual workflow:

```sh
vp install --frozen-lockfile
vp run check:public-dependencies
vp test run scripts/check-public-dependencies.test.ts scripts/resolve-previous-release-tag.test.ts
vp run release:smoke
vp run build:desktop
vp run --filter @t3tools/marketing typecheck
vp run --filter @t3tools/marketing build
```

Run the CLI package dry-run after the server build has produced `apps/server/dist/client`:

```sh
vp run --filter akeru-bot build
node apps/server/scripts/cli.ts publish --dry-run --app-version 0.0.0-smoke.0 --verbose
```

Do not use this smoke workflow as a release procedure. A publishing workflow must be designed and
reviewed separately before Akeru Bot ships a public release.
