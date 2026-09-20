import { describe, expect, it, vi } from "vite-plus/test";

import {
  AKERU_PREVIEW_TOOL_IDS,
  createPreviewToolHandlers,
  isPreviewToolId,
  normalizePreviewOpenInput,
  preparePreviewToolInvocation,
} from "./PreviewToolHandlers.ts";

describe("PreviewToolHandlers", () => {
  it("recognizes every collaborative browser tool id", () => {
    expect(AKERU_PREVIEW_TOOL_IDS).toContain("preview_status");
    expect(AKERU_PREVIEW_TOOL_IDS).toContain("preview_snapshot");
    expect(isPreviewToolId("preview_open")).toBe(true);
    expect(isPreviewToolId("memory")).toBe(false);
    expect(isPreviewToolId("Shell")).toBe(false);
  });

  it("leaves an unstated visibility for the client preference to decide", () => {
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });

  it("maps each preview tool onto one broker operation", () => {
    expect(preparePreviewToolInvocation("preview_status", { tabId: "tab-1" })).toMatchObject({
      operation: "status",
      tabId: "tab-1",
      emptyResult: false,
    });
    expect(
      preparePreviewToolInvocation("preview_navigate", {
        url: "https://example.com",
        timeoutMs: 12_000,
      }),
    ).toMatchObject({
      operation: "navigate",
      timeoutMs: 12_000,
      input: { url: "https://example.com", timeoutMs: 12_000 },
    });
    expect(
      preparePreviewToolInvocation("preview_snapshot", { includeImage: false, tabId: "tab-2" }),
    ).toEqual({
      operation: "snapshot",
      input: {},
      tabId: "tab-2",
      emptyResult: false,
      nullishEvaluate: false,
    });
    expect(preparePreviewToolInvocation("preview_click", { locator: "role=button" })).toMatchObject({
      operation: "click",
      emptyResult: true,
    });
    expect(preparePreviewToolInvocation("preview_evaluate", { expression: "1+1" })).toMatchObject({
      operation: "evaluate",
      nullishEvaluate: true,
    });
  });

  it("invokes the broker and normalizes empty and evaluate results", async () => {
    const invoke = vi.fn(async ({ operation }: { readonly operation: string }) => {
      if (operation === "evaluate") return undefined;
      if (operation === "status") return { available: true };
      return { ok: true };
    });
    const handlers = createPreviewToolHandlers(invoke);

    await expect(
      handlers.preview_status({
        threadId: "thread-1",
        toolId: "preview_status",
        toolCallId: "call-1",
        input: {},
        approvalMode: "require-grant",
      }),
    ).resolves.toEqual({ available: true });
    await expect(
      handlers.preview_click({
        threadId: "thread-1",
        toolId: "preview_click",
        toolCallId: "call-2",
        input: { locator: "role=button[name='Go']" },
        approvalMode: "require-grant",
      }),
    ).resolves.toEqual({});
    await expect(
      handlers.preview_evaluate({
        threadId: "thread-1",
        toolId: "preview_evaluate",
        toolCallId: "call-3",
        input: { expression: "document.title" },
        approvalMode: "require-grant",
      }),
    ).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
