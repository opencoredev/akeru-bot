import { createAkeruToolRuntime, type AkeruToolRuntime } from "../AkeruToolRuntime.ts";

/** Override the behavior a test observes while retaining the complete runtime contract. */
export function toolRuntimeFixture(overrides: Partial<AkeruToolRuntime> = {}): AkeruToolRuntime {
  return { ...createAkeruToolRuntime(), ...overrides };
}
