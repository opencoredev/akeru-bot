import { ComputerError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/computer", () => ({ computerEnvironment: {} }));
vi.mock("~/state/environments", () => ({ useEnvironmentConnectionState: () => ({ data: null }) }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));

import { computerViewerOutcome } from "./useComputerViewer";

describe("computerViewerOutcome", () => {
  it("passes values through and keeps the server's error code", () => {
    expect(computerViewerOutcome(AsyncResult.success(1))).toEqual({ ok: true, value: 1 });
    expect(
      computerViewerOutcome(
        AsyncResult.failure(
          Cause.fail(new ComputerError({ code: "busy", message: "Someone else has control." })),
        ),
      ),
    ).toEqual({ ok: false, code: "busy" });
  });

  it("treats any other failure as an adapter failure", () => {
    expect(computerViewerOutcome(AsyncResult.failure(Cause.fail(new Error("boom"))))).toEqual({
      ok: false,
      code: "adapter",
    });
  });
});
