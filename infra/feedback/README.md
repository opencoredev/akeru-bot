# Akeru feedback Worker

This standalone Cloudflare Worker receives anonymous Akeru Bot product feedback. It uses D1 and has no dependency on the relay control plane.

Set these deployment values:

- `AKERU_FEEDBACK_HMAC_SECRET`: required HMAC secret.
- `AKERU_FEEDBACK_TURNSTILE_SITE_KEY`: required Turnstile site key.
- `AKERU_FEEDBACK_TURNSTILE_SECRET_KEY`: required Turnstile secret key.

Run the focused test with `vp test run infra/feedback/src/endpoint.test.ts`. Run the typecheck with `vp run --filter akeru-feedback typecheck`. Deploy only on direct request with `vp run --filter akeru-feedback deploy`.

The Worker binds `feedback.akeru.bot` and accepts `POST /v1/feedback`. Use authenticated D1 tooling to inspect rows in `akeru_feedback_inbox`. Do not add a public inbox route or create Linear issues from this Worker. A daily cron removes rows after 90 days.

Cloudflare supplies the trusted client address through `CF-Connecting-IP`. A self-host adapter must use a trusted proxy socket address and must not accept arbitrary `X-Forwarded-For` values.
