# Akeru Bot docs

## Using Akeru Bot

- [Install and first run](./user/install.md)
- [Configure bots](./user/bots.md)
- [Bot channels](./user/channels.md)
- [Image generation](./user/image-generation.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md)
- [Provider access and limits](./user/provider-access.md)
- [Permission modes](./user/permission-modes.md)
- [Configure sandboxes](./user/sandboxes.md)
- [Watch and control a bot's computer](./user/computer.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing chats](./user/chats.md)
- [When a bot goes quiet](./user/silence-watchdog.md)
- [Bot memory](./user/memory.md)
- [Sending product feedback](./user/product-feedback.md)
- [Plugins](./user/plugins.md)
- [Privacy and outbound data](./user/privacy.md)
- [Review usage](./user/usage.md)
- [Anonymous usage analytics](./user/analytics.md)
- [Mobile appearance](./user/mobile-appearance.md)
- [App language](./user/language.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Background service](./user/background-service.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on Akeru Bot

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Local verification](./internals/verification.md)
- [Interface translations](./internals/interface-translations.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Delegation threads](./internals/delegation.md)
- [Silence watchdog](./internals/silence-watchdog.md)
- [Memory architecture](./internals/memory.md)
- [External channels](./internals/channels.md)
- [Plugin lifecycle verification](./internals/plugin-lifecycle-verification.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Usage analytics](./internals/usage-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [CI gates](./internals/ci.md)
- [Engineering work artifacts](./internals/work-artifacts.md)

### Runbooks

- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Provider model routing](./operations/provider-model-routing.md)
- [Kimi Mastra verification](./operations/kimi-mastra-verification.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
