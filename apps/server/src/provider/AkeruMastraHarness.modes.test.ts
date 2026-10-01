// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { makeAkeruMastraHarnessTestSupport } from "./test-support/AkeruMastraHarness.ts";

const { harnessTest, makeObservationHarness } = makeAkeruMastraHarnessTestSupport();

describe("AkeruMastraHarness legacy modes", () => {
  it.effect("accepts legacy plan mode when starting a session", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-plan-start-"));
      const harness = await makeObservationHarness(open, directory);

      try {
        await harness.controller.init();

        const session = await harness.controller.createSession({
          resourceId: "plan-start",
          threadId: "plan-start",
        });

        expect(session.mode.get()).toBe("build");
        await session.mode.switch({ modeId: "plan" });
        expect(session.mode.get()).toBe("plan");
      } finally {
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("accepts legacy plan mode on an active session and returns to build", () =>
    harnessTest(async (open) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-plan-active-"));
      const harness = await makeObservationHarness(open, directory);

      try {
        await harness.controller.init();

        const session = await harness.controller.createSession({
          resourceId: "plan-active",
          threadId: "plan-active",
        });

        await session.state.set({ projectPath: directory, yolo: false });
        await session.model.switch({ modelId: "openai/gpt-5.6-sol" });
        await session.mode.switch({ modeId: "plan" });
        expect(session.mode.get()).toBe("plan");
        await session.mode.switch({ modeId: "build" });
        expect(session.mode.get()).toBe("build");
      } finally {
        await harness.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );
});
