import type { APIRoute } from "astro";

import { projectFileSchemaResponse } from "../../lib/projectFileSchema";

// Rendered at build time; published at https://t3.codes/schema/t3.json so
// t3.json files can reference it via "$schema" for editor/LSP support.
// `/v1/schema/t3.json` is the versioned path agents should call.
export const GET: APIRoute = () => projectFileSchemaResponse();
