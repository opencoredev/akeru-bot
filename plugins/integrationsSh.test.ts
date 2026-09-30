import { describe, expect, it } from "vite-plus/test";

import { loadDirectoryCatalog } from "./catalog";
import { isListedIntegration } from "./integrationsSh";

describe("integrations.sh directory listing", () => {
  it("lists every integrations.sh entry, including ones still pending verification", () => {
    const listed = loadDirectoryCatalog().filter(isListedIntegration);
    expect(listed.map((plugin) => plugin.id).toSorted()).toEqual(["context", "exa", "firecrawl"]);
  });

  it("hides unlisted, brokered, and deprecated entries", () => {
    const listed = { id: "exa", catalogStatus: "available", connection: { type: "ready" } };
    expect(isListedIntegration(listed)).toBe(true);
    expect(isListedIntegration({ ...listed, id: "gmail" })).toBe(false);
    expect(isListedIntegration({ ...listed, connection: { type: "brokered" } })).toBe(false);
    expect(isListedIntegration({ ...listed, catalogStatus: "deprecated" })).toBe(false);
  });
});
