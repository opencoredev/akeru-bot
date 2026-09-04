import { describe, expect, it, vi } from "vite-plus/test";

import {
  akeruOpenCodeGoProvider,
  buildAkeruOpenCodeGoFetch,
  openCodeGoProtocol,
} from "./AkeruOpenCodeGoProvider.ts";

describe("AkeruOpenCodeGoProvider", () => {
  it.each(["responses", "anthropic", "chat-completions"] as const)(
    "routes %s to the custom endpoint",
    async (protocol) => {
      const request = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"),
      );
      await buildAkeruOpenCodeGoFetch(
        protocol,
        async () => "custom-key",
        request,
        () => "http://localhost:8080/v1",
      )("https://opencode.ai/zen/go/v1/messages", { method: "POST", body: "{}" });
      expect(request).toHaveBeenCalledWith(
        "http://localhost:8080/v1/messages",
        expect.objectContaining({ body: "{}", redirect: "error" }),
      );
      const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
      expect(headers.get(protocol === "anthropic" ? "x-api-key" : "authorization")).toBe(
        protocol === "anthropic" ? "custom-key" : "Bearer custom-key",
      );
    },
  );
  it("selects the protocol required by each model family", () => {
    expect(openCodeGoProtocol("gpt-5.6-luna")).toBe("responses");
    expect(openCodeGoProtocol("muse-spark-1.3-contributor")).toBe("responses");
    expect(openCodeGoProtocol("qwen3.8-max")).toBe("anthropic");
    expect(openCodeGoProtocol("deepseek-v4-pro")).toBe("chat-completions");
  });

  it("builds a model while keeping the OpenCode Go model id", () => {
    expect(akeruOpenCodeGoProvider("gpt-5.6-luna", async () => "go-key")).toMatchObject({
      modelId: "gpt-5.6-luna",
    });
  });

  it("uses the saved API key and removes stale auth headers", async () => {
    const request = vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer go-key");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("user-agent")).toBe("akeru-bot/0.0.37");
      expect(headers.get("x-opencode-client")).toBe("akeru-bot");
      return new Response("{}", { status: 200 });
    });

    await buildAkeruOpenCodeGoFetch(
      "chat-completions",
      async () => "go-key",
      request,
    )("https://opencode.ai/zen/go/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "stale", "x-api-key": "stale" },
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("fails closed when no API key is connected", async () => {
    const request = vi.fn();
    await expect(
      buildAkeruOpenCodeGoFetch(
        "chat-completions",
        async () => undefined,
        request,
      )("https://opencode.ai/zen/go/v1/chat/completions"),
    ).rejects.toThrow("not connected");
    expect(request).not.toHaveBeenCalled();
  });
});
