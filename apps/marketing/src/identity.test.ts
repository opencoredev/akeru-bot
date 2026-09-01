import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const sourceFile = (path: string) =>
  NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, path), "utf8");

describe("Akeru public identity", () => {
  it("credits T3 Code without claiming T3 ownership", () => {
    const publicIdentity = [
      sourceFile("layouts/Layout.astro"),
      sourceFile("pages/about.astro"),
      sourceFile("pages/contact.astro"),
    ].join("\n");

    expect(publicIdentity).toContain("https://t3.codes");
    expect(publicIdentity).toContain("T3 Code team");
    expect(publicIdentity).not.toContain("T3 Tools");
    expect(publicIdentity).not.toContain("@t3.tools");
    expect(publicIdentity).not.toContain("@ping.gg");
  });
});
