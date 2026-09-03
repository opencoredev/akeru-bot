// @effect-diagnostics nodeBuiltinImport:off - Catalog validation reads repository-owned manifests and assets before an Effect runtime exists.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { parsePluginManifestJson, type PluginManifest } from "../plugins/schema.ts";

const MAX_LOGO_BYTES = 128 * 1024;
const UNSAFE_SVG =
  /<(?:script|foreignObject|iframe|object|embed)|\son[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?:data:|https?:|\/\/|javascript:)|<!DOCTYPE|<!ENTITY/i;
const GENERIC_LOGO = /(?:^|[-_.])(default|generic|mcp|placeholder)(?:[-_.]|$)/i;
const GENERIC_LOGO_HASHES = new Set([
  "c1f3c1672346935816d34b1d64bd34998f578aef8ba51aa24a032055c23ecfd9",
  "08f63cb8ff556cf2241d5a5b1633989bc872238a015a4789fc5dbee30babd9b0",
]);

export interface ValidatedCatalogEntry {
  readonly directory: string;
  readonly manifest: PluginManifest;
}

function validateLogo(
  directoryUrl: URL,
  directory: string,
  filename: string,
  hashes: Map<string, string>,
): void {
  if (GENERIC_LOGO.test(filename)) {
    throw new TypeError(`Plugin '${directory}' uses generic logo '${filename}'.`);
  }
  const logoUrl = new URL(filename, directoryUrl);
  if (!NodeFS.existsSync(logoUrl)) {
    throw new TypeError(`Plugin '${directory}' is missing logo '${filename}'.`);
  }
  const bytes = NodeFS.readFileSync(logoUrl);
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw new TypeError(`Plugin '${directory}' logo '${filename}' exceeds 128 KiB.`);
  }
  if (filename.endsWith(".svg") && UNSAFE_SVG.test(bytes.toString("utf8"))) {
    throw new TypeError(`Plugin '${directory}' logo '${filename}' contains unsafe SVG content.`);
  }
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (GENERIC_LOGO_HASHES.has(hash)) {
    throw new TypeError(`Plugin '${directory}' uses a generic MCP logo.`);
  }
  const otherPlugin = hashes.get(hash);
  if (otherPlugin && otherPlugin !== directory) {
    throw new TypeError(`Plugins '${otherPlugin}' and '${directory}' use the same logo.`);
  }
  hashes.set(hash, directory);
}

export function validatePluginCatalog(
  entriesRoot = new URL("../plugins/entries/", import.meta.url),
): readonly ValidatedCatalogEntry[] {
  const directories = NodeFS.readdirSync(entriesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const ids = new Set<string>();
  const hashes = new Map<string, string>();
  const entries = directories.map((directory) => {
    const directoryUrl = new URL(`${directory}/`, entriesRoot);
    const manifestUrl = new URL("plugin.json", directoryUrl);
    if (!NodeFS.existsSync(manifestUrl)) {
      throw new TypeError(`Plugin directory '${directory}' is missing plugin.json.`);
    }
    const manifest = parsePluginManifestJson(
      NodeFS.readFileSync(manifestUrl, "utf8"),
      `${directory}/plugin.json`,
    );
    if (manifest.id !== directory) {
      throw new TypeError(`Plugin '${manifest.id}' must live in entries/${manifest.id}/.`);
    }
    if (ids.has(manifest.id)) throw new TypeError(`Duplicate plugin id '${manifest.id}'.`);
    ids.add(manifest.id);

    // A manifest with a remote logo URL ships no local artwork.
    const logos = manifest.logo.url ? [] : ["logo.svg", "logo-dark.svg"];
    for (const filename of logos) validateLogo(directoryUrl, directory, filename, hashes);
    const expectedFiles = new Set(["plugin.json", ...logos]);
    const unexpected = NodeFS.readdirSync(directoryUrl).filter((file) => !expectedFiles.has(file));
    if (unexpected.length > 0) {
      throw new TypeError(`Plugin '${directory}' has undeclared files: ${unexpected.join(", ")}.`);
    }
    return Object.freeze({ directory, manifest });
  });
  return Object.freeze(entries);
}

if (import.meta.main) validatePluginCatalog();
