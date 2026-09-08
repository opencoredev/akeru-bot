# Akeru Bot

Akeru Bot is an independent fork of [T3 Code](https://t3.codes). It is a desktop app for named teammate bots, with web and mobile clients that connect to the same environment server.

Akeru Bot is local-first software. It has no hosted account and does not provide model access. Users connect an existing ChatGPT, Claude, Grok, or Kimi For Coding subscription. Five provider drivers ship built in: Codex, Claude, Grok, Kimi For Coding, and OpenCode.

Conversations, bot profiles, settings, secrets, and logs live under `~/.akeru`. Worktree state lives under `.akeru`. Akeru Bot never shares T3 Code's `~/.t3` database or desktop profile.

Akeru Bot is not affiliated with ping.gg.

## Project ownership and upstream

Leo maintains Akeru Bot and sets its product direction.

Akeru Bot began as a fork of T3 Code. The T3 Code team and contributors created the original codebase. Preserve their copyright, the MIT license, and clear credit for their work.

Akeru Bot may port or adapt upstream T3 Code changes when they fit. Treat each one as a reviewed port, not a blind sync. Check it against Akeru's product identity, `.akeru` data boundary, provider architecture, and current tests. Do not describe upstream work as original Akeru work.

## Product principles

Akeru keeps the upstream qualities that made T3 Code useful while it develops its own product and makes its own decisions.

### 1. Open at the core

Akeru Bot remains open source. Keep changes understandable to users and fork maintainers.

### 2. Performance without compromise

Protect performance. Common regressions come from oversized WebSocket payloads, costly CSS animations, and lists that render too much work.

### 3. Remote ready

Akeru Bot's WebSocket layer and `npx akeru-bot` server support local networks, SSH, Tailscale, and user-managed tunnels. New features must work when the client and environment server run on different machines.

### 4. Multi-surface

Akeru Bot has three client surfaces: **web**, **desktop**, and **mobile**.

**Web** is hosted by the environment server and uses the same authenticated RPC connection as the other clients.

**Desktop** is the main Akeru Bot product. It is an Electron app that bundles the server runner and can host remote client connections.

**Mobile** is a React Native client for iOS and Android. It connects to an Akeru Bot environment server to control work remotely.

## Engineering direction

Build ambitious ideas with simple systems. Do not preserve complexity because it already exists or add machinery for its own sake. Find the real constraint, then choose the smallest model that makes correct behavior unsurprising.

Measure twice, cut once. Apply YAGNI. Control scope and follow Leo's intent when a general rule conflicts with the task.

Most Akeru Bot contributions come from an agent running through the product itself, often under remote control. Be careful with data and dev servers because the contributor may be using the same environment.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Akeru Bot.
- **we, us, and maintainers** mean Leo and the people working with him on Akeru Bot. Theo, Julius, and the T3 Code contributors are upstream authors and maintainers.
- **user** means the person using Akeru Bot to work with named teammate bots.
- **bot** means the named teammate a user configures and talks to in Akeru Bot.
- **agent** means the provider runtime or coding process behind a bot. Depending on context, agent may also include you.
- **provider** means the agent runtime Akeru Bot talks to: Codex, Claude, Grok, Kimi For Coding, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running Akeru Bot server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **chat** means the user-facing conversation with a bot. Use chat or conversation in interface copy and user documentation.
- **thread** means the internal durable record for one chat and its work history. Use thread in source identifiers, contracts, architecture documentation, logs, and compatibility paths.
- **turn** means one user request and the bot work that follows it inside a chat.
- **Akeru home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.akeru/userdata` is the developer's real Akeru Bot database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Grok, Kimi For Coding, and OpenCode each need an explicit decision. Codex and Kimi use Akeru's Mastra controller. Claude, Grok, and OpenCode use the legacy adapter bridge.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktree setup installs dependencies, copies optional `.env` configuration without sharing later edits, and warms the web cache. It preserves existing local `.env` files and refuses legacy symlinks. If module resolution is broken, check setup first.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.akeru`, which deliberately outranks an ambient `T3CODE_HOME` or `AKERU_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

Choose meaningful test data. Use deterministic visual fixtures for repeatable UI checks; see [SQLite fixtures](.agents/skills/test-t3-app/references/sqlite-fixtures.md). For a data-specific defect, seed your worktree's `.akeru` with a safe snapshot instead of pointing at live state:

- Copy from `~/.akeru/userdata` or `~/.akeru/dev`. Worktree state lives at `<worktree>/.akeru/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  SNAPSHOT_HOME=$(mktemp -d /tmp/akeru-snapshot.XXXXXX)
  mkdir -p "$SNAPSHOT_HOME/userdata"
  SNAPSHOT_HOME="$SNAPSHOT_HOME" node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.HOME + '/.akeru/userdata/state.sqlite', { readOnly: true }); db.prepare('VACUUM INTO ?').run(process.env.SNAPSHOT_HOME + '/userdata/state.sqlite'); db.close();"
  # Start the test server with --home-dir "$SNAPSHOT_HOME".
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Implementation requests include focused verification in isolated local clients. Follow [the verification policy](docs/internals/verification.md) for authorization, coverage, evidence, and environment lifetime. Use `test-t3-app` for web or desktop and `test-t3-mobile` for native mobile. The primary agent performs the integrated pass; subagents do not launch dev servers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Merge pull requests only after the required `Repository checks` job passes. See [`docs/internals/ci.md`](docs/internals/ci.md) for CI behavior.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in `docs/internals/`. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Ask before controlling the user's live desktop session or physical devices. Isolated local verification follows the policy above.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
