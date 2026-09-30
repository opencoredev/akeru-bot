import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { SubscriptionAuthService } from "../service.ts";

/** Run a credential-store effect on the real filesystem, for promise-based tests. */
export const runWithNodeServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

/** `SubscriptionAuthService.make` on the real filesystem, for promise-based tests. */
export const makeTestSubscriptionAuthService = (
  authPath: string,
  options?: Parameters<typeof SubscriptionAuthService.make>[1],
) => runWithNodeServices(SubscriptionAuthService.make(authPath, options));

/** `SubscriptionAuthService.forSecretsDir` on the real filesystem, for promise-based tests. */
export const testSubscriptionAuthServiceForSecretsDir = (secretsDir: string) =>
  runWithNodeServices(SubscriptionAuthService.forSecretsDir(secretsDir));
