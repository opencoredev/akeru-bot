# Plugin catalog

- This is a curated directory, not a complete MCP registry. A valid manifest does not guarantee acceptance.
- Use Custom MCP for experimental apps, wrappers, duplicates, and narrow utilities.
- Admit a plugin only when people actively use the product and a user or maintainer requested the integration.
- Require a real Akeru Bot job, an official or trusted MCP server, and an accountable publisher.
- Require current setup and reference documentation, official logo provenance, and licensing.
- Test add, connect, use, disable, re-enable, and remove behavior before acceptance.
- Keep PostgreSQL, SQLite, Redis, Docker, Playwright, time, fetch, filesystem, and generic memory servers in Custom MCP.
- Keep one plugin in each `entries/<id>/` directory.
- Each directory contains `plugin.json`, `logo.svg`, and `logo-dark.svg`. Do not add generated catalog files.
- Preserve an existing plugin `id`. Its MCP server ID remains `builtin-<id>`.
- Record the current publisher, documentation, logo source, license, and connection health. A valid manifest does not guarantee directory acceptance.
- Mark a plugin `available` only after its real add, connect, use, disable, re-enable, and remove lifecycle passes in Akeru Bot.
- Use `verification-pending` when a connection recipe exists but the real lifecycle has not passed.
- Use `approval-pending` with an explicit blocker when a vendor must approve access.
- Keep tokens and secrets in the host environment or service sign-in flow. Never put them in a manifest or ask an MCP server to export a provider token or secret.
- Declare an approval for every applicable send, pay, delete, production, secrets, publishing, signatures, refunds, and account-wide action.
- Run `bun run plugins:check` and the focused catalog tests after each entry change.
