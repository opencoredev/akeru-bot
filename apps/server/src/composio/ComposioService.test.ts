import { Composio } from "@composio/core";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { toClaudeMcpServers } from "../provider/McpServerConfig.ts";
import { make } from "./ComposioService.ts";

function makeSecretStore(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(
    Object.entries(initial).map(([name, value]) => [name, new TextEncoder().encode(value)]),
  );
  const store = {
    get: (name: string) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => void values.set(name, new Uint8Array(value))),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => void values.set(name, new Uint8Array(value))),
    getOrCreateRandom: (name: string, bytes: number) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        values.set(name, value);
        return value;
      }),
    remove: (name: string) => Effect.sync(() => void values.delete(name)),
  } satisfies ServerSecretStore["Service"];
  return { store, values };
}

function fakeClient(input?: {
  readonly accounts?: ReadonlyArray<{
    readonly id: string;
    readonly toolkit: { readonly slug: string };
    readonly status: "ACTIVE" | "FAILED";
    readonly alias?: string | null;
  }>;
}) {
  const createSession = vi.fn(async () => ({
    mcp: {
      url: "https://app.composio.dev/tool_router/v3/session/mcp",
      headers: { "x-api-key": "project-key" },
    },
    authorize: vi.fn(async () => ({
      id: "connection-new",
      redirectUrl: "https://connect.composio.dev/link",
    })),
  }));
  const client = {
    toolkits: { get: vi.fn(async () => []) },
    connectedAccounts: {
      list: vi.fn(async () => ({ items: input?.accounts ?? [], totalPages: 1 })),
      delete: vi.fn(async () => ({})),
    },
    sessions: { create: createSession },
  } as unknown as InstanceType<typeof Composio>;
  return { client, createSession };
}

describe("ComposioService", () => {
  it.effect("validates a key before storing it", () =>
    Effect.gen(function* () {
      const { store, values } = makeSecretStore();
      const { client } = fakeClient();
      const service = make(store, () => client);

      expect(yield* service.configure(" project-key ")).toEqual({
        configured: true,
        connections: [],
      });
      expect(new TextDecoder().decode(values.get("composio-api-key"))).toBe("project-key");
    }),
  );

  it.effect("does not store an invalid key", () =>
    Effect.gen(function* () {
      const { store, values } = makeSecretStore();
      const { client } = fakeClient();
      vi.mocked(client.toolkits.get).mockRejectedValueOnce(
        Object.assign(new Error(), { status: 401 }),
      );
      const service = make(store, () => client);

      const error = yield* Effect.flip(service.configure("bad-key"));
      expect(error).toMatchObject({ message: "The Composio API key is invalid." });
      expect(values.has("composio-api-key")).toBe(false);
    }),
  );

  it.effect("keeps multiple accounts and MCP headers in transient runtime state", () =>
    Effect.gen(function* () {
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, createSession } = fakeClient({
        accounts: [
          { id: "gmail-work", toolkit: { slug: "gmail" }, status: "ACTIVE", alias: "Work" },
          { id: "gmail-home", toolkit: { slug: "gmail" }, status: "ACTIVE", alias: "Home" },
          { id: "slack-failed", toolkit: { slug: "slack" }, status: "FAILED" },
        ],
      });
      const service = make(store, () => client);

      const status = yield* service.getStatus;
      expect(status.connections).toHaveLength(3);

      const first = yield* service.resolveRuntimeMcpServer("thread-1");
      const cached = yield* service.resolveRuntimeMcpServer("thread-1");
      const secondThread = yield* service.resolveRuntimeMcpServer("thread-2");

      expect(first).toBe(cached);
      expect(secondThread).toBeDefined();
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(createSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          connectedAccounts: { gmail: ["gmail-work", "gmail-home"] },
          multiAccount: expect.objectContaining({ requireExplicitSelection: true }),
        }),
      );
      expect(toClaudeMcpServers([first!])).toEqual({
        "composio-session": {
          type: "http",
          url: "https://app.composio.dev/tool_router/v3/session/mcp",
          headers: { "x-api-key": "project-key" },
        },
      });
      expect(first).toEqual({
        id: "composio-session",
        name: "Composio",
        transport: "url",
        url: "https://app.composio.dev/tool_router/v3/session/mcp",
        enabled: true,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
    }),
  );
});
