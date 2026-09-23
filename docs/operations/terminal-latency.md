# Terminal latency measurement

Use this procedure for LEO-186. It requires a development web build and a
running Akeru environment server. The measurement flag is ignored in production
builds.

1. Start the app using the normal isolated development workflow. Do not set
   `VITE_HTTP_URL` or `VITE_WS_URL`.
2. Open the terminal in the desktop client, or in a local browser connected to
   the environment server, with `?terminalLatency=1` appended to the URL. The
   terminal drawer logs that measurement is enabled.
3. Type at least 100 printable keys at a steady pace, including a burst of 10
   keys. Wait for the prompt to settle, then run
   `window.__akeruTerminalLatencyReport()` in DevTools. Save the console output.
4. Record the `keypress-to-glyph` and `byte-arrival-to-glyph` p50 and p95 values.
   D8 requires local desktop p50 <16 ms and p95 <33 ms for keypress-to-glyph.
5. Repeat with a remote environment over the supported relay connection, and
   once through the team tunnel. Record both reports and the connection mode.
6. If the local PTY round trip dominates, investigate local echo only for plain
   input. Re-run the same procedure with application keypad, bracketed paste,
   and alternate-screen programs to verify echo is disabled in each mode.

The same opt-in can be enabled without changing the URL by setting
`localStorage.setItem("akeru:terminal-latency", "1")` in DevTools and reopening
the terminal. Clear it with `localStorage.removeItem("akeru:terminal-latency")`.
The report hook is `window.__akeruTerminalLatencyReport`; it returns the latest
report and logs it to the console.
