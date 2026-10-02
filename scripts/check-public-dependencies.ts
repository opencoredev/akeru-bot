#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

// CI runs this script before installing dependencies, so it reads manifests with Node built-ins only.
function readDependencyEntries(manifestPath: string): ReadonlyArray<readonly [string, string]> {
  const manifest: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));

  if (typeof manifest !== "object" || manifest === null) {
    throw new Error(`${manifestPath} is not a JSON object`);
  }

  return DEPENDENCY_SECTIONS.flatMap((section) => {
    const dependencies: unknown = Object.getOwnPropertyDescriptor(manifest, section)?.value;

    if (dependencies === undefined) return [];

    if (typeof dependencies !== "object" || dependencies === null) {
      throw new Error(`${manifestPath} has a non-object ${section}`);
    }

    return Object.entries(dependencies).map(([dependency, specifier]: [string, unknown]) => {
      if (typeof specifier !== "string") {
        throw new Error(`${manifestPath} has a non-string ${section}.${dependency}`);
      }

      return [dependency, specifier] as const;
    });
  });
}

export interface PublicDependencyProblem {
  readonly dependency: string;
  readonly manifestPath: string;
  readonly specifier: string;
}

function workspaceManifestPaths(repoRoot: string): ReadonlyArray<string> {
  const manifests = [NodePath.join(repoRoot, "package.json")];

  for (const directory of ["apps", "infra", "packages"]) {
    const directoryPath = NodePath.join(repoRoot, directory);

    if (!NodeFS.existsSync(directoryPath)) continue;

    for (const entry of NodeFS.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = NodePath.join(directoryPath, entry.name, "package.json");

      if (NodeFS.existsSync(manifestPath)) manifests.push(manifestPath);
    }
  }

  for (const relativePath of [
    "oxlint-plugin-akeru/package.json",
    "oxlint-plugin-anti-slop/package.json",
    "scripts/package.json",
  ]) {
    const manifestPath = NodePath.join(repoRoot, relativePath);

    if (NodeFS.existsSync(manifestPath)) manifests.push(manifestPath);
  }

  return manifests;
}

function escapesRepository(repoRoot: string, manifestPath: string, specifier: string): boolean {
  const relativeTarget = specifier.replace(/^(?:file|link):/u, "");
  const target = NodePath.resolve(NodePath.dirname(manifestPath), relativeTarget);
  const relative = NodePath.relative(repoRoot, target);

  return (
    relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
  );
}

export function findExternalLocalDependencies(
  repoRoot: string,
  manifestPaths: ReadonlyArray<string> = workspaceManifestPaths(repoRoot),
): ReadonlyArray<PublicDependencyProblem> {
  const problems: PublicDependencyProblem[] = [];

  for (const manifestPath of manifestPaths) {
    for (const [dependency, specifier] of readDependencyEntries(manifestPath)) {
      if (!/^(?:file|link):/u.test(specifier)) continue;

      if (!escapesRepository(repoRoot, manifestPath, specifier)) continue;
      problems.push({ dependency, manifestPath, specifier });
    }
  }

  return problems;
}

export function checkPublicDependencies(repoRoot: string): ReadonlyArray<PublicDependencyProblem> {
  const manifestProblems = findExternalLocalDependencies(repoRoot);
  const lockfilePath = NodePath.join(repoRoot, "pnpm-lock.yaml");

  if (!NodeFS.existsSync(lockfilePath)) return manifestProblems;

  const lockfile = NodeFS.readFileSync(lockfilePath, "utf8");

  if (!/(?:specifier: (?:file|link):\.\.\/|directory: \.\.\/)/u.test(lockfile)) {
    return manifestProblems;
  }

  return [
    ...manifestProblems,
    {
      dependency: "pnpm-lock.yaml",
      manifestPath: lockfilePath,
      specifier: "external local path",
    },
  ];
}

function main(): void {
  const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const problems = checkPublicDependencies(repoRoot);

  if (problems.length === 0) {
    process.stdout.write(
      "All workspace dependencies resolve from the repository or a public registry.\n",
    );

    return;
  }

  for (const problem of problems) {
    const relativePath = NodePath.relative(repoRoot, problem.manifestPath);
    process.stderr.write(
      `${relativePath}: ${problem.dependency} uses ${problem.specifier}, which resolves outside the repository.\n`,
    );
  }

  process.exitCode = 1;
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) main();
