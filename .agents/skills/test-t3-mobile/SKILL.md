---
name: test-t3-mobile
description: Verify Akeru Bot mobile on iOS or Android with an isolated environment, reusable development clients, deterministic pairing, semantic UI control, and focused evidence.
---

# Test Akeru Bot mobile

Read [the verification policy](../../../docs/internals/verification.md) for authorization, coverage, evidence, and environment lifetime. Use [`test-t3-app`](../test-t3-app/SKILL.md) for shared environment discovery, browser pairing, and SQLite fixtures.

## Select the platform and client

1. On macOS with Xcode, use one representative iOS Simulator for cross-platform changes. Load [`ios-debugger-agent`](../ios-debugger-agent/SKILL.md). Load [`ios-simulator-browser`](../ios-simulator-browser/SKILL.md) when a live visual feed is needed.
2. Use Android when the change is Android-specific or iOS tooling is unavailable. Select one emulator serial with `adb devices`.
3. Reuse a compatible installed development client for JavaScript, TypeScript, and asset changes. Rebuild only when native source, dependencies, entitlements, config plugins, or generated projects changed.
4. Resolve identity with `node .agents/skills/test-t3-mobile/scripts/app-identity.mjs <scheme|ios-bundle-id|android-package>`. The helper reads the development app configuration, including personal-team overrides. For the full config, run `vp run --filter @t3tools/mobile config:dev`. Use the resolved values below instead of copied identifiers.
5. Find the actual generated Xcode workspace and scheme rather than assuming a historical name. If generated native projects are absent, first check for a compatible installed client or existing artifact.

`ios:dev` and `android:dev` run clean Expo prebuilds. Use them only when regeneration is required. If the user forbids a rebuild and no compatible client exists, report that blocker. Do not create or download simulator runtimes without permission.

## Start one isolated environment

Run backend commands from the repository root. Use the worktree-local `.akeru` or a deliberately created temporary home. Explicit homes store runtime state under `<home>/userdata`.

Use `vp run dev:status` to inspect an existing environment. Reuse a healthy owned server. When testing web and mobile together, run `vp run dev --home-dir <home>` once and connect both clients to that backend.

For a mobile-only backend:

```bash
node apps/server/src/bin.ts serve --host 127.0.0.1 --port <server-port> --base-dir <home> --no-browser
```

Run it in the background and retain its handle and output. Seed meaningful projects through `project add`, or use the visual fixture recipe in [SQLite fixtures](../test-t3-app/references/sqlite-fixtures.md). Offline writes require the backend to be stopped. `project add` can use a running ready server; never race its startup with offline mutation.

Use the complete HTTP origin:

- iOS Simulator: `http://127.0.0.1:<server-port>`.
- Android Emulator: `http://10.0.2.2:<server-port>`.
- A requested physical-device test: bind to a reachable interface and use the host's LAN origin.

## Start or reuse Metro

Run Metro from `apps/mobile`. Check the intended port and `/status`. Reuse it only when its owner, worktree, development variant, and scheme match this task. A healthy Metro from another worktree is not interchangeable.

Use `vp run dev:client`. For a different free port, retain the development identity:

```bash
APP_VARIANT=development vp exec expo start --dev-client --scheme <resolved-scheme> --clear --lan --port <metro-port>
```

On Windows, set `APP_VARIANT` through PowerShell before running the command. Open the exact printed development-client URL and confirm that the loaded bundle belongs to this worktree.

### iOS

Set XcodeBuildMCP session defaults to the selected simulator UDID, actual workspace/scheme when building, Debug configuration, and resolved bundle ID. For an installed client:

```bash
xcrun simctl get_app_container <udid> <resolved-bundle-id> app
xcrun simctl openurl <udid> <printed-dev-client-url>
```

Accept the launch prompt and dismiss a developer menu if it obscures the app.

### Android

```bash
adb -s <serial> shell pm path <resolved-package>
adb -s <serial> reverse tcp:<metro-port> tcp:<metro-port>
adb -s <serial> shell am start -W -a android.intent.action.VIEW -d '<printed-dev-client-url>' <resolved-package>
```

Track any port-forwarding rule you add. Leave devices and processes owned by other tasks alone.

## Pair once per client

Use the helper from the repository root. It resolves development identity and opens the existing Add Environment route:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh ios <udid> <server-port> <home>
.agents/skills/test-t3-mobile/scripts/pair-client.sh android <serial> <server-port> <home>
```

Run only the command for the selected device. A fifth argument overrides the URL scheme when explicitly testing another variant.

The route prefills the normal pairing form and submits once through development-only `autoConnect=1`. Without that flag it only prefills the form. Verify the intended projects appear after connection.

Use a fresh credential for each client and each failed attempt. Simulator keyboard input can corrupt token case and punctuation; use the helper instead. Test the manual form separately when pairing UI is the feature under test. Keep credentials out of screenshots and durable evidence.

## Drive and observe

On iOS, use current XcodeBuildMCP `snapshot_ui` element references. Refresh after navigation. Keep screenshots, semantic actions, and any simulator stream pinned to the same UDID.

On Android, prefer available semantic automation. Otherwise refresh `uiautomator dump` and use stable resource IDs, descriptions, or current bounds for scoped input. Capture evidence with `adb exec-out screencap -p`.

Exercise the affected flow and surrounding cases from the verification policy. Confirm the intended environment, not merely an empty screen. A deep link that bypasses a form proves connection behavior, not the form's typing and validation behavior.

## Diagnose and finish

- Old UI: confirm Metro's worktree, variant, URL, and port before changing app code.
- Connection failure: confirm the platform-specific origin and home, then mint a fresh token.
- Missing iOS references: refresh the snapshot and session defaults; report inaccessible controls rather than using guessed coordinates.
- Android bundle failure: check the exact Metro port and the forwarding rule.

Follow the shared retention policy while the user reviews. At final teardown, remove the disposable app connection and owned `adb reverse` rules, stop only owned processes, and remove only deliberately created temporary data. Preserve useful reproduction evidence.
