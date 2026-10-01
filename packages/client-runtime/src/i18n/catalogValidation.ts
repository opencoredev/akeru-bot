import { englishCatalog } from "./catalogs/en/index.ts";
import { type TranslationCatalog } from "./types.ts";

function parameters(message: string): string {
  return [...new Set(Array.from(message.matchAll(/\{(\w+)\}/g), (match) => match[1]))]
    .sort()
    .join(",");
}

/** Validate a complete catalog before making a language available. */
export function validateCatalog(catalog: TranslationCatalog): string[] {
  const issues: string[] = [];
  for (const [key, source] of Object.entries(englishCatalog)) {
    if (!Object.hasOwn(catalog, key)) {
      issues.push(`Missing message: ${key}`);
    } else if (parameters(catalog[key] ?? "") !== parameters(source)) {
      issues.push(`Parameter mismatch: ${key}`);
    }
  }
  for (const key of Object.keys(catalog)) {
    if (!Object.hasOwn(englishCatalog, key)) issues.push(`Unknown message: ${key}`);
  }
  return issues;
}
