# Product feedback

> For maintainers. Using Akeru Bot? See [Product feedback](../user/product-feedback.md).

Product feedback uses a standalone Cloudflare Worker in `infra/feedback`. Static web clients cannot own the inbox, and each distributed Akeru Bot server belongs to one installation. The default central endpoint is `https://akeru-feedback.leoisadev.workers.dev/v1/feedback`. The `akeru-bot.com` zone is on Vercel DNS, so the Worker has no custom hostname; the contracts default points at the workers.dev URL and clients post to it directly with CORS. The Worker stores no Linear issue and exposes no public inbox route.

## Client boundary

The shared web store owns the editable draft. Help, Settings, the command palette, the desktop Help menu, and the Akeru Bot tool open the same composer. A network failure does not clear it. Only a validated success receipt clears it.

The element picker excludes feedback UI, form controls, editable content, and nodes marked private or sensitive. It produces only a bounded selector, component name, source name, role, and short label. It never reads values, HTML, attributes other than the named safe markers, styles, screenshots, files, workspace paths, or full URLs.

`akeru_product_feedback` is part of the Codex-backed Mastra tool catalog. Legacy Claude, Cursor, Grok, and OpenCode adapters do not receive this tool. Its schema accepts only feedback text. The tool returns a local draft acknowledgement. It does not call the central endpoint. Full-access and automatic modes use category policies instead of Mastra `yolo`, and the tool has an explicit per-tool `ask` policy. Its approval offers one-time **Add to feedback draft** and **Cancel** actions. It never offers session approval. The user must select **Send** in the composer after approval.

The server settings `productFeedbackEnabled` and `productFeedbackEndpoint` are enabled by default and server-authoritative. Endpoint validation accepts absolute HTTPS URLs. It accepts HTTP only for `localhost`, `127.0.0.0/8`, or `[::1]`.

Mobile shares the contracts and server settings but does not expose a product-feedback entry point in this first version. It shows Codex feedback requests as unsupported and allows only cancellation. Web and desktop own the element picker because it describes web DOM elements.

## Central endpoint

The Worker accepts a strict 16 KiB JSON body. Unknown properties fail decoding. Accepted fields and limits are defined in `packages/contracts/src/productFeedback.ts`. The body does not accept a thread or conversation.

Before storage, the Worker:

- Rejects a non-empty honeypot.
- Applies a 30-second installation cooldown and a five-second coarse-network burst cooldown.
- Blocks the same content from the same coarse network for 24 hours.
- Limits a coarse network to 20 accepted submissions per hour.
- Requires Turnstile only after five accepted submissions from the coarse network in one hour, and only when Turnstile keys are configured. Without keys the endpoint fails closed: the fifth submission in one hour from a coarse network is rejected as rate limited.
- Normalizes IPv4 to `/24` and IPv6 to `/64`.
- HMACs the rotating installation token, coarse IP, and content fingerprint.

The client keeps its installation token for 30 days. A successful send does not rotate it. The coarse-network cooldown and duplicate check still apply if a custom client changes that token.

D1 stores only the HMAC identifiers and the bounded safe payload. It does not store the raw installation token, raw IP, Turnstile token, or honeypot. A daily cron removes rows after 90 days. Submission returns a generated feedback ID and receipt time.

The Cloudflare deployment trusts only `CF-Connecting-IP`. A self-host adapter must pass the socket address from a trusted proxy. It must not trust an arbitrary `X-Forwarded-For` header.

## Operations and self-hosting

Deploy the Worker from `infra/feedback` with `vp run --filter akeru-feedback deploy`. `AKERU_FEEDBACK_HMAC_SECRET` is required; the Worker returns `503` until it holds at least 32 bytes. `AKERU_FEEDBACK_TURNSTILE_SITE_KEY` and `AKERU_FEEDBACK_TURNSTILE_SECRET_KEY` are optional and enable the challenge step. Alchemy state is local and gitignored because the Cloudflare state store bootstrap fails on the pinned alchemy version. The Worker and D1 names are pinned, so a checkout without state recovers the existing resources with `alchemy deploy --stage production --adopt`; a plain deploy without state fails instead of creating duplicates.

Maintainers inspect the inbox with authenticated local D1 tooling. Do not add a public listing route. A self-hosted Akeru Bot environment can replace the endpoint in **Settings → About**. Keep production endpoints on HTTPS.
