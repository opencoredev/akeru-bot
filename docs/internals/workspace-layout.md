# Workspace layout

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`t3`): the execution runtime and the published CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@akeru/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@akeru/desktop`): Electron shell. Supervises a desktop-scoped `t3` backend,
  loads the web bundle over the `akeru://` protocol, and owns SSH-managed remote environments.
- `apps/mobile` (`@akeru/mobile`): Expo/React Native client. Same client runtime composition as
  web, different platform layer and UI.
- `apps/marketing` (`@akeru/marketing`): Astro marketing site.

## packages

- `packages/contracts` (`@akeru/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@akeru/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and remote-URL helpers, semver, logging, observability, and more).
- `packages/client-runtime` (`@akeru/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state shared by web and mobile. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@akeru/ssh`): SSH config parsing, auth prompts, command execution, and the
  tunnel/environment manager behind desktop-managed SSH environments.
- `packages/tailscale` (`@akeru/tailscale`): Tailscale CLI wrapper, including the
  `ensureTailscaleServe` / `disableTailscaleServe` serve lifecycle the server drives.
- `packages/effect-acp` (`effect-acp`): Effect client and agent implementation of the Agent Client
  Protocol, used by ACP-speaking provider drivers.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## Other top-level directories

- `scripts/`: workspace tooling run through `vp run`. Dev runner, desktop artifact builds, release
  helpers, mobile static checks and showcase capture, update-manifest merging.
- `assets/`: brand and app icon sources for development and production builds.
- `patches/`: pnpm patches for pinned upstream dependencies.
- `oxlint-plugin-akeru/`: repo-specific lint rules.
- `oxlint-plugin-anti-slop/`: vendored anti-slop lint rules. See [Lint rules](./lint.md).
- `experiments/`: throwaway prototypes. Not part of the shipped build.
- `docs/`: this documentation tree.

## Import conventions

`@akeru/shared` and `@akeru/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@akeru/shared/DrainableWorker`,
`@akeru/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@akeru/contracts` exports a root alongside `./settings`.
