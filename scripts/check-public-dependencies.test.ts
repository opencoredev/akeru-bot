// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  checkPublicDependencies,
  findExternalLocalDependencies,
} from "./check-public-dependencies.ts";

function writeManifest(root: string, relativePath: string, dependency: string): string {
  const manifestPath = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(manifestPath), { recursive: true });
  NodeFS.writeFileSync(
    manifestPath,
    `${JSON.stringify({ dependencies: { example: dependency } }, null, 2)}\n`,
  );
  return manifestPath;
}

it("accepts registry, workspace, and repository-owned file dependencies", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-public-deps-"));
  const manifests = [
    writeManifest(root, "apps/server/package.json", "0.2.0"),
    writeManifest(root, "packages/example/package.json", "workspace:*"),
    writeManifest(root, "apps/mobile/package.json", "file:./modules/example"),
  ];

  assert.deepStrictEqual(findExternalLocalDependencies(root, manifests), []);
});

it("rejects file dependencies that escape the repository", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-public-deps-"));
  const manifestPath = writeManifest(
    root,
    "apps/server/package.json",
    "file:../../../sandbox-sdk/packages/sdk",
  );

  assert.deepStrictEqual(findExternalLocalDependencies(root, [manifestPath]), [
    {
      dependency: "example",
      manifestPath,
      specifier: "file:../../../sandbox-sdk/packages/sdk",
    },
  ]);
});

it("rejects external local paths left in the lockfile", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-public-deps-"));
  NodeFS.writeFileSync(NodePath.join(root, "package.json"), "{}\n");
  NodeFS.writeFileSync(
    NodePath.join(root, "pnpm-lock.yaml"),
    "packages:\n  example:\n    resolution: {directory: ../sandbox-sdk, type: directory}\n",
  );

  assert.deepStrictEqual(checkPublicDependencies(root), [
    {
      dependency: "pnpm-lock.yaml",
      manifestPath: NodePath.join(root, "pnpm-lock.yaml"),
      specifier: "external local path",
    },
  ]);
});
