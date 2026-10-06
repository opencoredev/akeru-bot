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

  it("rejects charts the renderer would misdraw", () => {
    const series = (values: number[]) => ({ name: "s", values });

    const chart = (spec: { type: string; x: string[]; series: ReturnType<typeof series>[] }) =>
      decodeGenerativeBlock("chart", JSON.stringify(spec));

    expect(chart({ type: "bar", x: ["Mon", "Tue"], series: [series([-4, 6])] })).toBeNull();
    expect(chart({ type: "line", x: ["Mon", "Tue"], series: [series([5])] })).toBeNull();

    expect(
      chart({ type: "line", x: ["Mon"], series: [1, 2, 3, 4, 5].map((n) => series([n])) }),
    ).toBeNull();

    expect(chart({ type: "line", x: ["Mon"], series: [series([0])] })?.kind).toBe("chart");
  });

  it("bounds flows and rejects choices that share a label", () => {
    const nodes = Array.from({ length: 25 }, (_, index) => ({ id: `n${index}`, label: "N" }));

    expect(decodeGenerativeBlock("flow", JSON.stringify({ nodes, edges: [] }))).toBeNull();

    const option = { label: "Same", reply: "one" };

    expect(
      decodeGenerativeBlock(
        "choices",
        JSON.stringify({ question: "Q", options: [option, { ...option, reply: "two" }] }),
      ),
    ).toBeNull();
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

    const layout = layoutFlow(flow.spec);

    expect(layout.placed.size).toBe(3);
    // A cycle never reaches rank 0; the empty column must not turn the layout into NaN.
    expect(Number.isFinite(layout.height)).toBe(true);

    for (const node of layout.placed.values()) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
    }
  });
});
