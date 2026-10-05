import { describe, expect, it } from "vite-plus/test";
import { layoutFlow } from "./GenerativeFlow";
import { decodeGenerativeBlock, generativeKindForLanguage } from "./generativeSchemas";

describe("generative blocks", () => {
  it("maps only akeru- fences to block kinds", () => {
    expect(generativeKindForLanguage("akeru-chart")).toBe("chart");
    expect(generativeKindForLanguage("AKERU-Tasks")).toBe("tasks");
    expect(generativeKindForLanguage("akeru-unknown")).toBeNull();
    expect(generativeKindForLanguage("json")).toBeNull();
  });

  it("decodes a valid spec and rejects partial or malformed JSON", () => {
    const chart = '{"type":"bar","x":["Mon","Tue"],"series":[{"name":"PRs","values":[3,5]}]}';

    expect(decodeGenerativeBlock("chart", chart)?.kind).toBe("chart");
    expect(decodeGenerativeBlock("chart", chart.slice(0, 30))).toBeNull();
    expect(decodeGenerativeBlock("chart", '{"type":"pie","x":[],"series":[]}')).toBeNull();
  });

  it("ranks flow nodes left to right and survives cycles", () => {
    const flow = decodeGenerativeBlock(
      "flow",
      JSON.stringify({
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "a" },
        ],
      }),
    );

    expect(flow?.kind).toBe("flow");

    if (flow?.kind !== "flow") return;

    const { placed } = layoutFlow(flow.spec);

    expect(placed.size).toBe(3);
  });
});
