// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("interactive pointer cursor", () => {
  it("gives clickable controls a pointer cursor from the shared base rule", () => {
    const css = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");
    const rule = css.match(
      /\/\* Clickable controls use the pointer cursor[\s\S]*?cursor:\s*pointer;/,
    )?.[0];

    expect(rule).toBeDefined();
    expect(rule).toContain(":where(");
    expect(rule).toContain("a[href]");
    expect(rule).toContain("button");
    expect(rule).toContain("[role=\"button\"]");
    expect(rule).toContain("[role=\"tab\"]");
    expect(rule).toContain("[role=\"option\"]");
    expect(rule).toContain("summary");
    expect(rule).toContain("label");
    expect(rule).toContain(":not(:disabled, [aria-disabled=\"true\"], [data-disabled])");
  });
});
