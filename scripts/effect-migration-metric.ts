/**
 * Print the Effect migration audit signals for the server source tree.
 *
 * This is intentionally a report, not a CI gate. Run with:
 *   node scripts/effect-migration-metric.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const sourceRoot = join(process.cwd(), "apps/server/src");
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
    for (const rule of directive.matchAll(/([A-Za-z]+):off/g)) {
      suppressions.set(rule[1], (suppressions.get(rule[1]) ?? 0) + 1);
    }
  }
  return {
    runtimeEscapes: source.match(runtimeEscape)?.length ?? 0,
    promiseBridges: source.match(promiseBridge)?.length ?? 0,
    suppressions,
  };
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
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

const files = await filesUnder(sourceRoot);
let runtimeEscapes = 0;
let promiseBridges = 0;
const suppressions = new Map<string, number>();

for (const file of files) {
  const source = await readFile(file, "utf8");
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
  `Scanned ${files.length} production files under ${relative(process.cwd(), sourceRoot)}`,
);
