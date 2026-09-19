# Akeru Bot

Akeru Bot is an open-source, self-hosted alternative to Grok Bot. It is an independent fork of [T3 Code](https://t3.codes). Thank you to the T3 Code team and contributors. Akeru Bot is not affiliated with [xAI](https://x.ai), Grok, or [ping.gg](https://ping.gg).

Run named Grok bots from your own desktop, server, or browser client. Akeru also connects to Claude, Codex, Kimi For Coding, and OpenCode. Conversations, bot profiles, settings, secrets, and logs live in `~/.akeru`. They do not share T3 Code's `~/.t3` database.

Do not push or publish this fork unless Leo asks.

## Run locally

Requires Node.js 22.16+, 23.11+, or 24.10+.

Install Vite+:

```bash
curl -fsSL https://vite.plus | bash
```

Then:

```bash
vp i
vp run dev
```

Checkout state is `.akeru/` in this tree. The installed T3 Code app keeps using `~/.t3`.

## License

[MIT](./LICENSE). Third-party terms are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
