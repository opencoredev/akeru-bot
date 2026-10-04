# Akeru Bot

Akeru Bot is an open-source, self-hosted alternative to Grok Bot. It is an independent fork of [T3 Code](https://t3.codes). Thank you to the T3 Code team and contributors. Akeru Bot is not affiliated with [xAI](https://x.ai), Grok, or [ping.gg](https://ping.gg).

Run named Grok bots from your own desktop, server, or browser client. Akeru also connects to Claude, Codex, Kimi For Coding, and OpenCode. Conversations, bot profiles, settings, secrets, and logs live in `~/.akeru`. They do not share T3 Code's `~/.t3` database.

Do not push or publish this fork unless Leo asks.

## Run locally

Requires Node.js `^24.13.1` for contributor setup. To run the packaged server instead, see
[Install and first run](docs/user/install.md).

Install Vite+:

```bash
curl -fsSL https://vite.plus | bash
```

Then:

```bash
vp i
vp run dev
```

Development state defaults to `<worktree>/.akeru/userdata` in a linked worktree and
`~/.akeru/dev` in the main checkout. See [dev state directories](docs/internals/scripts.md#dev-state-directories)
for explicit-home and environment precedence. The installed T3 Code app keeps using `~/.t3`.

## License

[MIT](./LICENSE). Third-party terms are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
