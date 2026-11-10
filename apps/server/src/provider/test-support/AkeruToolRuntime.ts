import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import type { AkeruToolRuntime } from "../tools/AkeruToolTypes.ts";

export function makeAkeruToolRuntimeTestSupport() {
  const directories = new Set<string>();

  const workspaceRoots = new WeakMap<Workspace, string>();

  function workspace(name: string) {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `akeru-tool-${name}-`));
    const root = NodePath.join(directory, "workspace");
    NodeFS.mkdirSync(root);
    directories.add(directory);

    const value = new Workspace({
      filesystem: new LocalFilesystem({ basePath: root }),
      sandbox: new LocalSandbox({ workingDirectory: root }),
    });

    workspaceRoots.set(value, root);

    return value;
  }

  function workspaceRoot(value: Workspace) {
    const root = workspaceRoots.get(value);

    if (!root) throw new Error("Workspace root is unavailable.");

    return root;
  }

  return { directories, workspaceRoots, workspace, workspaceRoot };
}

/** The owner's path: the controller opens the binding when Mastra asks, then the owner answers. */
export function approveAsOwner(
  runtime: Pick<AkeruToolRuntime, "openApproval" | "grantApproval">,
  input: Parameters<AkeruToolRuntime["grantApproval"]>[0],
) {
  runtime.openApproval(input);

  return runtime.grantApproval(input);
}
