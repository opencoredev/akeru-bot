---
name: ios-simulator-browser
description: Stream an explicit iOS Simulator through pinned serve-sim into the T3 Code in-app browser or another agent browser. Use on Apple Silicon macOS when the user should watch simulator verification live or when browser-visible simulator evidence is needed.
---

# iOS Simulator Browser

Use serve-sim as the shared visual feed for an iOS Simulator. Use `ios-debugger-agent` and XcodeBuildMCP semantic UI tools to drive the app; do not treat browser-canvas coordinates as a substitute for missing app accessibility.

## Confirm availability

serve-sim `0.1.45` requires Apple Silicon macOS, Xcode command-line tools, and Node.js 20 or newer. If the host is unsupported, continue with XcodeBuildMCP screenshots and report that live streaming was unavailable.

When running inside T3 Code, use its product-native browser MCP to open the stream. Other agent hosts may use their own browser or preview surface.

Keep serve-sim on its default `127.0.0.1` binding. Do not expose its preview to a LAN or tunnel unless the user explicitly requests that access and the network is trusted; the preview includes a token-gated shell-execution route.

## Start one owned stream

1. Obtain the exact simulator UDID from the iOS build or launch workflow.
2. Check whether an existing serve-sim stream for that UDID belongs to another task. Reuse it only when explicitly shared; never kill another task's stream.
3. Otherwise, start the pinned version as an owned background task and retain its handle. If another stream owns the device, report the conflict instead of terminating it:

   ```bash
   npx --yes serve-sim@0.1.45 <simulator-udid>
   ```

4. Keep the terminal alive and open the exact local URL printed by serve-sim in the agent's browser.
5. Verify that a live simulator frame renders. A loaded wrapper page is not sufficient evidence.

## Observe while driving semantically

- Let the user watch the serve-sim stream while XcodeBuildMCP performs `snapshot_ui`, semantic taps, typing, gestures, and screenshots.
- Keep the browser and Xcode tooling pinned to the same simulator UDID.
- Do not switch to generic desktop automation or browser-canvas clicking merely because the stream is visible.

If the in-app browser explicitly reports that previews are unavailable, do not install unrelated browser automation. Continue through XcodeBuildMCP, capture a simulator screenshot, report the unavailable live stream, and clean up the owned serve-sim process.

## Finish

Retain the owned stream during human review according to [the verification policy](../../../docs/internals/verification.md). At final teardown, stop its captured background task. If a stream remains, verify that it is still the one owned by this task before running `npx --yes serve-sim@0.1.45 --kill <simulator-udid>`. Never run an unscoped `--kill`.

## Upstream

Adapted from OpenAI's [`build-ios-apps`](https://github.com/openai/plugins/tree/main/plugins/build-ios-apps) plugin version `0.1.2` (`ios-simulator-browser`, MIT). It invokes serve-sim `0.1.45` under its Apache-2.0 license without vendoring the package.
