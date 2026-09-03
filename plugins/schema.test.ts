import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_APPROVAL_CLASSES, PLUGIN_CATEGORIES } from "./categories";
import { parsePluginManifest } from "./schema";

const VALID_MANIFEST = {
  schemaVersion: 1,
  id: "example",
  name: "Example",
  description: "Connect Example.",
  primaryCategory: "Work",
  tags: ["example"],
  capabilities: ["read-data"],
  publisher: { name: "Example", url: "https://example.com" },
  maintainer: { name: "Example", url: "https://example.com" },
  documentationUrl: "https://example.com/docs",
  sourceUrl: "https://example.com/source",
  license: "MIT",
  logo: {
    provenance: { sourceUrl: "https://example.com/brand", license: "Trademark" },
  },
  platforms: ["web"],
  transport: { type: "url", url: "https://example.com/mcp" },
  connection: { type: "ready" },
  authentication: "oauth",
  requiredCredentials: [],
  setup: ["Connect Example."],
  permissions: [{ id: "read-data", description: "Read data.", approval: "read" }],
  approvals: [],
  catalogStatus: "available",
} as const;

describe("plugin catalog schema", () => {
  it("defines the categories and consequential approval classes", () => {
    expect(PLUGIN_CATEGORIES).toEqual([
      "Work",
      "Web",
      "Marketing",
      "Build",
      "Design",
      "Sales",
      "Support",
      "Commerce",
    ]);
    expect(PLUGIN_APPROVAL_CLASSES).toEqual([
      "send",
      "pay",
      "delete",
      "production",
      "secrets",
      "publishing",
      "signatures",
      "refunds",
      "account-wide",
    ]);
  });

  it("rejects insecure endpoints, undeclared credentials, and missing approvals", () => {
    expect(() =>
      parsePluginManifest({
        ...VALID_MANIFEST,
        transport: { type: "url", url: "http://example.com/mcp" },
      }),
    ).toThrow("endpoint must use HTTPS");
    expect(() =>
      parsePluginManifest({ ...VALID_MANIFEST, requiredCredentials: ["example-api-key"] }),
    ).toThrow("declares credentials without API key authentication");
    expect(() =>
      parsePluginManifest({
        ...VALID_MANIFEST,
        permissions: [{ id: "delete-data", description: "Delete data.", approval: "delete" }],
      }),
    ).toThrow("requires 'delete' approval");
  });

  it("allows loopback HTTP only for local connections and requires a named broker", () => {
    expect(
      parsePluginManifest({
        ...VALID_MANIFEST,
        transport: { type: "url", url: "http://127.0.0.1:29979/mcp" },
        connection: { type: "local" },
        authentication: "none",
      }).connection.type,
    ).toBe("local");
    expect(() =>
      parsePluginManifest({
        ...VALID_MANIFEST,
        connection: { type: "brokered" },
      }),
    ).toThrow("broker");
  });

  it("allows pending API key recipes and still requires their credentials", () => {
    const pendingApiKey = {
      ...VALID_MANIFEST,
      connection: {
        type: "verification-pending",
        blocker: "The vendor must verify its API key MCP endpoint.",
      },
      authentication: "api-key",
      requiredCredentials: ["example-api-key"],
      catalogStatus: "verification-pending",
    } as const;
    expect(parsePluginManifest(pendingApiKey).connection).toEqual(pendingApiKey.connection);
    expect(() => parsePluginManifest({ ...pendingApiKey, requiredCredentials: [] })).toThrow(
      "must name its required API key credentials",
    );
    expect(() =>
      parsePluginManifest({
        ...pendingApiKey,
        connection: { type: "local" },
        catalogStatus: "available",
      }),
    ).toThrow("must label its API key connection");
  });

  it("allows pending loopback recipes but rejects other insecure connections", () => {
    const pendingLoopback = {
      ...VALID_MANIFEST,
      transport: { type: "url", url: "http://127.0.0.1:29979/mcp" },
      connection: {
        type: "verification-pending",
        blocker: "The local MCP recipe still needs verification.",
      },
      authentication: "none",
      catalogStatus: "verification-pending",
    } as const;
    expect(parsePluginManifest(pendingLoopback).connection).toEqual(pendingLoopback.connection);
    expect(() =>
      parsePluginManifest({
        ...pendingLoopback,
        transport: { type: "url", url: "http://example.com/mcp" },
      }),
    ).toThrow("endpoint must use HTTPS");
    expect(() =>
      parsePluginManifest({
        ...pendingLoopback,
        connection: { type: "ready" },
        catalogStatus: "available",
      }),
    ).toThrow("endpoint must use HTTPS");
  });

  it("requires pending connection and catalog statuses to agree", () => {
    const pending = {
      ...VALID_MANIFEST,
      connection: {
        type: "approval-pending",
        blocker: "The vendor must verify its HTTPS MCP endpoint.",
      },
      catalogStatus: "approval-pending",
    } as const;
    expect(parsePluginManifest(pending).catalogStatus).toBe("approval-pending");
    expect(() => parsePluginManifest({ ...pending, catalogStatus: "available" })).toThrow(
      "must use approval-pending catalog status",
    );
    expect(() =>
      parsePluginManifest({ ...VALID_MANIFEST, catalogStatus: "approval-pending" }),
    ).toThrow("must label its connection as approval-pending");
    const verificationPending = {
      ...pending,
      connection: {
        type: "verification-pending",
        blocker: "The connection lifecycle still needs verification.",
      },
      catalogStatus: "verification-pending",
    } as const;
    expect(parsePluginManifest(verificationPending).catalogStatus).toBe("verification-pending");
    expect(() =>
      parsePluginManifest({ ...verificationPending, catalogStatus: "available" }),
    ).toThrow("must use verification-pending catalog status");
    expect(() =>
      parsePluginManifest({ ...VALID_MANIFEST, catalogStatus: "verification-pending" }),
    ).toThrow("must label its connection as verification-pending");
  });

  it("rejects stdio recipes that expose local paths or credentials", () => {
    const local = {
      ...VALID_MANIFEST,
      transport: { type: "stdio", command: "bunx", args: ["example", "mcp"] },
      connection: { type: "local" },
      authentication: "none",
    };
    expect(() =>
      parsePluginManifest({
        ...local,
        transport: { type: "stdio", command: "/usr/local/bin/bunx" },
      }),
    ).toThrow("must not use an absolute path");
    expect(() =>
      parsePluginManifest({
        ...local,
        transport: { type: "stdio", command: "bunx", args: ["--config=/tmp/example"] },
      }),
    ).toThrow("arguments must not use absolute paths");
    expect(() =>
      parsePluginManifest({
        ...local,
        transport: { type: "stdio", command: "bunx", args: ["--api-key=secret"] },
      }),
    ).toThrow("arguments must not contain credentials");
  });

  it("requires an explicit blocker when no MCP transport exists", () => {
    const pending = {
      ...VALID_MANIFEST,
      id: "pending-vendor",
      name: "Pending Vendor",
      transport: { type: "unavailable" },
      connection: {
        type: "approval-pending",
        blocker: "The vendor must approve Akeru as an OAuth client.",
      },
      catalogStatus: "approval-pending",
    };
    expect(parsePluginManifest(pending).connection).toEqual(pending.connection);
    expect(() => parsePluginManifest({ ...pending, catalogStatus: "available" })).toThrow(
      "cannot be available without a transport recipe",
    );
    expect(() =>
      parsePluginManifest({ ...pending, connection: { type: "approval-pending" } }),
    ).toThrow("blocker");
  });

  it("allows a broker to supply the runtime transport", () => {
    const brokered = {
      ...VALID_MANIFEST,
      transport: { type: "unavailable" },
      connection: {
        type: "brokered",
        broker: { name: "Example Broker", url: "https://broker.example.com" },
      },
    } as const;

    expect(parsePluginManifest(brokered)).toMatchObject({
      transport: { type: "unavailable" },
      connection: { type: "brokered", broker: { name: "Example Broker" } },
      catalogStatus: "available",
    });
  });
});
