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
    expect(AKERU_TOOL_CATALOG.find((tool) => tool.id === "InstallPlugin")?.approval).toBe(
      "production",
    );
  });

  it("hides SendToAgent at delegation limits", () => {
    const context = {
      capabilities: new Set(["bot-workspace"] as const),
      workspaceType: "local" as const,
      hasUserComputer: false,
      localFullAccess: false,
      implementedTools: new Set(["SendToAgent"]),
    };

    expect(
      filterAkeruTools({ ...context, delegationDepth: 1, activeDelegations: 2 }).map(
        (tool) => tool.id,
      ),
    ).toEqual(["SendToAgent"]);
    expect(filterAkeruTools({ ...context, delegationDepth: 2, activeDelegations: 2 })).toEqual([]);
    expect(filterAkeruTools({ ...context, delegationDepth: 1, activeDelegations: 3 })).toEqual([]);
  });

  it("decodes the approval limit and keeps escalation fields server-owned", () => {
    const input = {
      botId: "bot-research",
      task: "Compare three flights.",
      expectedResult: "A short comparison with sources.",
      approvalCeiling: "send" as const,
    };

    expect(decodeAkeruToolInput("SendToAgent", input)).toMatchObject(input);
    expect(() => decodeAkeruToolInput("SendToAgent", { ...input, depth: 2 })).toThrow();
    expect(() =>
      decodeAkeruToolInput("SendToAgent", {
        ...input,
        hasUserComputer: true,
      }),
    ).toThrow();
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
