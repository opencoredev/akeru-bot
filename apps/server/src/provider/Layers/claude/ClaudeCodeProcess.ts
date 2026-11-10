import * as NodeChildProcess from "node:child_process";

import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import { type ClaudeQueryRuntime } from "./ClaudeAdapterState.ts";

/** Spawns Claude Code with the same process options as the SDK's default. */
export const spawnClaudeCodeLocally = (options: SpawnOptions): SpawnedProcess =>
  NodeChildProcess.spawn(options.command, options.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });

/** Resolves when `process` exits, or when it fails before it ever started. */
function processExit(process: SpawnedProcess): Promise<void> {
  return new Promise((resolve) => {
    if (process.exitCode !== null) {
      resolve();

      return;
    }

    process.once("exit", () => resolve());
    // A process that never started emits no exit event.
    process.once("error", () => {
      if (!("pid" in process) || process.pid === undefined) resolve();
    });
  });
}

/**
 * Starts a Claude Code query whose `waitForExit` resolves once its process
 * has ended. The SDK's `close()` finishes the message stream while the
 * process can still be running a command, so a session stop waits on it
 * before anything replaces the session.
 */
export function createClaudeCodeQuery(input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: ClaudeQueryOptions;
  /** Replaces the local spawn, for tests. */
  readonly spawnProcess?: (options: SpawnOptions) => SpawnedProcess;
}): ClaudeQueryRuntime {
  const spawnProcess = input.spawnProcess ?? spawnClaudeCodeLocally;
  let exited: Promise<void> = Promise.resolve();

  const sdkQuery = query({
    prompt: input.prompt,
    options: {
      ...input.options,
      spawnClaudeCodeProcess: (options) => {
        const process = spawnProcess(options);
        exited = processExit(process);

        return process;
      },
    },
  });

  return {
    setModel: (model) => sdkQuery.setModel(model),
    setPermissionMode: (mode) => sdkQuery.setPermissionMode(mode),
    setMaxThinkingTokens: (maxThinkingTokens) => sdkQuery.setMaxThinkingTokens(maxThinkingTokens),
    interrupt: () => sdkQuery.interrupt(),
    close: () => sdkQuery.close(),
    waitForExit: () => exited,
    [Symbol.asyncIterator]: () => sdkQuery[Symbol.asyncIterator](),
  };
}
