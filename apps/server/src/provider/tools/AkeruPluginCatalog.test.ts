import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadManifestCatalog } from "../../../../../plugins/manifestCatalog.ts";
import { loadNodeCatalogModules } from "./AkeruPluginCatalog.ts";

const temporaryDirectories: string[] = [];

function fixture(modulePath: string, entriesPath: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-catalog-loader-"));
  temporaryDirectories.push(root);
  NodeFS.cpSync(
    new URL("../../../../../plugins/entries/exa/", import.meta.url),
    NodePath.join(root, entriesPath, "exa"),
    { recursive: true },
  );
  return NodeURL.pathToFileURL(NodePath.join(root, modulePath)).href;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("Node plugin catalog loading", () => {
  it.each([
    [
      "released CLI",
      "node_modules/akeru-bot/dist/bin.mjs",
      "node_modules/akeru-bot/dist/plugins/entries",
    ],
    [
      "service launcher",
      "node_modules/akeru-bot/dist/service-launcher.mjs",
      "node_modules/akeru-bot/dist/plugins/entries",
    ],
    ["source", "apps/server/src/provider/tools/AkeruPluginCatalog.ts", "plugins/entries"],
    ["repository bundle", "apps/server/dist/bin.mjs", "plugins/entries"],
    ["desktop", "resources/app/apps/server/dist/bin.mjs", "resources/plugins/entries"],
    ["desktop staging", "apps/server/dist/bin.mjs", "apps/desktop/prod-resources/plugins/entries"],
  ])("loads the real manifest in %s layout", (_name, modulePath, entriesPath) => {
    const catalog = loadManifestCatalog(loadNodeCatalogModules(fixture(modulePath, entriesPath)));
    expect(catalog.map((plugin) => plugin.id)).toEqual(["exa"]);
    expect(catalog[0]?.name).toBe("Exa");
  });

  it("reports an unavailable catalog when no deployment path exists", () => {
    const moduleUrl = fixture("package/dist/bin.mjs", "unrelated/entries");
    expect(() => loadNodeCatalogModules(moduleUrl)).toThrow(
      "Akeru plugin catalog directory is unavailable.",
    );
  });
});
