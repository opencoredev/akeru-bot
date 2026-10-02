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

export type MigrationMetric = {
  readonly runtimeEscapes: number;
  readonly promiseBridges: number;
};

export const countSource = (source: string): MigrationMetric => ({
  runtimeEscapes: source.match(runtimeEscape)?.length ?? 0,
  promiseBridges: source.match(promiseBridge)?.length ?? 0,
});

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

  for (const file of files) {
    const source = await NodeFSP.readFile(file, "utf8");
    const metric = countSource(source);
    runtimeEscapes += metric.runtimeEscapes;
    promiseBridges += metric.promiseBridges;
  }

  console.log(`Effect runtime escapes: ${runtimeEscapes}`);
  console.log(`Promise bridges: ${promiseBridges}`);

  console.error(
    `Scanned ${files.length} production files under ${NodePath.relative(process.cwd(), sourceRoot)}`,
  );
};

// Importing countSource (as the unit test does) must not scan and print the report.
if (import.meta.main) await report();
