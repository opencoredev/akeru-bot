# Terminal runtime

> For maintainers. Using Akeru Bot? See [docs/user/terminal.md](../user/terminal.md).

The environment server owns terminal processes, retained output history, and
session lifecycle. Web, desktop, and mobile clients attach to the same
server-owned session over the environment RPC connection. The desktop renderer
does not own a separate PTY. Clients can reconnect to a running PTY or share
it with another client.

## Output path

PTY output follows this path:

```text
PTY callback
  -> ordered process-event drain
  -> bounded retained-history append
  -> live terminal output event
  -> coalesced history persistence
```

Live output events contain only the new PTY data. Full retained history is
materialized only when the server returns a snapshot or when the coalescing
persistence worker writes the latest state.

Retained history is limited to 5,000 lines and 8 MiB of UTF-8 text per terminal.
The server discards the oldest output when either limit is reached. A byte
cutoff can shorten the oldest retained line, but does not split a Unicode code
point. Live output is not truncated.

History uses small chunks with byte and newline counts. Appending output scans
the new text and any removed chunk prefix, not the full retained history.
Empty lines, incomplete final lines, and trailing newlines remain unchanged
within the limits. Split surrogate pairs are joined before byte eviction.

Discard each chunk's string reference as soon as it leaves retained history.
Array compaction can run later. Shared web and mobile client state retains at
most 512 KiB, so each client can display less scrollback than the server keeps.

Measure sustained-output changes against a full retained history so terminal
throughput does not regress unnoticed.

## Persistence

History persistence is keyed by terminal session and coalesces pending writes.
The worker reads the newest bounded-history state after its debounce instead
of receiving a newly materialized full string for every PTY callback. Clear,
restart, close, and final flush operations still force the latest state to
disk before their lifecycle boundary completes.

Restoration reads at most the last 8 MiB from current and legacy history files.
It skips an incomplete UTF-8 code point at the start and applies the line limit
before rewriting oversized files. File handles close before that rewrite.

## Input latency measurement

`apps/web/src/terminal/latency.ts` contains the repeatable percentile harness. A
live desktop pass supplies `TerminalLatencyProbe` hooks on the Ghostty surface:
keypress, PTY byte arrival, and glyph-frame scheduling are timestamped with
`performance.now()`. The harness reports keypress-to-glyph and byte-arrival-to-
glyph p50, p95, and p99 values. Headless tests cover the percentile math, but
cannot synthesize an operating-system keypress or a real PTY round trip; those
numbers must be collected on local desktop and at least one remote or tunnel
connection.

The first measurement commit's headless byte-arrival-to-render-scheduling
baseline was p50 0.00 ms and p95 0.01 ms. Keypress-to-glyph was not measurable
without a running desktop app. The probe is opt-in and the existing single-shot
`requestAnimationFrame` scheduler remains unchanged. Local echo is deliberately
not enabled from a headless result: without proving that PTY echo dominates,
predicting printable input would risk duplicate characters and would desync
application keypad, bracketed-paste, and alternate-screen programs.
