import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as State from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { CloudWorkerEnv } from "../src/env.ts";
import type { EnvironmentHubRpc } from "../src/modules/environments/hubRpc.ts";

// Production keeps the bare names so the contracts default URL stays valid.
// Other stages get a suffix. Names are pinned so a checkout without state can
// recover existing resources with `alchemy deploy --stage <stage> --adopt`.
const resourceName = (stage: string) =>
  stage === "production" ? "akeru-cloud" : `akeru-cloud-${stage}`;

// `alchemy dev` serves the Worker here. The port is strict because the public
// URL below, link URLs, and Clerk's authorized party all depend on it.
const LOCAL_DEV_PORT = 1337;

// Production resolves to DEFAULT_AKERU_CLOUD_URL in @akeru/contracts. The
// contracts are not imported here because they load a different Effect version.
const defaultPublicUrl = (stage: string) =>
  stage === "local"
    ? `http://localhost:${LOCAL_DEV_PORT}`
    : `https://${resourceName(stage)}.leoisadev.workers.dev`;

// CI passes unset GitHub variables as empty strings, so empty means "use the default".
const stringOr = (name: string, fallback: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value || fallback),
  );

export const cloudResources = (stage: string) => {
  const database = Cloudflare.D1.Database("CloudDatabase", {
    name: resourceName(stage),
    migrations: new URL("../migrations", import.meta.url).pathname,
    primaryLocationHint: "enam",
  });

  const worker = Cloudflare.Worker("CloudWorker", {
    name: resourceName(stage),
    main: new URL("../src/worker.ts", import.meta.url).pathname,
    compatibility: {
      date: "2026-09-14",
      flags: ["nodejs_compat"],
    },
    // The SPA is served by the asset layer. API, protocol, and channel paths
    // always reach the Worker first.
    assets: {
      directory: new URL("../dist/web", import.meta.url).pathname,
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/v1/*", "/api/*"],
    },
    crons: ["0 4 * * *"],
    dev: { port: LOCAL_DEV_PORT, strictPort: true },
    env: {
      DB: database,
      // Alchemy declares new Durable Object classes as SQLite-backed
      // (`new_sqlite_classes`), which the Workers Free plan supports.
      HUB: Cloudflare.DurableObject<EnvironmentHubRpc>("EnvironmentHub"),
      // Required on every stage, including `local`. Empty values fail the deploy.
      CLERK_SECRET_KEY: Config.schema(Schema.Redacted(Schema.NonEmptyString), "CLERK_SECRET_KEY"),
      CLERK_PUBLISHABLE_KEY: Config.NonEmptyString("CLERK_PUBLISHABLE_KEY"),
      SLACK_MANAGER_CLIENT_ID: stringOr("SLACK_MANAGER_CLIENT_ID", ""),
      SLACK_MANAGER_CLIENT_SECRET: Config.Redacted("SLACK_MANAGER_CLIENT_SECRET").pipe(
        Config.withDefault(Redacted.make("")),
      ),
      POSTHOG_KEY: stringOr("POSTHOG_KEY", ""),
      POSTHOG_HOST: stringOr("POSTHOG_HOST", "https://us.i.posthog.com"),
      CLOUD_PUBLIC_URL: stringOr("CLOUD_PUBLIC_URL", defaultPublicUrl(stage)),
      KILL_SWITCH: stringOr("KILL_SWITCH", ""),
    },
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
  });

  return { database, worker };
};

// The Worker declares its bindings in src/env.ts so it never imports Alchemy.
// This check fails the infra typecheck when the two drift apart. The Worker
// never reads ASSETS, so src/env.ts leaves it out. HUB differs only by the
// Durable Object brand workers-types requires, so it is compared by name only.
type InferredEnv = Omit<Cloudflare.InferEnv<ReturnType<typeof cloudResources>["worker"]>, "ASSETS">;

type ComparedKeys = Exclude<keyof CloudWorkerEnv, "HUB">;

type EnvMatches = [
  keyof InferredEnv,
  Pick<InferredEnv, ComparedKeys>,
  Pick<CloudWorkerEnv, ComparedKeys>,
] extends [
  keyof CloudWorkerEnv,
  Pick<CloudWorkerEnv, ComparedKeys>,
  Pick<InferredEnv, ComparedKeys>,
]
  ? [keyof CloudWorkerEnv] extends [keyof InferredEnv]
    ? true
    : false
  : false;

true satisfies EnvMatches;

// Local state is the default, used by `alchemy dev`. Deploys set
// ALCHEMY_STATE=cloudflare (CI and the `deploy` scripts) so every machine shares
// the account's Cloudflare state store.
const useCloudflareState = process.env.ALCHEMY_STATE === "cloudflare";

export default Alchemy.Stack(
  "AkeruCloud",
  {
    providers: Cloudflare.providers(),
    state: useCloudflareState ? Cloudflare.state() : State.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const resources = cloudResources(stage);
    const database = yield* resources.database;
    const worker = yield* resources.worker;

    return {
      databaseName: database.databaseName,
      workerName: worker.workerName,
      url: worker.url,
    };
  }),
);
