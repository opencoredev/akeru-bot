import { describe, expect, it } from "vite-plus/test";
import { loadCatalog } from "../../../../../plugins";
import {
  buildInstalledPluginSection,
  buildPluginSections,
  PLUGIN_FILTERS,
} from "./pluginPresentation";

const catalog = loadCatalog();

describe("plugin presentation", () => {
  it("builds a featured directory with the available categories", () => {
    const sections = buildPluginSections({ plugins: catalog, query: "", filter: "All" });
    expect(sections[0]?.title).toBe("Featured");
    expect(sections[0]?.plugins.map((plugin) => plugin.id)).toEqual([
      "context",
      "exa",
      "executor",
      "firecrawl",
      "parallel-search",
    ]);
    expect(sections.some((section) => section.title === "Data Extraction")).toBe(true);
    expect(sections.some((section) => section.title === "Search")).toBe(true);
    expect(PLUGIN_FILTERS).toEqual([
      "All",
      "Featured",
      "Data Extraction",
      "Search",
      "Productivity",
    ]);
  });

  it("builds a single searchable installed section", () => {
    const installed = catalog.filter((plugin) => plugin.id === "firecrawl" || plugin.id === "exa");
    const sections = buildInstalledPluginSection({ plugins: installed, query: "Exa" });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Installed");
    expect(sections[0]?.plugins.map((plugin) => plugin.id)).toEqual(["exa"]);
  });

  it("filters by category and search text", () => {
    const searchPlugins = buildPluginSections({
      plugins: catalog,
      query: "",
      filter: "Search",
    });
    expect(searchPlugins[0]?.plugins.map((plugin) => plugin.id)).toEqual([
      "exa",
      "parallel-search",
    ]);

    const extraction = buildPluginSections({
      plugins: catalog,
      query: "data extraction",
      filter: "All",
    });
    expect(extraction[0]?.plugins.map((plugin) => plugin.id)).toEqual(["context", "firecrawl"]);
  });
});
