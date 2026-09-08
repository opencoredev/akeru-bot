# Local verification

Use this policy with the repository's web/desktop and mobile testing skills. The policy owns authorization, coverage, evidence, and process lifetime; the skills own launch and control steps.

## Authorization

A request to implement or fix a change includes permission to run focused local tests and verify the affected client in an isolated environment. Use background browser automation or an available simulator. Ask first before controlling the user's live desktop session, using a physical device, downloading runtimes, or changing external state. An explicit request to avoid a browser, simulator, or build takes precedence; report the resulting verification limit.

## Choose the proof

Before editing, identify the affected entry points, clients, providers, contracts, reverse actions, and connection modes using the checklist in `AGENTS.md`. Mark unrelated cases as not applicable rather than running every possible combination.

- Add a focused regression test for each testable behavior change. Run it and targeted lint/type checks.
- For visible or interactive changes, exercise the affected flow end to end in a real client after integrating changes. The primary agent owns this pass; subagents do not launch separate environments.
- Visit routes that share the changed state or components. Check the reverse action, relevant empty/error states, and existing surrounding behavior.
- Check persistence after reload or reconnect when state is meant to survive it. For synchronization changes, check another client against the same environment.
- Check desktop and mobile viewport sizes when web layout changes. Run native mobile verification for React Native changes; a narrow web viewport is not a mobile client.
- Run Electron for shell, IPC, native menu, protocol, preload, packaged-origin, startup, or lifecycle changes. Web verification covers shared renderer behavior only.
- Keep provider calls bounded. Use fixtures or test adapters when they prove the change; do not invoke every paid provider merely because the checklist names them.
- Wait on receipts and worker drains in server tests. Use observable UI state for client transitions, not fixed sleeps as proof of completion.

An empty disconnected screen, an HTTP success, a passing unit test, and a screenshot each prove different things. None alone proves an interactive feature works.

## Data

Use deterministic projection fixtures for visual states and safe snapshots of real data for data-specific defects. Direct projection writes do not prove command handling or event history. Exercise business behavior through application commands or APIs. Keep one server owner per home and stop it before fixture writes.

## Environment lifetime

Retain the owned environment, authenticated client, and useful fixtures while the user is reviewing or iterating. Reuse them on later turns after confirming ownership and health. This applies to web, desktop, Metro, and simulator streams alike.

Tear down when the user requests it or the task is finished without pending human review. Stop only captured process handles or owned process groups. Leave pre-existing apps, devices, and servers alone. Remove test connections and port forwarding before removing their environment. Delete only directories created for this test; preserve reproduction evidence when useful.

## Evidence

Keep a small verification record outside tracked source files. Record:

- The revision or local changes tested, client, home, and relevant device or viewport.
- Each action, expected result, and observed result.
- Focused test commands and outcomes.
- Relevant screenshots or video, with credentials excluded.
- Cases not tested and the reason.
- Retained environment ownership and safe teardown details, when applicable.

In the final response, summarize what passed and what remains unverified. For a simple task, a short test summary is enough. Tool failures are blockers to the affected proof, not successful verification.
