---
"akeru-bot": patch
---

Add an opt-in terminal latency recorder and live desktop measurement entry point. The recorder correlates every keypress with its first following PTY byte and rendered frame, reports p50/p95/p99 values, and adds a documented procedure for local, remote, and tunnel collection. Instrumentation is removed from normal terminal hot paths when disabled.
