---
"akeru-bot": patch
---

Add an opt-in terminal latency recorder and live desktop measurement entry point. The recorder matches a printable keypress to the PTY output that echoes the same character within 250 ms and to the frame that renders it, skips keypresses whose echo is ambiguous, reports p50/p95/p99 values, and adds a documented procedure for local, remote, and tunnel collection. Instrumentation is removed from normal terminal hot paths when disabled.
