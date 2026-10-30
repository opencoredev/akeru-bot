import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ServerSecretStore } from "../../auth/ServerSecretStore.ts";

export function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();

  const store: ServerSecretStore["Service"] = {
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(bytes);
        values.set(name, value);

        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };

  return { store, values };
}
