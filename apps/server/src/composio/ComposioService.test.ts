import { Composio } from "@composio/core";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  readonly authorize?: () => Promise<{
    readonly id: string;
    readonly redirectUrl?: string;
  }>;
  readonly deleteSession?: () => Promise<void>;
  readonly sessionCreationGate?: Promise<void>;
}) {
  const sessionDeletes: Array<ReturnType<typeof vi.fn<() => Promise<void>>>> = [];
  const createSession = vi.fn(async () => {
    await input?.sessionCreationGate;
    const deleteSession = vi.fn(input?.deleteSession ?? (async () => undefined));
    sessionDeletes.push(deleteSession);
    return {
      mcp: {
        url: "https://app.composio.dev/tool_router/v3/session/mcp",
        headers: { "x-api-key": "project-key" },
      },
      authorize: vi.fn(
        input?.authorize ??
          (async () => ({
            id: "connection-new",
            redirectUrl: "https://connect.composio.dev/link",
          })),
      ),
      delete: deleteSession,
    };
  });
  const client = {
    toolkits: { get: vi.fn(async () => []) },
    connectedAccounts: {
      list: vi.fn(async () => ({ items: input?.accounts ?? [], totalPages: 1 })),
      delete: vi.fn(async () => ({})),
    },
    sessions: { create: createSession },
  } as unknown as InstanceType<typeof Composio>;
  return { client, createSession, sessionDeletes };
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

  it.effect("deletes its hosted session after starting authorization", () =>
    Effect.gen(function* () {
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, sessionDeletes } = fakeClient();
      const service = make(store, () => client);

      expect(yield* service.authorize({ toolkitSlug: "gmail" })).toEqual({
        connectionId: "connection-new",
        redirectUrl: "https://connect.composio.dev/link",
      });
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("deletes its hosted session when authorization fails", () =>
    Effect.gen(function* () {
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, sessionDeletes } = fakeClient({
        authorize: () => Promise.reject(new Error("authorization failed")),
      });
      const service = make(store, () => client);

      expect(yield* Effect.flip(service.authorize({ toolkitSlug: "gmail" }))).toMatchObject({
        operation: "start account authorization",
        message: "Composio could not start account authorization.",
      });
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("deletes its hosted session when the authorization URL is missing", () =>
    Effect.gen(function* () {
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, sessionDeletes } = fakeClient({
        authorize: async () => ({ id: "connection-new" }),
      });
      const service = make(store, () => client);

      expect(yield* Effect.flip(service.authorize({ toolkitSlug: "gmail" }))).toMatchObject({
        operation: "start account authorization",
        message: "Composio could not start account authorization.",
      });
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("retries failed authorization-session cleanup before authorizing again", () =>
    Effect.gen(function* () {
      let cleanupAttempt = 0;
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, createSession, sessionDeletes } = fakeClient({
        deleteSession: async () => {
          cleanupAttempt += 1;
          if (cleanupAttempt === 1) throw new Error("cleanup response was lost");
          if (cleanupAttempt === 2) {
            throw Object.assign(new Error("session not found"), { status: 404 });
          }
        },
      });
      const service = make(store, () => client);

      expect(yield* Effect.flip(service.authorize({ toolkitSlug: "gmail" }))).toMatchObject({
        operation: "start account authorization",
        message: "Composio could not start account authorization.",
      });
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);

      expect(yield* service.authorize({ toolkitSlug: "gmail" })).toEqual({
        connectionId: "connection-new",
        redirectUrl: "https://connect.composio.dev/link",
      });
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(2);
      expect(sessionDeletes[1]).toHaveBeenCalledTimes(1);
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

  it.effect("deletes a hosted session before replacing its cached runtime", () =>
    Effect.gen(function* () {
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, createSession, sessionDeletes } = fakeClient({
        accounts: [{ id: "gmail-work", toolkit: { slug: "gmail" }, status: "ACTIVE" }],
      });
      const service = make(store, () => client);

      yield* service.resolveRuntimeMcpServer("thread-1");
      vi.mocked(client.connectedAccounts.list).mockResolvedValue({
        items: [{ id: "slack-work", toolkit: { slug: "slack" }, status: "ACTIVE" }],
        totalPages: 1,
      } as never);
      yield* service.resolveRuntimeMcpServer("thread-1");

      expect(createSession).toHaveBeenCalledTimes(2);
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
      expect(sessionDeletes[1]).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps failed hosted-session cleanup retryable", () =>
    Effect.gen(function* () {
      const { store, values } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, sessionDeletes } = fakeClient({
        accounts: [{ id: "gmail-work", toolkit: { slug: "gmail" }, status: "ACTIVE" }],
      });
      const service = make(store, () => client);

      yield* service.resolveRuntimeMcpServer("thread-1");
      sessionDeletes[0]!.mockRejectedValueOnce(new Error("cleanup failed"));

      const error = yield* Effect.flip(service.remove);
      expect(error).toMatchObject({
        operation: "delete hosted tool sessions",
        message: "Composio could not delete hosted tool sessions.",
      });
      expect(values.has("composio-api-key")).toBe(true);

      expect(yield* service.remove).toEqual({ configured: false, connections: [] });
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(2);
      expect(values.has("composio-api-key")).toBe(false);
    }),
  );

  it.effect("deletes the oldest hosted session before LRU eviction", () =>
    Effect.gen(function* () {
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, createSession, sessionDeletes } = fakeClient({
        accounts: [{ id: "gmail-work", toolkit: { slug: "gmail" }, status: "ACTIVE" }],
      });
      const service = make(store, () => client);

      for (let index = 0; index <= 100; index += 1) {
        yield* service.resolveRuntimeMcpServer(`thread-${index}`);
      }

      expect(createSession).toHaveBeenCalledTimes(101);
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
      expect(sessionDeletes[1]).not.toHaveBeenCalled();
    }),
  );

  it.effect("deletes a runtime session created while an account is disconnected", () =>
    Effect.gen(function* () {
      let releaseSessionCreation!: () => void;
      const sessionCreationGate = new Promise<void>((resolve) => {
        releaseSessionCreation = resolve;
      });
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, createSession, sessionDeletes } = fakeClient({
        accounts: [{ id: "gmail-work", toolkit: { slug: "gmail" }, status: "ACTIVE" }],
        sessionCreationGate,
      });
      const service = make(store, () => client);

      const resolving = yield* Effect.forkChild(service.resolveRuntimeMcpServer("thread-1"));
      yield* Effect.promise(() => vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1)));
      yield* service.disconnect("gmail-work");
      releaseSessionCreation();

      expect(yield* Fiber.join(resolving)).toBeUndefined();
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("shares concurrent runtime resolution for the same resource", () =>
    Effect.gen(function* () {
      let releaseSessionCreation!: () => void;
      const sessionCreationGate = new Promise<void>((resolve) => {
        releaseSessionCreation = resolve;
      });
      const { store } = makeSecretStore({ "composio-api-key": "project-key" });
      const { client, createSession, sessionDeletes } = fakeClient({
        accounts: [{ id: "gmail-work", toolkit: { slug: "gmail" }, status: "ACTIVE" }],
        sessionCreationGate,
      });
      const createClient = vi.fn(() => client);
      const service = make(store, createClient);

      const first = yield* Effect.forkChild(service.resolveRuntimeMcpServer("thread-1"));
      yield* Effect.promise(() => vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1)));
      const second = yield* Effect.forkChild(service.resolveRuntimeMcpServer("thread-1"));
      yield* Effect.promise(() => vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(2)));
      releaseSessionCreation();

      expect(yield* Fiber.join(first)).toBe(yield* Fiber.join(second));
      expect(createSession).toHaveBeenCalledTimes(1);
      yield* service.remove;
      expect(sessionDeletes[0]).toHaveBeenCalledTimes(1);
    }),
  );
});
