import { describe, expect, it, vi } from "vite-plus/test";

import { akeruKimiProvider, buildAkeruKimiFetch } from "./AkeruKimiProvider.ts";

const access = {
  accessToken: "kimi-access",
  deviceId: "0123456789abcdef0123456789abcdef",
};

describe("AkeruKimiProvider", () => {
  it("uses API keys and custom endpoints without OAuth device headers", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"),
    );
    const fetch = buildAkeruKimiFetch(
      async () => ({ accessToken: "api-key", baseUrl: "https://proxy.example/v1" }),
      request,
    );
    await fetch("https://api.kimi.com/coding/v1/messages?beta=true", {
      method: "POST",
      body: "{}",
    });
    expect(request).toHaveBeenCalledWith(
      "https://proxy.example/v1/messages?beta=true",
      expect.objectContaining({ method: "POST", body: "{}", redirect: "error" }),
    );
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer api-key");
    expect(headers.get("x-msh-device-id")).toBeNull();
  });
  it("builds the Kimi Anthropic model without changing the saved model", () => {
    expect(akeruKimiProvider("k3-256k", async () => access)).toMatchObject({
      provider: "anthropic.messages",
      modelId: "k3-256k",
    });
  });

  it("uses the saved OAuth token and device identity for every request", async () => {
    const request = vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer kimi-access");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("x-msh-device-id")).toBe(access.deviceId);
      expect(headers.get("x-msh-platform")).toBe("akeru");
      expect(headers.get("x-msh-version")).toBe("0.0.34");
      return new Response("{}", { status: 200 });
    });
    const fetch = buildAkeruKimiFetch(async () => access, request);

    await fetch("https://api.kimi.com/coding/v1/messages", {
      method: "POST",
      headers: { Authorization: "stale", "x-api-key": "stale" },
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("fails closed when the account or device identity is unavailable", async () => {
    const request = vi.fn();
    await expect(
      buildAkeruKimiFetch(
        async () => undefined,
        request,
      )("https://api.kimi.com/coding/v1/messages"),
    ).rejects.toThrow("not connected");
    await expect(
      buildAkeruKimiFetch(
        async () => ({ accessToken: "token", deviceId: "invalid" }),
        request,
      )("https://api.kimi.com/coding/v1/messages"),
    ).rejects.toThrow("Invalid Kimi For Coding device id");
    expect(request).not.toHaveBeenCalled();
  });
});
