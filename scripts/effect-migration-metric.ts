// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Print the Effect migration audit signals for the server source tree.
 *
 * This is intentionally a report, not a CI gate. Run with:
 *   node scripts/effect-migration-metric.ts
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const sourceRoot = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../apps/server/src",
);
const runtimeEscape = /\bEffect\.run(?:Promise|Sync|Fork)\s*\(/g;
const promiseBridge = /\bEffect\.(?:tryPromise|promise)\s*\(/g;
const suppression = /@effect-diagnostics(?:-next-line)?\s+([^\n]+)/g;

export type MigrationMetric = {
  readonly runtimeEscapes: number;
  readonly promiseBridges: number;
  readonly suppressions: ReadonlyMap<string, number>;
};

export const countSource = (source: string): MigrationMetric => {
  const suppressions = new Map<string, number>();
  for (const [, directive] of source.matchAll(suppression)) {
    if (directive === undefined) continue;
    for (const rule of directive.matchAll(/([A-Za-z]+):off/g)) {
      const name = rule[1];
      if (name !== undefined) suppressions.set(name, (suppressions.get(name) ?? 0) + 1);
    }
  }
  return {
    runtimeEscapes: source.match(runtimeEscape)?.length ?? 0,
    promiseBridges: source.match(promiseBridge)?.length ?? 0,
    suppressions,
  };
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = NodePath.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path]);
    }),
  );
  return files
    .flat()
    .filter(
      (path) =>
        path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("/serviceLauncher.ts"),
    );
};

const report = async () => {
  const files = await filesUnder(sourceRoot);
  let runtimeEscapes = 0;
  let promiseBridges = 0;
  const suppressions = new Map<string, number>();

  for (const file of files) {
    const source = await NodeFSP.readFile(file, "utf8");
    const metric = countSource(source);
    runtimeEscapes += metric.runtimeEscapes;
    promiseBridges += metric.promiseBridges;
    for (const [rule, count] of metric.suppressions) {
      suppressions.set(rule, (suppressions.get(rule) ?? 0) + count);
    }
  }

  console.log(`Effect runtime escapes: ${runtimeEscapes}`);
  console.log(`Promise bridges: ${promiseBridges}`);
  console.log("Diagnostic suppressions:");
  for (const [rule, count] of [...suppressions].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${rule}: ${count}`);
  }
  console.error(
    `Scanned ${files.length} production files under ${NodePath.relative(process.cwd(), sourceRoot)}`,
  );
};

// Importing countSource (as the unit test does) must not scan and print the report.
if (import.meta.main) await report();
