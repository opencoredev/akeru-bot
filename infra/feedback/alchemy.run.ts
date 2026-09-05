import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as State from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { FeedbackDatabase } from "./src/database.ts";

// akeru-bot.com is served by Vercel DNS, so this Worker has no custom hostname.
// Clients post straight to the workers.dev URL recorded in the contracts default.
export const FeedbackWorker = Cloudflare.Worker("FeedbackWorker", {
  name: "akeru-feedback",
  main: new URL("./src/worker.ts", import.meta.url).pathname,
  compatibility: {
    date: "2026-08-30",
    flags: ["nodejs_compat"],
  },
  crons: ["0 3 * * *"],
  env: {
    DB: FeedbackDatabase,
    HMAC_SECRET: Config.redacted("AKERU_FEEDBACK_HMAC_SECRET"),
    TURNSTILE_SITE_KEY: Config.string("AKERU_FEEDBACK_TURNSTILE_SITE_KEY").pipe(
      Config.withDefault(""),
    ),
    TURNSTILE_SECRET_KEY: Config.redacted("AKERU_FEEDBACK_TURNSTILE_SECRET_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    ),
  },
  observability: {
    enabled: true,
    headSamplingRate: 1,
  },
});

export type FeedbackWorkerEnv = Cloudflare.InferEnv<typeof FeedbackWorker>;

// State lives in the gitignored .alchemy directory. Deploy from the machine
// that holds it; a fresh checkout must copy that directory first.
export default Alchemy.Stack(
  "AkeruFeedback",
  {
    providers: Cloudflare.providers(),
    state: State.localState(),
  },
  Effect.gen(function* () {
    const database = yield* FeedbackDatabase;
    const worker = yield* FeedbackWorker;
    return {
      databaseName: database.databaseName,
      workerName: worker.workerName,
      url: worker.url,
    };
  }),
);
