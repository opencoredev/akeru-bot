// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ComputerCdp } from "./computerCdp.ts";

const servers: NodeHttp.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function browserThatDropsHandshakes() {
  const server = NodeHttp.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://ignored/devtools/page/1" }]),
    );
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

describe("ComputerCdp.connect", () => {
  // The 30-second connect timeout outlasts the test timeout, so a hang fails here.
  it("fails promptly when the browser drops the handshake", async () => {
    const url = await browserThatDropsHandshakes();
    await expect(ComputerCdp.connect({ url, requestHeaders: {} })).rejects.toThrow(
      /Graphical browser connection (failed|closed)/,
    );
  });
});
