# Terminal latency measurement (retired)

Akeru Bot no longer has a user terminal or server PTY sessions. The terminal drawer,
latency measurement flag, and `window.__akeruTerminalLatencyReport()` hook are no longer
available. The former measurement procedure does not apply to current builds.

The surviving Ghostty renderer is used only for the local Settings font preview. See
[font preview renderer](../internals/font-preview-renderer.md) for its architecture and build instructions.
