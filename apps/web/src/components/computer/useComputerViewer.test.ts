import { ComputerError } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/computer", () => ({ computerEnvironment: {} }));
vi.mock("~/state/environments", () => ({ useEnvironmentConnectionState: () => ({ data: null }) }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));

import {
  initialComputerViewerState,
  type ComputerViewerState,
} from "@akeru/client-runtime/state/computer-viewer";
import type { ComputerState } from "@akeru/contracts";

import { applyUnavailableRecheck, computerViewerOutcome } from "./useComputerViewer";

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

describe("applyUnavailableRecheck", () => {
  const unavailable = { status: "unavailable" } as ComputerState;
  const ready = { status: "ready" } as ComputerState;
  const controllerAt = (server: ComputerState) => {
    const state: ComputerViewerState = { ...initialComputerViewerState, server };
    return { getState: () => state, dispatch: vi.fn() };
  };

  it("applies a recheck while the computer is still unavailable", () => {
    const controller = controllerAt(unavailable);
    applyUnavailableRecheck(controller, ready);
    expect(controller.dispatch).toHaveBeenCalledWith({ type: "server-state", state: ready });
  });

  it("ignores a late recheck once the computer has appeared", () => {
    const controller = controllerAt(ready);
    applyUnavailableRecheck(controller, unavailable);
    expect(controller.dispatch).not.toHaveBeenCalled();
  });
});
