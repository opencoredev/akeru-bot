# Bot computer observation and control

LEO-248 owns this transport. LEO-292 may subscribe to ordered action receipts. LEO-399 owns checkpoint and replacement recovery and must not reuse these sessions as backups.

## Boundary

One `WorkspaceComputer` is attached to a persisted native workspace identity. Daytona is the first graphical adapter: its Computer Use desktop is the screen, and one Chromium instance on that display is the bot browser. Lightpanda remains for non-graphical workspaces. The client preview stack is not this computer.

Human frames, leases, and typed input are ephemeral. They are not written to orchestration, chat, routines, analytics, or checkpoints. Provider-visible screenshots still pass through `redactComputerScreenshot`. Action receipts sent to LEO-292 contain only `workspaceId`, `ordinal`, and `category`. They never include text, keys, coordinates, selectors, tokens, or frames.

## RPC

Clients use the authenticated environment WebSocket:

- `computer.getState` reports capability without opening a session
- `computer.open` / `computer.events` observe the current computer
- `computer.acquire` drains in-flight bot browser input, then returns a client-bound lease
- `computer.input` requires the next sequence on that lease
- `computer.release` returns control to the bot
- `computer.stop` revokes the workspace generation
- `computer.close` releases only that connection's lease

Provider credentials and raw CDP URLs stay server-side. Connection identity is per WebSocket, so two tabs of the same login cannot share a lease. Disconnect, expiry, adapter failure, workspace sleep, and stop invalidate outstanding input. Uncertain input is never replayed.

## Capability

| Workspace      | Graphical computer | Notes                                                                                                           |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Local          | No                 | Isolated bot computer viewer is unavailable. The macOS Computer Use plugin is a separate host-desktop path.     |
| Daytona        | Desktop adapter    | Native `computerUse` plus workspace Chromium. Live credentials are required before claiming a real desktop run. |
| E2B            | No                 | Generic sandboxes are not treated as desktops.                                                                  |
| Vercel Sandbox | No                 | No private desktop API is wired.                                                                                |
| Upstash Box    | No                 | The pinned SDK path does not provision the newer managed browser.                                               |
| Tenki          | No                 | No authenticated browser-control or graphical desktop endpoint is wired.                                        |

Codex, Claude, Grok, Kimi For Coding, and OpenCode Go register this computer through Mastra session resources. Standard OpenCode stays unavailable until it uses the same gated browser tools. Shell processes can still send desktop input outside the gate; that residual risk is documented rather than silently claimed exclusive. Unbrokered MCP browser credentials are withheld from the graphical computer.

Sleep, missing workspaces, and replacement recovery remain LEO-284 / LEO-399. Those flows must call `stop` on the shared computer and must not restore control leases from a checkpoint.

## Client lifecycle

`packages/client-runtime/src/state/computerViewer.ts` is a pure reducer over the server state, the local lease, the latest frame, and connection and visibility. `deriveComputerViewer` turns it into one phase and one owner (`bot`, `you`, `someone-else`, or `nobody`). The owner is derived from the lease and the server status, so a client never shows two owners at once. `explainComputerCapability` explains an unavailable computer from the bot's sandbox and engine instead of a generic error.

`computerViewerController.ts` owns the RPC order through a port the web client binds to atom commands:

- `show` reads state and opens the stream. `hide` calls `close`, which hands control back to the bot and keeps the computer running.
- Input goes through one serialized queue capped at 32 actions. Consecutive scrolls coalesce, and a full queue drops the oldest pointer move, or the new action when no move is queued. Sequence numbers are assigned only when an action is sent.
- A rejected input drops the local lease, releases it on the server, and re-reads state. The action is never replayed.
- The lease cannot be renewed. The client times it on its own clock from the grant, so skew with a remote server cannot end it early. Local expiry, disconnect, and a stopped or ended computer all read as stopped, matching the server gate.

The web client (`apps/web/src/components/computer/`) subscribes to `computer.events` only while the viewer is open, the page is visible, the environment is connected, and the computer is not stopped. It opens from the bot details panel and from pending human-input prompts in bot and group chats. Electron uses the same web surface. Mobile renders `ComputerDesktopNotice` while the computer is ready or human-controlled and does not stream frames.
