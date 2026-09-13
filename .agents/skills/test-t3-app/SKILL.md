---
name: test-t3-app
description: Launch and verify Akeru Bot web and desktop in isolated development environments. Use for browser testing, Electron-specific checks, pairing recovery, debug access, and fixture setup.
---

# Test Akeru Bot web and desktop

Read [the verification policy](../../../docs/internals/verification.md) before launching a client. It defines authorization, coverage, evidence, and environment lifetime. For native mobile testing, use [`test-t3-mobile`](../test-t3-mobile/SKILL.md).

## Find or start the environment

1. Run commands from the repository root. Run `vp run dev:status` to inspect the current environment without starting it. Reuse an owned healthy environment and its authenticated browser context.
2. Use the worktree-local `.akeru` home. For a separate test, create a temporary directory and retain its absolute path. An explicit home stores runtime state in `<home>/userdata`.
3. Run `vp run dev` in the background. Use `--home-dir <path>` only for a deliberately selected isolated home. Add `--share` only when the user requests access from another tailnet device.
4. Retain the task handle, selected ports, home, and startup output. Read actual ports from `[dev-runner]`; occupied ports can shift them.
5. Confirm the selected home before loading fixtures or pairing. Worktree defaults outrank ambient home settings. Never start a test server against the live `~/.akeru/userdata` database.

The setup script copies optional project `.env` configuration into each new worktree. Existing `.env` files are preserved. If setup reports a legacy symlink, replace it with a private copy before editing configuration. Keep secrets out of test evidence.

Browser dev is single-origin. Vite proxies backend requests; leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Automated runs leave browser auto-open disabled so an uncontrolled tab cannot consume the startup token.

## Pair the controlled browser

1. Load the browser skill for the tool available in the current harness. With `agent-browser`, read its skill and run `agent-browser skills get core --full` before the first browser action. Keep one background browser session for this task.
2. Open the complete startup URL ending in `/pair#token=...` once. Preserve the fragment exactly.
3. Wait for the pairing exchange and redirect. Verify that the intended environment and projects appear.
4. Continue in the same browser context. A pairing page or disconnected empty view does not prove a connection.

Recover an expired or consumed token with `node apps/server/src/bin.ts pair`. If the server uses an explicit home, pass `--base-dir <same-absolute-path>`. Discovery reads the running server's origin, including its shared origin.

Recovery tokens have standard client scopes. The startup URL has admin scopes needed for Settings → Connections management. For that flow, restart only the owned test server and use its new startup URL.

Keep tokens out of screenshots and durable evidence. A human and an agent need separate tokens. When handing over shared access, first check the shared bare origin in the browser without consuming the human's token. Then provide the full fresh pairing URL to the user.

## Prepare data and verify behavior

Read [SQLite fixtures](references/sqlite-fixtures.md) when preparing data or inspecting state. Prefer deterministic fixtures for repeatable visual checks. Use a safe snapshot of real data when reproducing a data-specific defect.

Exercise the affected flow using clicks, typing, submission, and navigation. Apply the coverage and evidence checks in the verification policy. A screenshot alone is not a behavior test.

## Desktop-specific verification

Use a web pass for shared renderer-only changes. Run Electron when a change touches the desktop shell, IPC, native menus, protocol links, preload, packaged origins, startup, or process cleanup.

1. Build with `vp run build:desktop`. For an automated startup check, run `vp run test:desktop-smoke`. The smoke script creates private application and OS home directories and stops its captured Electron process group.
2. For interactive inspection, use the installed raw Electron executable with `apps/desktop/dist-electron/main.cjs`. Resolve the executable and create its private environment with `resolveSmokeElectronPath` and `createSmokeEnvironment` from `apps/desktop/scripts/smoke-test.mjs`. Create the returned home, temporary, and config directories before spawning. Retain the temporary root and captured process group.
3. Set `T3CODE_HOME` and `AKERU_HOME` to the same isolated fixture home. Use a different home from any running backend. Pass `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<free-port>` to that Electron process.
4. Attach the supported browser tool to that exact Electron instance. With `agent-browser`, use a named session and `connect <port>` after loading its version-matched guidance. Confirm the app and environment before acting.
5. Exercise the Electron behavior itself, then recheck after the relevant reload or restart. A successful external web tab does not prove shell behavior. Use native automation only when browser tools cannot reach the control, within the verification policy's authorization boundary.

`--home-dir` isolates server data, not Electron's OS profile. The branded development launcher can also register OS protocol handlers. Use the raw runtime for isolated checks; test the branded launcher only when its OS integration is in scope and authorized. Startup log markers prove less than renderer content and interaction. Packaged-artifact tests must also isolate the OS home; `--user-data-dir` alone can be overridden by the app.

The debug port is local test access. Do not expose it through a tunnel. If attaching is unavailable, report the missing tool and what focused tests could prove instead.

## Diagnose and finish

- Run `vp run dev:status` to confirm the selected home and runtime state before diagnosing an unexpected screen.
- Inspect `<home>/userdata/logs/server.trace.ndjson` for explicitly selected or worktree homes. See [observability](../../../docs/operations/observability.md) for trace fields and provider logs.
- Preserve background stdout/stderr for startup failures. Share only the errors relevant to the failed action.
- If pairing fails, mint a fresh token and confirm home and origin rather than retrying the same URL.
- Retain or tear down the environment according to the verification policy. Stop only the task or process group captured at launch.
