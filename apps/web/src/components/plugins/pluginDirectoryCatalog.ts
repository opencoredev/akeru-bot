import { isListedIntegration, loadDirectoryCatalog } from "../../../../../plugins";
import { buildPluginFilters } from "./pluginPresentation";

// The directory lists only integrations.sh entries, but an installed plugin that later
// drops off that list (for example, pending vendor verification) must stay manageable.
export const FULL_PLUGIN_CATALOG = loadDirectoryCatalog();
export const LISTED_PLUGIN_CATALOG = FULL_PLUGIN_CATALOG.filter(isListedIntegration);
export const PLUGIN_DIRECTORY_FILTERS = buildPluginFilters(LISTED_PLUGIN_CATALOG);
