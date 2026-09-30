export function normalizeComposerPathSearchQuery(query: string | null): string {
  return query?.trim() ?? "";
}
