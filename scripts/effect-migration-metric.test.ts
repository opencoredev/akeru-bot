import { describe, expect, it } from "vite-plus/test";

import { countSource } from "./effect-migration-metric.js";

describe("effect migration metric counting", () => {
  it("counts runtime escapes and Promise bridges", () => {
    const metric = countSource(`
      Effect.runPromise(program)
      Effect.runFork(other)
      Effect.tryPromise(task)
    `);

    expect(metric).toEqual({ runtimeEscapes: 2, promiseBridges: 1 });
  });
});
