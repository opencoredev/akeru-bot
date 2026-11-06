import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { createClaudeCodeQuery, spawnClaudeCodeLocally } from "./ClaudeCodeProcess.ts";

// Stands in for Claude Code: it keeps running briefly after its input closes.
const LINGERING_PROCESS = [
  "process.stdin.resume();",
  "process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));",
].join(" ");

describe("createClaudeCodeQuery", () => {
  it("waits for the Claude Code process to exit after close", async () => {
    const spawned: SpawnedProcess[] = [];

    const query = createClaudeCodeQuery({
      prompt: (async function* () {})(),
      options: { pathToClaudeCodeExecutable: "/opt/claude/bin/claude", env: {} },
      spawnProcess: (options) => {
        const child = spawnClaudeCodeLocally({
          ...options,
          command: process.execPath,
          args: ["-e", LINGERING_PROCESS],
        });

        spawned.push(child);

        return child;
      },
    });

    const firstMessage = query[Symbol.asyncIterator]().next();
    query.close();
    await firstMessage.catch(() => undefined);
    await query.waitForExit();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.exitCode).toBe(0);
  });
});
