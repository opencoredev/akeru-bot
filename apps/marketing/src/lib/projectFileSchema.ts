import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

// Shared by the versioned `/v1/schema/t3.json` route and the unversioned
// `/schema/t3.json` alias that `$schema` references point at.
export const projectFileSchemaResponse = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
