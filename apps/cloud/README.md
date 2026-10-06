# Akeru Cloud

The optional hosted service for Akeru Bot: environment linking and hosted Slack bots. It is a Cloudflare Worker with D1, one Durable Object per linked environment, and a small React app, all managed with Alchemy.

- Test: `vp test run` in this directory, or `vp test run apps/cloud` from the repository root.
- Typecheck: `vp run --filter @akeru/cloud typecheck`.
- Build the web app: `vp run build:web` in this directory.

The Alchemy stack and deploy scripts live in [`infra`](./infra), a separate package (`@akeru/cloud-infra`) because Alchemy needs a newer Effect than the Worker. Typecheck it with `vp run --filter @akeru/cloud-infra typecheck`. The `deploy`, `deploy:staging`, and `dev` scripts here build the SPA and then run the matching script there.

## Stages

- **production** deploys from CI on every push to `main` that touches the cloud or the contracts.
- **staging** is the developer's cloud, and it is public so real Slack apps can reach it. Deploy it from the root of any checkout on the dev machine with `vp run cloud:deploy:staging`. Akeru servers started with `vp run dev` use staging automatically.
- **local** runs with `vp run cloud:dev` from the root: the Worker, D1, the Durable Object, and the SPA in a local workerd at `http://localhost:1337`. Nothing is deployed. Only one checkout can run it at a time, because the port is fixed. Point a dev server at it with `AKERU_CLOUD_URL=http://localhost:1337 vp run dev`.

Secrets live in `~/.config/akeru-cloud/<stage>.env` (`staging.env`, `local.env`), shared by every checkout; see `.env.example` for the names. The Clerk keys are required on every stage. A gitignored `apps/cloud/.env` in a checkout overrides the machine file, and the shell fills in anything neither sets. Deploy scripts use the shared Cloudflare state store; `dev` keeps state in `infra/.alchemy`. Agents do not deploy unless asked.

Architecture, protocol, stored data, and the setup runbook are in [docs/internals/cloud.md](../../docs/internals/cloud.md).
