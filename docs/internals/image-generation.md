# Image generation providers

Akeru's Image generation settings manage two provider rows, ChatGPT and Grok. Each row reports detected access, health, supported operations, the last completed generation, last failure, a repair action, and an enabled flag. Bots create images through one image tool, backed by a single runtime, which routes to those providers independently of the bot's chat engine. On the Mastra controller (Codex, Claude, Grok, Kimi For Coding, OpenCode Go) the tool is the `GenerateImage` catalog entry; on the legacy bridge (standard OpenCode) it is the `generate_image` MCP tool.

## Credentials

Image providers reuse `SubscriptionAuthService`. ChatGPT maps to the `openai-codex` credential and Grok to `xai`. No second key store exists, and no subscription credential lives on a bot record. Access tokens reach the health test through `getAccessToken`, which refreshes OAuth credentials on demand.

## Health

Request health is recorded in `subscription-auth.json.health` under `image:chatgpt` and `image:grok` keys, kept separate from the chat-driver keys so an image failure cannot mark a chat provider unhealthy or vice versa. The health test (`imageProvider.healthTest`) performs one real request on the account path image requests use. ChatGPT is probed at the ChatGPT backend with the Codex sign-in and its account id, never the OpenAI API, because an API key does not qualify for ChatGPT images. Grok is probed with `GET /v1/models` on the xAI credential. A passing test or a completed generation are the only paths that move a provider to `healthy`; a connected credential reports `detected` until then. A completed generation also sets `lastGenerationAt` on the same health key. Disabling a provider reports `disabled`; disconnecting reports `missing`. Both reverse states are visible on the row.

## Settings

`ServerSettings.imageGeneration` holds `chatgptEnabled`, `grokEnabled`, `defaultProvider`, and `fallbackOrder`. The server normalizes every `server.updateSettings` patch touching that block: a disabled provider can never stay the default, and the fallback order drops disabled entries. Older settings files decode to all-disabled defaults.

## Bots

`OrchestrationBot.imageProvider` is a nullable `chatgpt | "grok"`. `null` means "use the global default" and is the decode default for bots written before the field existed. The selection is independent of the bot's chat engine, so a Claude bot may use ChatGPT images. It flows through `bot.create` / `bot.update`, the `bot.created` / `bot.updated` events, the `projection_bots.image_provider` column (migration 067), and the shell snapshot.

## RPC

- `imageProvider.list` (read scope) returns both rows.
- `imageProvider.healthTest` (operate scope) runs the real request and returns the refreshed rows.

Global enable/default/fallback changes go through `server.updateSettings`; connect/disconnect goes through the existing `subscriptionAuth` methods on `openai-codex` and `xai`.

## Clients

The row's `operations` come from the adapter capability tables, so a provider lists `edit` only when its adapter accepts input images.

Shared row logic lives in `@t3tools/client-runtime/image-generation`: the health badge (a row reads healthy only after `healthTest.status === "passed"`), toggle patches that keep the default and fallback order coherent with what the server normalizes, and fallback-order validation. Web renders the editable page at the `image-generation` settings section, which is also the `image-generation` deep-link id. Mobile maps that id to a read-only summary. The bot editor saves `imageProvider` through `bot.update`; the chat composer has no image controls.

## Request contract

`ImageGenerationRequest` in `packages/contracts/src/imageGeneration.ts` is the only tool input: `operation` (`generate` or `edit`), `prompt` (up to 4,000 characters), optional `inputImages` (one to four attachment ids from the calling chat), `aspectRatio`, `quality` (`standard` or `high`), `count` (one to four), `provider`, and `allowProvider`. `decodeImageGenerationRequest` decodes with `onExcessProperty: "error"`, so an unknown option fails as `invalid-request` instead of being dropped.

`ImageGenerationResult` is a union of `completed` (provider, optional model, artifacts, attempts), `failed` (a normalized kind, message, attempts), and `needs-consent` (the provider the images would go to). An `ImageArtifact` carries the attachment id, MIME type, width, height, byte size, provider, and model when the provider exposes it. Dimensions and MIME type come from sniffing the returned bytes, not from the provider's claims.

## Adapters

`apps/server/src/image-generation/adapters.ts` holds one adapter per provider. Each turns the neutral request into one documented, authenticated call and returns bytes plus model and usage metadata. Adapters never persist, log, or forward bytes or prompts.

- ChatGPT calls the Codex responses transport (`chatgpt.com/backend-api/codex/responses`) with the `image_generation` tool and `store: false`, using the `openai-codex` sign-in. It refuses to run on an OpenAI API key. Multiple images loop one request per image. It supports 1:1, 3:2, and 2:3 and up to four input images for edits.
- Grok calls `/v1/images/generations` and `/v1/images/edits` on the `xai` credential. Edits take one source image and return one image.

Adapter errors become `ImageAdapterFailure` with a kind: `unavailable`, `revoked` (rejected refresh, 401, 403), `provider-failed` (5xx, empty result), `invalid-request` (content refusal), `timeout`, or `cancelled` (aborted signal). Provider error bodies are not copied into messages.

## Routing

`router.ts` builds the plan. An explicit `provider` runs alone with no fallback. Otherwise the bot's `imageProvider` override or the global default goes first, followed by the rest of the fallback order. Disabled providers are skipped, and a provider whose subscription is missing or revoked is recorded as an attempt and skipped without a request.

Each attempt runs under a 150 second timeout (`IMAGE_REQUEST_TIMEOUT`) and aborts its `AbortSignal` on timeout or interruption. Only `unavailable`, `revoked`, `provider-failed`, and `timeout` move to the next candidate. `invalid-request` and `unsupported` stop the route. An unsupported combination for the intended provider, such as two input images for Grok, is rejected before any request.

When an edit carries input images and the route would move past the intended provider, the router returns `needs-consent` instead of sending the images. The model asks the user and retries with `allowProvider` set to the provider the user accepted. Consent is therefore mediated by the bot's own reply rather than a dedicated approval card.

## Runtime

`ImageGenerationRuntime` runs one tool call for a chat. It resolves the responding bot (the latest turn's responding bot, so group chats charge the bot that answered), reads input images from attachments in that chat only, routes the request, and writes each image into the existing attachment store with `createAttachmentId`. There is no second file store. It then posts one assistant message (`image-generation-<id>`) through `thread.message.assistant.delta` and `thread.message.assistant.complete` carrying the attachments and empty text. The projection persists that message like any other, so images survive reload and restart and render in direct and group chats on web and mobile through the normal attachment paths.

Usage goes through `BotUsageLedger.recordMeasurement` with category `tool` against the calling bot, using the provider's reported tokens or zero when none are reported. Provider health records success and failure under the `image:<provider>` keys.

`cancelThread` interrupts every in-flight request for the chat. `ProviderService.interruptTurn` calls `cancelActiveImageGenerations`, so stopping a turn aborts the provider request and posts nothing.

## Provider coverage

The runtime's entry is shared. Claude, Grok, and OpenCode reach it through the `generate_image` MCP tool on the Akeru MCP server. `ProviderService` grants the `image` MCP capability to a session when ChatGPT or Grok images are enabled, and the tool refuses calls without it. The call shows as a running tool call in the chat while it works.

Codex, Claude, Grok, Kimi For Coding, and OpenCode Go run on the Mastra controller. Their `GenerateImage` catalog tool calls `runImageGenerationTool`, the same runtime entry, so in-chat attachments, edits, needs-consent routing, usage recording, the per-attempt 150 second timeout with fallback to the next candidate, and cancel-on-stop all apply. The catalog handler adds no outer deadline of its own. The catalog entry is only listed when ChatGPT or Grok images are enabled, and the shared MCP `generate_image` tool is filtered out of Mastra connector tools so every provider family exposes exactly one image tool. Mastra image calls go through the catalog's `production` approval; legacy-bridge calls follow the provider's own tool permission setting, with the runtime's `needs-consent` routing on both families for edits that would move to a different provider.

## Privacy

Prompts and image bytes stay inside the runtime and the provider request. Orchestration events carry attachment metadata only, usage rows carry provider, model, and tokens, and logs carry the thread id. The tool result returned to the model lists artifact metadata, not bytes or the raw provider response. Nothing about the request reaches analytics, observational memory, entity memory, or product feedback.

## Attachment actions

The expanded image dialog in web and desktop offers open, save, copy, and reveal. Save and copy fetch the signed asset URL in the browser; copy re-encodes non-PNG images to PNG for the clipboard. Reveal calls `shell.revealAttachment` (operate scope) with only the attachment id. The server resolves the path with `resolveAttachmentPathById` and opens the file manager on the environment's machine, returning `AttachmentNotFoundError` for an unknown id. Clients never see server paths, and the button shows only when the server reports a file manager, so remote clients do not offer an action that cannot work.
