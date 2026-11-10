import type { AkeruRemoteSession, AkeruSandboxFiles } from "../botWorkspace.ts";

const unexpected = (): Promise<never> =>
  Promise.reject(new Error("Unexpected sandbox file call in a lifecycle test."));

/** Sessions in lifecycle tests never touch files; any call is a test bug. */
export const unusedSandboxFiles: AkeruSandboxFiles = {
  read: unexpected,
  write: unexpected,
  list: unexpected,
  stat: unexpected,
  exists: unexpected,
  remove: unexpected,
};

export function makebotWorkspaceTestSupport() {
  function remoteSession(providerId: string): AkeruRemoteSession {
    return {
      providerId,
      files: unusedSandboxFiles,
      inspect: async () => "running",
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      browserEndpoint: async () => ({ url: "https://browser.example", requestHeaders: {} }),
      wake: async () => undefined,
      sleep: async () => undefined,
      destroy: async () => undefined,
    };
  }

  return { remoteSession };
}
