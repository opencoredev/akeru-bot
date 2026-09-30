// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  AKERU_WEB_FETCH_TRUNCATION_MARKER,
  akeruWebSearchUnavailable,
  createAkeruWebFetch,
  isAkeruPrivateAddress,
  parseAkeruPublicUrl,
} from "./AkeruWebFetch.ts";

const servers: NodeHttp.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(handler: NodeHttp.RequestListener): Promise<number> {
  const server = NodeHttp.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as NodeNet.AddressInfo).port;
}

// Loopback stands in for a public address so the test can serve real HTTP.
const allowLoopbackOnly = (address: string) => address === "127.0.0.1";

describe("Akeru WebFetch", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "100.100.1.1",
    "169.254.169.254",
    "172.20.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fec0::1",
    "64:ff9b::a00:1",
    "64:ff9b:1::a00:1",
    "2002:a00:1::1",
  ])("treats %s as private", (address) => {
    expect(isAkeruPrivateAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])(
    "treats %s as public",
    (address) => {
      expect(isAkeruPrivateAddress(address)).toBe(false);
    },
  );

  it.each([
    "http://127.0.0.1:8080/",
    "http://[::ffff:127.0.0.1]/",
    "http://printer.local/",
    "file:///etc/passwd",
    "https://user:password@example.com/",
  ])("rejects %s by shape", (url) => {
    expect(() => parseAkeruPublicUrl(url)).toThrow();
  });

  it("rejects a hostname whose lookup returns a private address", async () => {
    const webFetch = createAkeruWebFetch({
      lookup: async () => [{ address: "10.0.0.2", family: 4 }],
    });
    await expect(webFetch({ url: "https://example.com/" })).rejects.toThrow("private");
  });

  it("rejects a hostname whose lookup returns a malformed address", async () => {
    const webFetch = createAkeruWebFetch({
      lookup: async () => [{ address: "not-an-address", family: 4 }],
    });
    await expect(webFetch({ url: "https://example.com/" })).rejects.toThrow("valid address");
  });

  it("times out a hostname whose lookup never answers", async () => {
    const webFetch = createAkeruWebFetch({
      lookup: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await expect(webFetch({ url: "https://stalled.example/" })).rejects.toThrow("timed out");
  });

  it("pins the validated address so a rebinding resolver never reaches the connection", async () => {
    const port = await listen((_request, response) => response.end("pinned page"));
    const answers = [[{ address: "127.0.0.1", family: 4 }], [{ address: "10.0.0.9", family: 4 }]];
    const lookups: string[] = [];
    const webFetch = createAkeruWebFetch({
      lookup: async (hostname) => {
        lookups.push(hostname);
        return answers.shift() ?? [];
      },
      allowAddress: allowLoopbackOnly,
    });

    const result = await webFetch({ url: `http://rebind.example:${port}/` });

    // One resolution: the connection used the validated address instead of
    // asking the resolver again (which would have returned 10.0.0.9).
    expect(lookups).toEqual(["rebind.example"]);
    expect(result).toMatchObject({ status: 200, text: "pinned page", truncated: false });
  });

  it("re-validates every redirect hop against a fresh resolution", async () => {
    const port = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: `http://evil.example:${port}/secret` });
        response.end();
        return;
      }
      response.end("secret");
    });
    const webFetch = createAkeruWebFetch({
      lookup: async (hostname) =>
        hostname === "evil.example"
          ? [{ address: "10.0.0.9", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }],
      allowAddress: allowLoopbackOnly,
    });
    await expect(webFetch({ url: `http://ok.example:${port}/start` })).rejects.toThrow("private");
  });

  it("truncates an oversized response at the byte cap with a marker", async () => {
    const chunk = "a".repeat(64 * 1024);
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      // 1 MB against a 100 KB cap. The server keeps writing; the client stops reading.
      for (let index = 0; index < 16; index += 1) response.write(chunk);
      response.end();
    });
    const maxBytes = 100 * 1024;
    const webFetch = createAkeruWebFetch({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      allowAddress: allowLoopbackOnly,
      maxBytes,
    });

    const result = await webFetch({ url: `http://big.example:${port}/` });

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("a".repeat(maxBytes))).toBe(true);
    expect(result.text.slice(maxBytes)).toBe(
      `${AKERU_WEB_FETCH_TRUNCATION_MARKER} ${maxBytes} bytes.]`,
    );
  });

  it("reports WebSearch as unavailable instead of inventing results", async () => {
    await expect(akeruWebSearchUnavailable({ query: "akeru" })).resolves.toMatchObject({
      status: "unavailable",
      query: "akeru",
      results: [],
    });
  });
});
