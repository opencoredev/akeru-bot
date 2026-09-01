# Plugin directory

This is a curated directory, not a complete MCP registry. A valid manifest passes the file contract. It does not guarantee acceptance.

Use Custom MCP for experimental apps, wrappers, duplicates, and narrow utilities. This includes PostgreSQL, SQLite, Redis, Docker, Playwright, time, fetch, filesystem, and generic memory servers. Users can install those servers without a directory entry.

## Admission

A proposal must provide evidence for every item:

- People actively use the product, and a user or maintainer requested the integration.
- The plugin completes a real Akeru Bot job. A list of generic MCP tools is not enough.
- The plugin uses an official or trusted MCP server with a maintained source and accountable publisher.
- A maintainer can test add, connect, use, disable, re-enable, and remove behavior.
- `logo.svg` and `logo-dark.svg` come from an official source. Record the source URL and license.
- Setup and reference documentation is current.
- The publisher and maintainer have public names and URLs.

Describe health honestly. Use `available` only after the real connection lifecycle passes. Use `verification-pending` when a connection recipe exists but the real lifecycle has not passed. Use `approval-pending` with a concrete blocker when a vendor must approve Akeru Bot. Keep a verified official URL or local loopback recipe visible when one exists. Use an `unavailable` transport only when no trusted recipe exists. Use `deprecated` when an existing entry should remain visible but should not receive new installs.

The catalog stores no token or secret. Credentials stay in the host environment or the service sign-in flow. An MCP server must not require Akeru Bot to export a provider token or secret.

Declare an approval for each permission that can send, pay, delete, change production, access secrets, publish, create a signature, issue a refund, or change account-wide settings. Read-only actions use `read`.

## Add an entry

1. Open a [Plugin proposal](https://github.com/opencoredev/akeru-bot/issues/new?template=plugin_proposal.yml) and attach the admission evidence. Use the [Provider proposal](https://github.com/opencoredev/akeru-bot/issues/new?template=provider_proposal.yml) for an agent runtime.
2. Wait for a maintainer to confirm that the plugin fits the directory.
3. Add one `entries/<id>/` directory with `plugin.json`, `logo.svg`, and `logo-dark.svg`.
4. Run the validator and focused tests.

The loader preserves the manifest ID as `builtin-<id>` and orders featured entries by `featuredRank`.

Run the catalog validator before review:

```sh
bun run plugins:check
```
