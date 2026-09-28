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
});
