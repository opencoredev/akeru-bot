import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const source =
  process.argv[2] ?? NodeURL.fileURLToPath(new URL("../../../plugins/entries/", import.meta.url));

const dist = process.argv[3] ?? NodeURL.fileURLToPath(new URL("../dist/", import.meta.url));

const destination = NodePath.join(dist, "plugins/entries");

// Read the source before replacing the catalog so a missing source fails the build.
if (!NodeFS.statSync(source).isDirectory()) {
  throw new Error("The plugin catalog source must be a directory.");
}

NodeFS.rmSync(destination, { recursive: true, force: true });

NodeFS.cpSync(source, destination, { recursive: true });
