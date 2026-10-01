import type { ToolsInput } from "@mastra/core/agent";
import type { BrowserRpcParams } from "./browser/BotBrowserTypes.ts";
import { probeTool } from "./test-support/toolProbe.ts";
import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { describe, expect, it } from "vite-plus/test";

import { createBotBrowser } from "./botBrowser.ts";

async function executeTool(tool: ToolsInput[string] | undefined, input: BrowserRpcParams) {
  return probeTool(tool).execute(input);
}

describe.runIf(process.env.T3_BOT_BROWSER_INTEGRATION === "1")(
  "sandbox bot browser integration",
  () => {
    it("clicks a target on the bottom edge and keeps the same browser task", async () => {
      const server = NodeHttp.createServer((request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");

        if (request.url === "/clicked") {
          response.end("<!doctype html><title>Clicked</title><main>Bottom edge clicked</main>");

          return;
        }

        response.end(`<!doctype html>
          <title>Bottom edge target</title>
          <style>html,body{margin:0;height:100%}main{height:100vh;position:relative}button{position:absolute;left:0;bottom:0;height:40px}</style>
          <main><button id="bottom-target" onclick="location.href='/clicked'">Click bottom edge</button></main>`);
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();

      if (!address || Predicate.isString(address)) throw new Error("test server has no port");

      const workspace = new Workspace({
        filesystem: new LocalFilesystem({ basePath: process.cwd() }),
        sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
      });

      await workspace.init();

      const browser = createBotBrowser({
        threadId: "bottom-edge-integration",
        workspace,
        cacheDir: NodePath.join(NodeOS.tmpdir(), "akeru-lightpanda-cache"),
      });

      try {
        await executeTool(browser.tools.browser_navigate, {
          url: `http://127.0.0.1:${address.port}/`,
        });
        await executeTool(browser.tools.browser_click, { selector: "#bottom-target" });
        await browser.reconnect();
        const snapshot = await executeTool(browser.tools.browser_snapshot, {});
        expect(snapshot).toMatchObject({
          snapshot: expect.stringContaining("Bottom edge clicked"),
        });
      } finally {
        await browser.close();
        await workspace.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 360_000);
  },
);
