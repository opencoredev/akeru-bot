import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { BearerConnectionTarget } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as ConnectionResolver from "./resolver.ts";

const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-bearer"),
  label: "Bearer environment",
  connectionId: "bearer-connection",
});

const profile = new BearerConnectionProfile({
  connectionId: target.connectionId,
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const dependencies = Layer.mergeAll(
  ConnectionCredentialStore.layer({
    get: () => Effect.succeed(Option.some(new BearerConnectionCredential({ token: "secret" }))),
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
  ConnectionProfileStore.layer({
    get: () => Effect.succeed(Option.some(profile)),
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
  Layer.succeed(
    ClientCapabilities.PrimaryEnvironmentAuth,
    ClientCapabilities.PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeed(Option.none()) }),
  ),
  Layer.succeed(
    ClientCapabilities.ClientPresentation,
    ClientCapabilities.ClientPresentation.of({ metadata: {}, scopes: [] }),
  ),
  Layer.succeed(
    ClientCapabilities.SshEnvironmentGateway,
    ClientCapabilities.SshEnvironmentGateway.of({
      provision: () => Effect.die("unused"),
      prepare: () => Effect.die("unused"),
      disconnect: () => Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
      authorizeBearer: (input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
          httpAuthorization: { _tag: "Bearer", token: input.bearerToken },
        }),
    }),
  ),
);

it.effect("prepares a saved bearer connection", () =>
  Effect.gen(function* () {
    const resolver = yield* ConnectionResolver.ConnectionResolver;
    const prepared = yield* resolver.prepare({ target, profile: Option.some(profile) });

    expect(prepared).toEqual({
      environmentId: target.environmentId,
      label: "Authorized environment",
      httpBaseUrl: profile.httpBaseUrl,
      socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
      httpAuthorization: { _tag: "Bearer", token: "secret" },
      target,
    });
  }).pipe(Effect.provide(ConnectionResolver.layer.pipe(Layer.provide(dependencies)))),
);
