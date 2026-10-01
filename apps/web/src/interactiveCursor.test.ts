import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { readAppStyles } from "./styles.test-support";

describe("interactive pointer cursor", () => {
  it.effect("gives clickable controls a pointer cursor from the shared base rule", () =>
    Effect.gen(function* () {
      const css = yield* readAppStyles;
      const rule = css.match(
        /\/\* Clickable controls use the pointer cursor[\s\S]*?cursor:\s*pointer;/,
      )?.[0];

      expect(rule).toBeDefined();
      expect(rule).toContain(":where(");
      expect(rule).toContain("a[href]");
      expect(rule).toContain("button");
      expect(rule).toContain('[role="button"]');
      expect(rule).toContain('[role="tab"]');
      expect(rule).toContain('[role="option"]');
      expect(rule).toContain("summary");
      expect(rule).toContain("label");
      expect(rule).toContain(':not(:disabled, [aria-disabled="true"], [data-disabled])');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
