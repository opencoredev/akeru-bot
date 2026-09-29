import { describe, expect, it } from "vite-plus/test";
import { WorkspaceComputer } from "./workspaceComputer.ts";

describe("WorkspaceComputer", () => {
  it("initializes the desktop before a human capture", async () => {
    const calls: string[] = [];
    const computer = new WorkspaceComputer(
      "workspace",
      {
        open: async () => {
          calls.push("desktop.open");
        },
        input: async () => undefined,
        capture: async () => ({ mimeType: "image/png", data: "Zg==", width: 1, height: 1 }),
      },
      async () => {
        calls.push("launch");
      },
      async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
      async () => "running",
    );
    await computer.open();
    await computer.capture();
    expect(calls).toEqual(["desktop.open", "launch"]);
  });

  it("drops input whose control was revoked during workspace inspection", async () => {
    const inputs: unknown[] = [];
    let finishInspection = () => {};
    let pauseInspection = false;
    const computer = new WorkspaceComputer(
      "workspace",
      {
        open: async () => undefined,
        input: async (action) => {
          inputs.push(action);
        },
        capture: async () => ({ mimeType: "image/png", data: "Zg==", width: 1, height: 1 }),
      },
      async () => undefined,
      async () => ({ url: "http://127.0.0.1:9222", requestHeaders: {} }),
      async () => {
        if (pauseInspection) await new Promise<void>((resolve) => (finishInspection = resolve));
        return "running";
      },
    );
    await computer.open();
    pauseInspection = true;
    const pending = computer.input({ _tag: "click", x: 1, y: 1, button: "left" });
    await Promise.resolve();
    computer.gate.stop();
    finishInspection();
    await expect(pending).rejects.toMatchObject({ code: "revoked" });
    expect(inputs).toEqual([]);
  });
});
