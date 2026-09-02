import type { APIRoute } from "astro";

import { projectFileSchemaResponse } from "../../../lib/projectFileSchema";

// Versioned path for the public metadata API. Breaking changes ship under a new
// major prefix (`/v2/`) and the old prefix keeps serving until its sunset date.
export const GET: APIRoute = () => projectFileSchemaResponse();
