import * as Predicate from "effect/Predicate";
import * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";

import { openCloudSocket } from "./CloudConnection.ts";

describe("cloud socket transport", () => {
  it.each([401, 410, 503])(
    "reports a refused upgrade with status %s and authenticates once",
    async (status) => {
      const requests: { path: string; authorization: string | undefined }[] = [];

      const server = NodeHttp.createServer((request, response) => {
        requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
        response.writeHead(status);
        response.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();

      if (!address || Predicate.isString(address)) throw new Error("Expected test TCP address");
      const onOpen = vi.fn();
      let closeCount = 0;

      try {
        const outcome = await new Promise<number | undefined>((resolve) => {
          openCloudSocket(`ws://127.0.0.1:${address.port}/v1/environments/connect`, "test-token", {
            onOpen,
            onMessage: vi.fn(),
            onClose: (receivedStatus) => {
              closeCount += 1;
              resolve(receivedStatus);
            },
          });
        });

        expect(outcome).toBe(status);
        expect(onOpen).not.toHaveBeenCalled();
        expect(requests).toEqual([
          { path: "/v1/environments/connect", authorization: "Bearer test-token" },
        ]);
        expect(closeCount).toBe(1);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
