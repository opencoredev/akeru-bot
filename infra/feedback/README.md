# Akeru feedback Worker

This standalone Cloudflare Worker receives anonymous Akeru Bot product feedback. It uses D1 and has no dependency on the relay control plane.

Set these deployment values:

- `AKERU_FEEDBACK_HMAC_SECRET`: required HMAC secret.
- `AKERU_FEEDBACK_TURNSTILE_SITE_KEY`: optional Turnstile site key.
- `AKERU_FEEDBACK_TURNSTILE_SECRET_KEY`: optional Turnstile secret key. Both keys together enable the challenge step; without them the endpoint rejects further submissions from a coarse network after five accepted submissions in one hour.
- `AKERU_FEEDBACK_GITHUB_REPOSITORY`: `owner/repository` that receives accepted reports as issues. Defaults to `opencoredev/akeru-bot`.
- `AKERU_FEEDBACK_GITHUB_APP_ID`: ID of the GitHub App that delivers feedback.
- `AKERU_FEEDBACK_GITHUB_APP_INSTALLATION_ID`: repository-scoped installation ID for the App.
- `AKERU_FEEDBACK_GITHUB_APP_PRIVATE_KEY`: private key for minting short-lived installation tokens. Store it only as a Worker secret.

Run the focused test with `vp test run infra/feedback/src/endpoint.test.ts`. Run the typecheck with `vp run --filter akeru-feedback typecheck`. Deploy only on direct request with `vp run --filter akeru-feedback deploy`.

The Worker is named `akeru-feedback`, has no custom hostname, and accepts `POST /v1/feedback` at `https://akeru-feedback.leoisadev.workers.dev`. Alchemy state is local and gitignored. The Worker and D1 names are pinned; from a checkout without state, run `alchemy deploy --stage production --adopt` to take over the existing resources. Use authenticated D1 tooling to inspect rows in `akeru_feedback_inbox`. Do not add a public inbox route or create Linear issues from this Worker. When GitHub delivery is configured, accepted reports become normal GitHub issues authored by the installed GitHub App. The Worker signs a ten-minute App JWT only long enough to mint a repository-scoped, one-hour installation token for each delivery attempt. Confirmed HTTP failures retry from the D1 outbox; migrated reports are ineligible for public delivery, expired reports are removed before draining, and unique claim IDs plus bounded GitHub requests prevent stale attempts from owning another attempt's result. Ambiguous `unknown` deliveries remain quarantined from automatic retries, emit daily structured errors while retained, and must be reconciled using `docs/internals/product-feedback.md` before the normal 90-day cleanup removes them.

Cloudflare supplies the trusted client address through `CF-Connecting-IP`. A self-host adapter must use a trusted proxy socket address and must not accept arbitrary `X-Forwarded-For` values.
