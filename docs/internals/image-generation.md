# Image generation providers

Akeru's Image generation settings manage two provider rows, ChatGPT and Grok. Each row reports detected access, health, supported operations, last failure, a repair action, and an enabled flag. The generation tool itself ships separately (milestone decision D5); until then `lastGenerationAt` has no producer and clients render it as "No images generated yet".

## Credentials

Image providers reuse `SubscriptionAuthService` — ChatGPT maps to the `openai-codex` credential and Grok to `xai`. No second key store exists, and no subscription credential lives on a bot record. Access tokens reach the health test through `getAccessToken`, which refreshes OAuth credentials on demand.

## Health

Request health is recorded in `subscription-auth.json.health` under `image:chatgpt` and `image:grok` keys, kept separate from the chat-driver keys so an image failure cannot mark a chat provider unhealthy or vice versa. The health test (`imageProvider.healthTest`) performs one real request (`GET /v1/models` with the access token). It is the only path that moves a provider to `healthy`; a connected credential reports `detected` until a request succeeds. Disabling a provider reports `disabled`; disconnecting reports `missing`. Both reverse states are visible on the row.

## Settings

`ServerSettings.imageGeneration` holds `chatgptEnabled`, `grokEnabled`, `defaultProvider`, and `fallbackOrder`. The server normalizes every `server.updateSettings` patch touching that block: a disabled provider can never stay the default, and the fallback order drops disabled entries. Older settings files decode to all-disabled defaults.

## Bots

`OrchestrationBot.imageProvider` is a nullable `chatgpt | "grok"`. `null` means "use the global default" and is the decode default for bots written before the field existed. The selection is independent of the bot's chat engine — a Claude bot may use ChatGPT images. It flows through `bot.create` / `bot.update`, the `bot.created` / `bot.updated` events, the `projection_bots.image_provider` column (migration 067), and the shell snapshot.

## RPC

- `imageProvider.list` (read scope) returns both rows.
- `imageProvider.healthTest` (operate scope) runs the real request and returns the refreshed rows.

Global enable/default/fallback changes go through `server.updateSettings`; connect/disconnect goes through the existing `subscriptionAuth` methods on `openai-codex` and `xai`.

## Clients

Shared row logic lives in `@t3tools/client-runtime/image-generation`: the health badge (a row reads healthy only after `healthTest.status === "passed"`), toggle patches that keep the default and fallback order coherent with what the server normalizes, and fallback-order validation. Web renders the editable page at the `image-generation` settings section, which is also the `image-generation` deep-link id. Mobile maps that id to a read-only summary. The bot editor saves `imageProvider` through `bot.update`; the chat composer has no image controls.
