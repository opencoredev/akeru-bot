import { McpServerId, type AkeruToolInputSchemas } from "@akeru/contracts";
import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import { expect, it, vi } from "vite-plus/test";
import { createAkeruCatalogToolHandlers } from "./AkeruCatalogToolHandlers.ts";

describe("Akeru catalog MCP tool handlers", () => {
  it.each([
    "http://127.0.0.1:8080/",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "https://user:password@example.com/",
  ])("rejects unsafe WebFetch URL %s before the backend runs", async (url) => {
    const webFetch = vi.fn(async () => ({ text: "page" }));
    const handlers = createAkeruCatalogToolHandlers(undefined, undefined, undefined, { webFetch });
    await expect(handlers.WebFetch!({ input: { url }, emitProgress: vi.fn() })).rejects.toThrow();
    expect(webFetch).not.toHaveBeenCalled();
  });

  it("runs the M2-T6 backends and aliases image generation", async () => {
    const calls: string[] = [];

    const handlers = createAkeruCatalogToolHandlers(undefined, undefined, undefined, {
      webSearch: async (input) => {
        calls.push(`search:${input.query}`);

        return { results: [] };
      },
      webFetch: async (input) => {
        calls.push(`fetch:${input.url}`);

        return { text: "page" };
      },
      generateImage: async (input) => {
        calls.push(`image:${input.prompt}`);

        return { url: "https://img" };
      },
      addMcpServer: async (input) => {
        calls.push(`add:${input.serverId}`);

        return { added: true };
      },
      uninstallMcpServer: async (id) => {
        calls.push(`uninstall:${id}`);

        return { removed: true };
      },
      removeMcpAccount: async (id) => {
        calls.push(`remove:${id}`);

        return { removed: true };
      },
      renameMcpAccount: async () => {
        calls.push("rename");

        return { renamed: true };
      },
      setMcpInstructions: async () => {
        calls.push("instructions");

        return { saved: true };
      },
    });

    await handlers.WebSearch!({ input: { query: "akeru" }, emitProgress: vi.fn() });
    await handlers.WebFetch!({ input: { url: "https://example.com" }, emitProgress: vi.fn() });
    await handlers.GenerateImage!({
      input: { operation: "generate", prompt: "a cat" },
      emitProgress: vi.fn(),
    });

    const addMcpInput = {
      serverId: McpServerId.make("one"),
      name: "One",
      transport: "stdio",
      command: "example-mcp",
    } satisfies (typeof AkeruToolInputSchemas.AddMcpServer)["Type"];

    await handlers.AddMcpServer!({ input: addMcpInput, emitProgress: vi.fn() });
    await handlers.UninstallMcpServer!({ input: { serverId: "one" }, emitProgress: vi.fn() });
    await handlers.RemoveMcpAccount!({ input: { serverId: "one" }, emitProgress: vi.fn() });
    await handlers.RenameMcpAccount!({
      input: { serverId: "one", name: "two" },
      emitProgress: vi.fn(),
    });
    await handlers.SetMcpInstructions!({
      input: { serverId: "one", instructions: "keep safe" },
      emitProgress: vi.fn(),
    });
    expect(calls).toEqual([
      "search:akeru",
      "fetch:https://example.com/",
      "image:a cat",
      "add:one",
      "uninstall:one",
      "remove:one",
      "rename",
      "instructions",
    ]);
    await expect(
      handlers.UninstallMcpServer!({ input: {}, emitProgress: vi.fn() }),
    ).rejects.toThrow("serverId");
  });
});
