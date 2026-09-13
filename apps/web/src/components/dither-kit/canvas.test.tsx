import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness } from "../../test/reactHookHarness";
import { seedOfColor } from "./palette";

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  effects: [] as { run: () => void | (() => void); deps: readonly unknown[] | undefined }[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => {
      const ref = reactHookHarness.useRef<{ value: T; deps: readonly unknown[] } | null>(null);
      if (
        !ref.current ||
        deps.some((value, index) => !Object.is(value, ref.current!.deps[index]))
      ) {
        ref.current = { value: factory(), deps };
      }
      return ref.current.value;
    },
    useRef: <T,>(value: T) => {
      const ref = reactHookHarness.useRef(value);
      hooks.refs.push(ref);
      return ref;
    },
    useEffect: (run: () => void | (() => void), deps: readonly unknown[] | undefined) => {
      hooks.effects.push({ run, deps });
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./chart-context", () => ({ useChart: () => chart }));

import { BarCanvas } from "./bar-canvas";
import { CartesianCanvas } from "./cartesian-canvas";

function chartFixture() {
  return {
    plot: { width: 100, height: 60 },
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    ready: true,
    configKeys: ["tokens"],
    bands: {
      tokens: [
        [0, 10],
        [0, 20],
      ],
    },
    y: (value: number) => 60 - value,
    chartType: "line",
    dataLength: 2,
    seriesSpecs: {},
    seedOf: () => seedOfColor("green"),
    animate: false,
    animationDuration: 100,
    revision: 0,
    stackType: "overlap",
    selectedDataKey: null as string | null,
    focusDataKey: null as string | null,
    hoverIndex: null as number | null,
    cursorX: 0,
    markerIndex: null as number | null,
    isMouseInChart: false,
    hovered: false,
    bloom: "off",
    bloomOnHover: false,
    barSlot: (index: number) => ({ x: index * 50, width: 40 }),
    markEntranceDone: vi.fn(),
  };
}

let chart = chartFixture();
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let effects: { deps: readonly unknown[] | undefined; cleanup?: void | (() => void) }[] = [];
const paintContext = () => ({
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: "",
});
const paint = paintContext();
const fillPaint = paintContext();
const bloomPaint = paintContext();
const canvas = { width: 0, height: 0, getContext: () => paint };
const fillCanvas = { width: 0, height: 0, getContext: () => fillPaint };
const bloomCanvas = { width: 0, height: 0, getContext: () => bloomPaint };

function render(Component: typeof BarCanvas) {
  reactHookHarness.beginRender();
  hooks.refs = [];
  hooks.effects = [];
  Component();
  hooks.refs[0]!.current = canvas;
  hooks.refs[1]!.current = bloomCanvas;
  hooks.effects.forEach((effect, index) => {
    const previous = effects[index];
    if (
      previous?.deps &&
      effect.deps &&
      previous.deps.length === effect.deps.length &&
      previous.deps.every((value, i) => Object.is(value, effect.deps![i]))
    )
      return;
    previous?.cleanup?.();
    effects[index] = { deps: effect.deps, cleanup: effect.run() };
  });
}

function flushFrame(now = 1000) {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(now));
}

beforeEach(() => {
  chart = chartFixture();
  frames = new Map();
  nextFrame = 0;
  effects = [];
  reactHookHarness.reset();
  vi.clearAllMocks();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", { createElement: () => fillCanvas });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

for (const [name, Component] of [
  ["bar", BarCanvas],
  ["line", CartesianCanvas],
] as const) {
  describe(`${name} canvas`, () => {
    const seriesPaint = name === "line" ? fillPaint : paint;
    it("paints static data once and schedules no idle frames", () => {
      render(Component);
      expect(frames.size).toBe(1);
      flushFrame();
      expect(seriesPaint.fillRect).toHaveBeenCalled();
      expect(frames.size).toBe(0);
    });

    it("repaints hover, selection, data and marker removal without retaining a loop", () => {
      render(Component);
      flushFrame();
      for (const update of [
        { hoverIndex: 1, isMouseInChart: true },
        { selectedDataKey: "tokens" },
        {
          bands: {
            tokens: [
              [0, 20],
              [0, 30],
            ],
          },
          revision: 1,
        },
        { hoverIndex: null, isMouseInChart: false, selectedDataKey: null },
      ]) {
        paint.clearRect.mockClear();
        chart = { ...chart, ...update };
        render(Component);
        expect(frames.size).toBe(1);
        flushFrame();
        expect(paint.clearRect).toHaveBeenCalled();
        expect(frames.size).toBe(0);
      }
    });

    it("waits for ready data and coalesces invalidations", () => {
      chart.ready = false;
      render(Component);
      flushFrame();
      expect(frames.size).toBe(0);
      expect(seriesPaint.fillRect).not.toHaveBeenCalled();
      chart = { ...chart, ready: true };
      render(Component);
      chart = { ...chart, hovered: true };
      render(Component);
      expect(frames.size).toBe(1);
      flushFrame();
      expect(seriesPaint.fillRect).toHaveBeenCalled();
      expect(frames.size).toBe(0);
    });

    it("keeps animated charts running and cancels pending frames on unmount", () => {
      chart.animate = true;
      render(Component);
      flushFrame();
      expect(frames.size).toBe(1);
      effects.forEach((effect) => effect.cleanup?.());
      expect(frames.size).toBe(0);
    });

    it.each([false, true])("reuses the fill for cursor-only updates with animate=%s", (animate) => {
      chart = { ...chart, animate, hoverIndex: 1, isMouseInChart: true };
      render(Component);
      for (let frame = 0; frame < 100; frame++) flushFrame(1000 + frame * 16);
      seriesPaint.fillRect.mockClear();
      chart = { ...chart, cursorX: 20 };
      render(Component);
      flushFrame(2600);
      expect(seriesPaint.fillRect).not.toHaveBeenCalled();
      expect(frames.size).toBe(animate ? 1 : 0);
    });

    it("copies the newly painted canvas into the bloom layer", () => {
      chart.bloom = "low";
      render(Component);
      flushFrame();
      expect(bloomPaint.drawImage).toHaveBeenCalledWith(canvas, 0, 0);
      expect(seriesPaint.fillRect.mock.invocationCallOrder.at(-1)).toBeLessThan(
        bloomPaint.drawImage.mock.invocationCallOrder[0]!,
      );
      expect(frames.size).toBe(0);
    });

    it("honors reduced motion for animated charts", () => {
      chart.animate = true;
      vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
      render(Component);
      flushFrame();
      expect(seriesPaint.fillRect).toHaveBeenCalled();
      expect(frames.size).toBe(0);
    });
  });
}
