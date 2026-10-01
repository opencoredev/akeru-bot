import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { RequestContext } from "@mastra/core/request-context";
import { ProviderDriverKind } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import { it } from "@effect/vitest";
import { assert, expect, vi } from "vite-plus/test";
import {
  createAkeruAgentInstructions,
  createAkeruBotInstructions,
} from "./AkeruAgentInstructions.ts";
import {
  mastraModelId,
  resolveAkeruInstructions,
  resolveAkeruMastraModel,
  withAkeruModelRunOptions,
} from "./AkeruMastraHarness.ts";

describe("AkeruMastraHarness", () => {
  it("routes Codex API keys through OpenAI Responses instead of the OAuth transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-api-key-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "key",
      baseUrl: "https://proxy.example/v1",
    }));
    expect(
      resolveAkeruMastraModel(
        "openai/gpt-5.6",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
      ),
    ).toMatchObject({ modelId: "gpt-5.6", provider: "openai.responses" });
    expect(getCredential).toHaveBeenCalledWith("openai-codex");
  });

  it("uses the selected instance key without reading the provider-wide credential", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-instance-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "provider-wide-key",
    }));
    expect(
      resolveAkeruMastraModel(
        "xai/grok-code-fast-1",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
        {
          environment: {
            XAI_API_KEY: "instance-key",
            XAI_BASE_URL: "https://instance.example/v1",
          },
          instanceEnvironment: {
            XAI_API_KEY: "instance-key",
            XAI_BASE_URL: "https://instance.example/v1",
          },
          useSavedCredential: false,
        },
      ),
    ).toMatchObject({ modelId: "grok-code-fast-1", provider: "xai.chat" });
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("resolves a saved API key for the selected account instance", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-bound-auth.json");
    const getCredential = vi.fn((_provider: string, instanceId?: string) =>
      instanceId === "grok_work" ? { type: "api-key" as const, access: "work-key" } : undefined,
    );
    expect(
      resolveAkeruMastraModel(
        "xai/grok-code-fast-1",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
        {
          environment: {},
          instanceEnvironment: {},
          useSavedCredential: true,
          instanceId: "grok_work",
        },
      ),
    ).toMatchObject({ modelId: "grok-code-fast-1", provider: "xai.chat" });
    expect(getCredential).toHaveBeenCalledWith("xai", "grok_work");
  });

  it("does not leak provider-wide credentials into an isolated instance", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-isolated-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "provider-wide-key",
    }));
    assert.throws(
      () =>
        resolveAkeruMastraModel(
          "anthropic/claude-fable-5",
          authStorage,
          undefined,
          undefined,
          undefined,
          getCredential,
          { environment: {}, instanceEnvironment: {}, useSavedCredential: false },
        ),
      "has no API key or auth token transport",
    );
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("keeps Kimi model names on the Kimi subscription transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-auth.json");
    assert.equal(
      mastraModelId(ProviderDriverKind.make("kimi"), "k3-256k"),
      "kimi-for-coding/k3-256k",
    );
    assert.deepInclude(
      resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage, async () => ({
        accessToken: "kimi-access",
        deviceId: "0123456789abcdef0123456789abcdef",
      })),
      { provider: "anthropic.messages", modelId: "k3-256k" },
    );
    assert.throws(
      () => resolveAkeruMastraModel("kimi-for-coding/k3-256k", authStorage),
      "subscription access is unavailable",
    );
  });

  it("keeps OpenCode Go model names on the direct subscription transport", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-auth.json");
    assert.equal(
      mastraModelId(ProviderDriverKind.make("opencodeGo"), "gpt-5.6-luna"),
      "opencode-go/gpt-5.6-luna",
    );
    assert.deepInclude(
      resolveAkeruMastraModel(
        "opencode-go/gpt-5.6-luna",
        authStorage,
        undefined,
        async () => "go-key",
      ),
      { provider: "opencode-go.responses", modelId: "gpt-5.6-luna" },
    );
    assert.throws(
      () => resolveAkeruMastraModel("opencode-go/gpt-5.6-luna", authStorage),
      "subscription access is unavailable",
    );
  });

  it("uses an isolated OpenCode Go inline connection", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-inline-opencode-auth.json");
    const getCredential = vi.fn(() => ({
      type: "api-key" as const,
      access: "provider-wide-key",
    }));
    const environment = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          "opencode-go": {
            options: { apiKey: "inline-key", baseURL: "https://inline.example/v1" },
          },
        },
      }),
    };
    assert.deepInclude(
      resolveAkeruMastraModel(
        "opencode-go/gpt-5.6-luna",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
        { environment, instanceEnvironment: environment, useSavedCredential: false },
      ),
      { provider: "opencode-go.responses", modelId: "gpt-5.6-luna" },
    );
    expect(getCredential).not.toHaveBeenCalled();
  });

  it("routes Claude and Grok models through their subscription transports", () => {
    const authStorage = new AuthStorage("/tmp/akeru-unused-legacy-observer-auth.json");
    const getCredential = vi.fn((provider: string) =>
      provider === "anthropic"
        ? { type: "api-key" as const, access: "claude-key" }
        : { type: "api-key" as const, access: "grok-key" },
    );

    assert.equal(
      mastraModelId(ProviderDriverKind.make("claudeAgent"), "claude-sonnet-4-5"),
      "anthropic/claude-sonnet-4-5",
    );
    assert.deepInclude(
      resolveAkeruMastraModel(
        "anthropic/claude-sonnet-4-5",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
      ),
      { provider: "anthropic.messages", modelId: "claude-sonnet-4-5" },
    );
    assert.equal(mastraModelId(ProviderDriverKind.make("grok"), "grok-4"), "xai/grok-4");
    assert.deepInclude(
      resolveAkeruMastraModel(
        "xai/grok-4",
        authStorage,
        undefined,
        undefined,
        undefined,
        getCredential,
      ),
      { provider: "xai.chat", modelId: "grok-4" },
    );
  });

  it("builds a compact, human prompt with the bot name and current date", () => {
    const instructions = createAkeruAgentInstructions({
      name: "  Research\nBot  ",
      now: DateTime.makeUnsafe("2026-09-02T12:00:00.000Z"),
    });

    assert.include(instructions, "You are Research Bot, a sharp, curious general assistant");
    assert.include(instructions, "Today is Wednesday, September 2, 2026");
    assert.include(instructions, "Write with judgment");
    assert.include(instructions, "Before sending, cut filler");
    assert.include(instructions, "Name every drawback");
    assert.include(instructions, "Never use em or en dashes");
    assert.include(instructions, "enabled plugins");
    assert.include(instructions, "Prefer preview_* tools over browser_* tools");
    assert.include(instructions, "Own the requested outcome");
    assert.include(instructions, "Carry multi-step work through implementation");
    assert.include(instructions, "Never report success before");
    assert.include(instructions, "akeru_list_routines");
    assert.notInclude(instructions, "—");
    assert.notInclude(instructions, "coding agent");
    assert.isBelow(createAkeruBotInstructions({ now: DateTime.nowUnsafe() }).length, 3_500);
  });

  it("passes the saved Codex service tier to Mastra provider options", () => {
    expect(
      withAkeruModelRunOptions(
        { providerOptions: { anthropic: { fallback: true }, openai: { store: false } } },
        { modelOptions: { serviceTier: "priority" } },
      ),
    ).toEqual({
      providerOptions: {
        anthropic: { fallback: true },
        openai: { store: false, serviceTier: "priority" },
      },
    });
  });

  it("adds reply and status rules only to bot conversations", () => {
    const now = DateTime.makeUnsafe("2026-09-02T12:00:00.000Z");
    const regular = new RequestContext();
    regular.setRaw("controller", { state: { botConversation: false } });
    const bot = new RequestContext();
    bot.setRaw("controller", {
      state: { botConversation: true, botName: "Mina", personalityTone: 20 },
    });

    assert.equal(resolveAkeruInstructions(regular, now), createAkeruAgentInstructions({ now }));
    assert.equal(
      resolveAkeruInstructions(bot, now),
      createAkeruBotInstructions({ name: "Mina", now, personalityTone: 20 }),
    );
    assert.include(resolveAkeruInstructions(bot, now), "You are Mina");
    assert.include(resolveAkeruInstructions(bot, now), "20/100, a 80% chill");
    assert.include(resolveAkeruInstructions(bot, now), "Before you use a tool");
    assert.include(resolveAkeruInstructions(bot, now), "automatic continuation");
  });

  it("appends saved MCP server guidance to the system prompt", () => {
    const now = DateTime.makeUnsafe("2026-09-02T12:00:00.000Z");
    const context = new RequestContext();
    context.setRaw("controller", {
      state: {
        botConversation: false,
        mcpInstructions: "MCP server guidance:\n- Docs (docs): Search first.",
      },
    });

    assert.equal(
      resolveAkeruInstructions(context, now),
      `${createAkeruAgentInstructions({ now })}\n\nMCP server guidance:\n- Docs (docs): Search first.`,
    );
  });
});
