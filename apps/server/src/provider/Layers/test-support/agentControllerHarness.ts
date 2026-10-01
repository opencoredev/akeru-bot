import type { AkeruMastraHarness } from "../../AkeruMastraHarness.ts";
import { sessionFixture } from "./partialFixtures.ts";
import type { AkeruMastraState } from "../../AkeruMastraHarness.ts";

import type { AgentControllerEvent, MastraDBMessage } from "@mastra/core/agent-controller";
import { McpServerId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { type AgentControllerLiveOptions } from "../AgentController.ts";
import { codexThreadId } from "./agentControllerFixtures.ts";

export const computerUseToolName = "builtin-computer-use_control";

export function computerUseServer() {
  return {
    id: McpServerId.make("builtin-computer-use"),
    name: "Codex Computer Use",
    transport: "stdio" as const,
    command: "akeru-codex-computer-use",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function computerUseMcpManager() {
  return {
    init: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getTools: vi.fn(() => ({
      [computerUseToolName]: { execute: vi.fn(async () => ({})) },
    })),
    getServerStatuses: vi.fn(() => [
      {
        name: "builtin-computer-use",
        connected: true,
        toolCount: 1,
        toolNames: [computerUseToolName],
        transport: "stdio" as const,
      },
    ]),
  };
}

export function mastraHarnessFixture() {
  const harnessOptions: Array<
    Parameters<NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>>[0]
  > = [];

  const listeners = new Set<(event: AgentControllerEvent) => void>();
  let modeId = "build";
  let modelId = "openai/gpt-5.6-sol";
  let state: AkeruMastraState = {};
  let resolveSend: (() => void) | undefined;
  const rejectSends: Array<(cause: unknown) => void> = [];
  let sendMessageCount = 0;
  const sendMessageWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  const sendMessage = vi.fn(() => {
    sendMessageCount += 1;

    for (const waiter of sendMessageWaiters.splice(0)) {
      if (sendMessageCount >= waiter.count) waiter.resolve();
      else sendMessageWaiters.push(waiter);
    }

    return new Promise<void>((resolve, reject) => {
      resolveSend = resolve;
      rejectSends.push(reject);
    });
  });

  const session = sessionFixture({
    state: {
      get: () => state,
      set: vi.fn(async (next: AkeruMastraState) => {
        state = next;
      }),
    },
    mode: {
      get: () => modeId,
      switch: vi.fn(async ({ modeId: next }: { readonly modeId: string }) => {
        modeId = next;
      }),
    },
    model: {
      get: () => modelId,
      switch: vi.fn(async ({ modelId: next }: { readonly modelId: string }) => {
        modelId = next;
      }),
    },
    permissions: {
      setForCategory: vi.fn(async () => undefined),
      setForTool: vi.fn(async () => undefined),
    },
    grantTool: vi.fn(),
    subscribe: vi.fn((listener: (event: AgentControllerEvent) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    }),
    sendMessage,
    abort: vi.fn(),
    respondToToolApproval: vi.fn(),
    respondToToolSuspension: vi.fn(async () => undefined),
  });

  const createSession = vi.fn(async <Input>(_input: Input) => session as never);
  const deleteSession = vi.fn(async () => true);

  const observeExternalTurn = vi.fn(
    async (_input: Parameters<NonNullable<AkeruMastraHarness["observeExternalTurn"]>>[0]) =>
      undefined,
  );

  const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = (options) =>
    Effect.sync(() => {
      harnessOptions.push(options);

      return {
        controller: {
          init: vi.fn(async () => undefined),
          createSession,
          deleteSession,
        },
        observeExternalTurn,
      };
    });

  const emit = (event: AgentControllerEvent) => {
    for (const listener of listeners) listener(event);
  };

  return {
    factory,
    harnessOptions,
    session,
    createSession,
    deleteSession,
    sendMessage,
    observeExternalTurn,
    emit,
    waitForSendMessageCount: (count: number) =>
      sendMessageCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => sendMessageWaiters.push({ count, resolve })),
    finishSend: () => resolveSend?.(),
    rejectSend: (index: number, cause: unknown) => rejectSends[index]?.(cause),
    failSend: (cause: unknown) => rejectSends.at(-1)?.(cause),
  };
}

export function assistantMessage(text: string, id = "assistant-message"): MastraDBMessage {
  return {
    id,
    role: "assistant",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    content: {
      format: 2,
      parts: [{ type: "text", text }],
    },
    threadId: String(codexThreadId),
    resourceId: String(codexThreadId),
  } as MastraDBMessage;
}
