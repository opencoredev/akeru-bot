/**
 * Regenerates the bundled `src/provider/model-catalog.json` from models.dev.
 * Servers fetch the live catalog themselves; the bundle is only the offline
 * fallback, so refresh it before a release:
 *
 *   node apps/server/scripts/sync-model-catalog.ts [saved-api.json]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import {
  catalogFromModelsDev,
  MODELS_DEV_URL,
  ModelsDevPayload,
} from "../src/provider/modelCatalogData.ts";

const source = process.argv[2];

const raw = source
  ? await NodeFSP.readFile(source, "utf8")
  : await (await fetch(MODELS_DEV_URL)).text();

const catalog = catalogFromModelsDev(
  Schema.decodeUnknownSync(Schema.fromJsonString(ModelsDevPayload))(raw),
);

if (!catalog) throw new Error("models.dev returned no usable models.");

const target = NodePath.join(import.meta.dirname, "../src/provider/model-catalog.json");

await NodeFSP.writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`);

// Match the repository formatter so the regenerated bundle passes `fmt:check`.
NodeChildProcess.execFileSync("vp", ["fmt", target], { stdio: "inherit" });

for (const [driver, models] of Object.entries(catalog.drivers)) {
  console.log(`${driver}: ${models.length} models`);
}
