import { isPublicFaviconHost } from "./hostClassification.ts";

/** Return a public favicon URL without disclosing private or reserved hosts. */
export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.host) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPublicFaviconHost(url.hostname)) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.host)}&sz=${size}`;
  } catch {
    return null;
  }
}
