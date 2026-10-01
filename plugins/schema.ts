import { decodePluginManifest } from "./decodeManifest.ts";
import type { PluginManifest } from "./manifestTypes.ts";
import { validateManifest } from "./validateManifest.ts";

export { PLUGIN_SCHEMA_VERSION, type PluginManifest, type PluginSkill } from "./manifestTypes.ts";

export function parsePluginManifest(input: unknown, source = "plugin manifest"): PluginManifest {
  try {
    return validateManifest(decodePluginManifest(input));
  } catch (error) {
    throw new TypeError(`${source} is invalid: ${String(error)}`, { cause: error });
  }
}

export function parsePluginManifestJson(input: string, source = "plugin manifest"): PluginManifest {
  try {
    const value: unknown = JSON.parse(input);

    return validateManifest(decodePluginManifest(value));
  } catch (error) {
    throw new TypeError(`${source} is invalid: ${String(error)}`, { cause: error });
  }
}
