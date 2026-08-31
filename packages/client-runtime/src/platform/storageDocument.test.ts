import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget, SshConnectionTarget } from "../connection/model.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
describe("ConnectionCatalogDocument", () => {
  it("registers a bearer connection as one catalog mutation", () => {
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(document.targets).toEqual([BEARER_TARGET]);
    expect(document.profiles).toEqual([BEARER_PROFILE]);
    expect(document.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, BEARER_TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("persists the normalized SSH profile beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([]);
  });
});
