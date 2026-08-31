# Plugin catalog

- Keep one plugin in each `entries/<id>/` directory.
- Each directory contains `plugin.json`, `logo.svg`, and `logo-dark.svg`. Do not add generated catalog files.
- Preserve an existing plugin `id`. Its MCP server ID remains `builtin-<id>`.
- Mark a plugin `available` only after its real connection lifecycle passes.
- Use `approval-pending` with an explicit blocker when a vendor must approve access.
- Declare an approval for send, pay, delete, production, secrets, publishing, signatures, refunds, and account-wide changes.
- Run `bun run plugins:check` and the focused catalog tests after each entry change.
