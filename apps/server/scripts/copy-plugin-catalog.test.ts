import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import packageJson from "../package.json" with { type: "json" };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("bundled plugin assets", () => {
  it("copies manifests and logos without retaining removed entries or deleting bundle files", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-catalog-copy-"));
    temporaryDirectories.push(root);
    const source = NodePath.join(root, "entries");
    const dist = NodePath.join(root, "dist");
    NodeFS.cpSync(
      new URL("../../../plugins/entries/exa/", import.meta.url),
      NodePath.join(source, "exa"),
      { recursive: true },
    );
    NodeFS.mkdirSync(NodePath.join(dist, "plugins/entries/removed"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dist, "bin.mjs"), "bundle");
    NodeChildProcess.execFileSync(
      process.execPath,
      [new URL("./copy-plugin-catalog.ts", import.meta.url).pathname, source, dist],
      { cwd: root },
    );
    const copied = NodePath.join(dist, "plugins/entries");
    expect(NodeFS.readdirSync(copied)).toEqual(["exa"]);
    for (const name of ["plugin.json", "logo.svg", "logo-dark.svg"]) {
      expect(NodeFS.readFileSync(NodePath.join(copied, "exa", name))).toEqual(
        NodeFS.readFileSync(NodePath.join(source, "exa", name)),
      );
    }
    expect(NodeFS.readFileSync(NodePath.join(dist, "bin.mjs"), "utf8")).toBe("bundle");
  });

  it("copies the catalog after both bundle commands have finished", () => {
    expect(packageJson.scripts["build:bundle"].split(" && ")).toEqual([
      "vp pack",
      "vp pack src/service-launcher.ts --out-dir dist --no-clean",
      "node scripts/copy-plugin-catalog.ts",
    ]);
  });
});
