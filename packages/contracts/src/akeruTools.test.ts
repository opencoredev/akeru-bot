import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AKERU_TOOL_CATALOG,
  AkeruToolReceipt,
  akeruToolApprovalForInput,
  akeruToolRequiresApproval,
  copyDirectionForTool,
  decodeAkeruToolInput,
  filterAkeruTools,
} from "./akeruTools.ts";

describe("Akeru tool contracts", () => {
  it("validates copy direction and rejects incomplete input", () => {
    expect(copyDirectionForTool("CopyToBox")).toEqual({
      from: "user-computer",
      to: "bot-workspace",
    });
    expect(copyDirectionForTool("CopyFromBox")).toEqual({
      from: "bot-workspace",
      to: "user-computer",
    });
    expect(() => decodeAkeruToolInput("CopyToBox", { path: "/tmp/report" })).toThrow();
  });

  it("only returns implemented tools for available computer boundaries", () => {
    expect(
      filterAkeruTools({
        capabilities: new Set(["bot-workspace", "user-computer"]),
        workspaceType: "local",
        hasUserComputer: false,
        localFullAccess: false,
        implementedTools: new Set(["Shell", "ExternalShell", "CopyToBox"]),
      }).map((tool) => tool.id),
    ).toEqual(["Shell"]);
    expect(AKERU_TOOL_CATALOG.map((tool) => tool.id)).not.toContain("RestartMcpServers");
  });

  it("never lets full access bypass protected commands or paths", () => {
    const shell = AKERU_TOOL_CATALOG.find((tool) => tool.id === "ExternalShell")!;
    const read = AKERU_TOOL_CATALOG.find((tool) => tool.id === "ExternalRead")!;
    expect(akeruToolApprovalForInput(shell, { command: "git push origin main" })).toBe(
      "production",
    );
    expect(
      akeruToolRequiresApproval(
        shell,
        { localFullAccess: true },
        { command: "git push origin main" },
      ),
    ).toBe(true);
    expect(
      akeruToolRequiresApproval(read, { localFullAccess: true }, { path: "/project/.env" }),
    ).toBe(true);
  });

  it("decodes non-fatal typed receipts", () => {
    const decode = Schema.decodeUnknownSync(AkeruToolReceipt);
    expect(
      decode({
        receiptId: "receipt-1",
        toolId: "Shell",
        phase: "failure",
        threadId: "thread-1",
        createdAt: "2026-08-31T00:00:00.000Z",
      }),
    ).toMatchObject({ fatalToThread: false });
    expect(() =>
      decode({
        receiptId: "receipt-2",
        toolId: "Shell",
        phase: "failure",
        threadId: "thread-1",
        fatalToThread: true,
        createdAt: "2026-08-31T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
