// Entries shown in Akeru's directory must have a verified MCP listing on integrations.sh.
// Keep the URLs explicit so a registry discovery prompt cannot look like a usable connection.
const MCP_LISTINGS = {
  context: "https://integrations.sh/context.dev/",
  exa: "https://integrations.sh/exa.ai/",
  firecrawl: "https://integrations.sh/firecrawl.dev/",
} as const satisfies Readonly<Record<string, string>>;

export function integrationsShListing(id: string): string | null {
  return MCP_LISTINGS[id as keyof typeof MCP_LISTINGS] ?? null;
}

export function isListedIntegration(plugin: {
  readonly id: string;
  readonly catalogStatus: string;
  readonly connection: { readonly type: string };
}): boolean {
  return (
    plugin.catalogStatus === "available" &&
    plugin.connection.type !== "brokered" &&
    integrationsShListing(plugin.id) !== null
  );
}
