import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { vi } from "vite-plus/test";
import type { AkeruBotWorkspace } from "../botWorkspace.ts";

export function makebotWorkspacePoolTestSupport() {
  const localWorkspace = () =>
    new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });

  function remoteWorkspace(overrides: Partial<AkeruBotWorkspace> = {}): AkeruBotWorkspace {
    return {
      id: "akeru-persistent",
      provider: "tenki",
      workspace: localWorkspace(),
      inspect: vi.fn(async () => "running" as const),
      wake: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  return { localWorkspace, remoteWorkspace };
}
