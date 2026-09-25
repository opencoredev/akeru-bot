// @effect-diagnostics nodeBuiltinImport:off - Tests inspect the packaged remote route files.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

it("registers the local remote update route in the server route layer", () => {
  const source = NodeFS.readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  expect(source).toContain(
    'import { remoteMachineUpdateRouteLayer } from "./remote/updateRoute.ts";',
  );
  expect(source).toMatch(/websocketRpcRouteLayer,[\s\S]*remoteMachineUpdateRouteLayer,/u);
});
