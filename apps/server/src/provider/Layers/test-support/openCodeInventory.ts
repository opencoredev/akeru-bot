import type { Model } from "@opencode-ai/sdk/v2";
import type { OpenCodeInventory } from "../../opencodeRuntime.ts";

export const emptyOpenCodeInventory = (): OpenCodeInventory => ({
  providerList: { connected: [], all: [], default: {} },
  agents: [],
  skills: [],
});

export function openCodeModelFixture(input: Pick<Model, "id" | "name"> & Partial<Model>): Model {
  return {
    providerID: "openai",
    api: { id: input.id, url: "https://api.example.com", npm: "@ai-sdk/openai" },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    ...input,
  };
}
