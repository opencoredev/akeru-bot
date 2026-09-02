import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const packageEntry = NodeModule.createRequire(
  new URL("../node_modules/.pnpm/node_modules/resolve.cjs", import.meta.url),
).resolve("@mastra/mcp");
const packageRoot = NodePath.dirname(NodePath.dirname(packageEntry));

function readPackageFile(path: string): string {
  return NodeFS.readFileSync(NodePath.join(packageRoot, path), "utf8");
}

describe("@mastra/mcp OAuth issuer patch", () => {
  it("forwards the authorization issuer from the callback to the MCP transport", () => {
    for (const bundle of ["dist/index.js", "dist/index.cjs"]) {
      const source = readPackageFile(bundle);
      expect(source).toContain('iss: url.searchParams.get("iss") ?? void 0');
      expect(source).toContain("const { code, iss } = await callbackServer.waitForCode(options)");
      expect(source).toContain("await client.finishAuth(code, iss)");
      expect(source).toContain("await pending.finishAuth(authorizationCode, iss)");
    }

    expect(readPackageFile("dist/client/client.d.ts")).toContain(
      "finishAuth(authorizationCode: string, iss?: string): Promise<void>",
    );
    expect(readPackageFile("dist/client/oauth-callback-server.d.ts")).toContain("iss?: string");
  });
});
