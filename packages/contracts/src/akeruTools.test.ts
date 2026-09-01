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
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "AuthenticateMcpServer")?.approval).toBe(
      "secrets",
    );
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "RestartMcpServers")?.approval).toBe(
      "production",
    );
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "GetMcpServerStatus")?.approval).toBe(
      "none",
    );
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "TestMcpServer")?.approval).toBe("none");
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "ReconnectMcpServer")?.approval).toBe(
      "production",
    );
  });

  it("decodes SendToAgent input and rejects server-owned fields", () => {
    const input = {
      botId: "bot-research",
      task: "Compare three flights.",
      expectedResult: "A short comparison with sources.",
    };

    expect(decodeAkeruToolInput("SendToAgent", input)).toEqual(input);
    expect(() => decodeAkeruToolInput("SendToAgent", { ...input, depth: 2 })).toThrow();
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "SendToAgent")?.approval).toBe("send");
  });

  it("decodes SendToUser input and keeps it approval-gated", () => {
    expect(decodeAkeruToolInput("SendToUser", { message: "The export is ready." })).toEqual({
      message: "The export is ready.",
    });
    expect(() => decodeAkeruToolInput("SendToUser", { message: "" })).toThrow();
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "SendToUser")?.approval).toBe("send");
  });

  it("never lets full access bypass protected commands or paths", () => {
    const shell = AKERU_TOOL_CATALOG.find((tool) => tool.id === "ExternalShell")!;
    const read = AKERU_TOOL_CATALOG.find((tool) => tool.id === "ExternalRead")!;
    const copyFromBox = AKERU_TOOL_CATALOG.find((tool) => tool.id === "CopyFromBox")!;
    const copyInput = {
      sourcePath: "/project/.env",
      destinationPath: "/tmp/exported-env",
    };
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
    expect(akeruToolApprovalForInput(copyFromBox, copyInput)).toBe("secrets");
    expect(akeruToolRequiresApproval(copyFromBox, { localFullAccess: true }, copyInput)).toBe(true);
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
