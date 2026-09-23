import { describe, expect, it } from "vite-plus/test"

import { countSource } from "./effect-migration-metric"

describe("effect migration metric counting", () => {
  it("counts call sites and every rule in file and next-line directives", () => {
    const metric = countSource(`
      // @effect-diagnostics nodeBuiltinImport:off globalDate:off
      Effect.runPromise(program)
      // @effect-diagnostics-next-line preferSchemaOverJson:off - test fixture
      Effect.tryPromise(task)
    `)

    expect(metric.runtimeEscapes).toBe(1)
    expect(metric.promiseBridges).toBe(1)
    expect(Object.fromEntries(metric.suppressions)).toEqual({
      globalDate: 1,
      nodeBuiltinImport: 1,
      preferSchemaOverJson: 1,
    })
  })
})
