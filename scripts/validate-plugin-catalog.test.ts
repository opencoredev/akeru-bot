// @effect-diagnostics nodeBuiltinImport:off - Tests build isolated catalog directories on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { validatePluginCatalog } from "./validate-plugin-catalog.ts";

const temporaryDirectories: string[] = [];

function fixtureRoot(): URL {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-plugins-"));
  temporaryDirectories.push(directory);
  return NodeURL.pathToFileURL(`${directory}/`);
}

function copyEntry(id: string, root: URL): URL {
  const target = new URL(`${id}/`, root);
  NodeFS.cpSync(new URL(`../plugins/entries/${id}/`, import.meta.url), target, { recursive: true });
  return target;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("plugin catalog validation", () => {
  it("validates the live plugin directory", () => {
    expect(validatePluginCatalog()).toHaveLength(54);
  });

  it("validates isolated manifests and official local assets", () => {
    const root = fixtureRoot();
    copyEntry("context", root);
    copyEntry("executor", root);
    expect(validatePluginCatalog(root).map((entry) => entry.manifest.id)).toEqual([
      "context",
      "executor",
    ]);
  });

  it("rejects missing, generic, oversized, unsafe, and shared logos", () => {
    const missingRoot = fixtureRoot();
    const missing = copyEntry("exa", missingRoot);
    NodeFS.rmSync(new URL("logo.svg", missing));
    expect(() => validatePluginCatalog(missingRoot)).toThrow("is missing logo");

    const renamedGenericRoot = fixtureRoot();
    const renamedGeneric = copyEntry("exa", renamedGenericRoot);
    NodeFS.copyFileSync(
      new URL("../apps/web/public/plugin-logos/mcp.svg", import.meta.url),
      new URL("logo.svg", renamedGeneric),
    );
    expect(() => validatePluginCatalog(renamedGenericRoot)).toThrow("uses a generic MCP logo");

    const unsafeRoot = fixtureRoot();
    const unsafe = copyEntry("exa", unsafeRoot);
    NodeFS.writeFileSync(new URL("logo.svg", unsafe), '<svg><script>alert("x")</script></svg>');
    expect(() => validatePluginCatalog(unsafeRoot)).toThrow("unsafe SVG");

    const oversizedRoot = fixtureRoot();
    const oversized = copyEntry("exa", oversizedRoot);
    NodeFS.writeFileSync(new URL("logo.svg", oversized), Buffer.alloc(128 * 1024 + 1));
    expect(() => validatePluginCatalog(oversizedRoot)).toThrow("exceeds 128 KiB");

    const sharedRoot = fixtureRoot();
    const context = copyEntry("context", sharedRoot);
    const exa = copyEntry("exa", sharedRoot);
    NodeFS.copyFileSync(new URL("logo.svg", context), new URL("logo.svg", exa));
    expect(() => validatePluginCatalog(sharedRoot)).toThrow("use the same logo");
  });

  it("requires the exact light and dark SVG asset names", () => {
    const missingRoot = fixtureRoot();
    const missing = copyEntry("context", missingRoot);
    NodeFS.rmSync(new URL("logo-dark.svg", missing));
    expect(() => validatePluginCatalog(missingRoot)).toThrow("is missing logo 'logo-dark.svg'");

    const renamedRoot = fixtureRoot();
    const renamed = copyEntry("context", renamedRoot);
    NodeFS.renameSync(new URL("logo.svg", renamed), new URL("brand.svg", renamed));
    expect(() => validatePluginCatalog(renamedRoot)).toThrow("is missing logo 'logo.svg'");
  });

  it("rejects undeclared files so the live directory is the only catalog source", () => {
    const root = fixtureRoot();
    const entry = copyEntry("exa", root);
    NodeFS.writeFileSync(new URL("catalog.generated.json", entry), "[]");
    expect(() => validatePluginCatalog(root)).toThrow("has undeclared files");
  });

  it("accepts a remote logo without local assets and still rejects stray files", () => {
    const root = fixtureRoot();
    copyEntry("gmail", root);
    expect(validatePluginCatalog(root).map((entry) => entry.directory)).toEqual(["gmail"]);

    const strayRoot = fixtureRoot();
    const stray = copyEntry("gmail", strayRoot);
    NodeFS.writeFileSync(new URL("logo.svg", stray), "<svg></svg>");
    expect(() => validatePluginCatalog(strayRoot)).toThrow("has undeclared files");
  });
});
