import * as Predicate from "effect/Predicate";
import {
  MAX_VSIX_BYTES,
  MAX_MANIFEST_BYTES,
  isRecord,
  shortHash,
  themeContributions,
  manifestLicenseMatches,
  parseJsoncObject,
  readCappedResponse,
} from "./openVsxMetadata";

const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";

const MAX_SEARCH_BYTES = 512 * 1024;

const MAX_DETAIL_BYTES = 256 * 1024;

const SEARCH_REQUEST_TIMEOUT_MS = 10_000;

const SUPPORTED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense",
]);

export type OpenVsxThemeSort = "downloadCount" | "rating" | "timestamp" | "relevance";

export type OpenVsxThemeExtension = {
  id: string;
  collectionId: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  sourceUrl: string | null;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
};

export type OpenVsxThemeSearchOptions = {
  signal?: AbortSignal;
  sortBy?: OpenVsxThemeSort;
};

function openVsxCollectionId(extensionId: string): string {
  const normalized = `open-vsx:${extensionId.toLowerCase()}`;

  return /^[a-z0-9][a-z0-9.:-]{0,127}$/.test(normalized)
    ? normalized
    : `open-vsx:${shortHash(extensionId)}`;
}

function trustedOpenVsxUrl(value: unknown): string | null {
  if (!Predicate.isString(value)) return null;

  try {
    const url = new URL(value);

    return url.protocol === "https:" && url.hostname.toLowerCase() === "open-vsx.org"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publicSourceUrl(value: unknown): string | null {
  const rawValue = Predicate.isString(value)
    ? value
    : isRecord(value) && Predicate.isString(value.url)
      ? value.url
      : null;

  if (!rawValue) return null;

  try {
    const url = new URL(rawValue);

    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function extensionFromDetail(value: unknown): OpenVsxThemeExtension | null {
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new Error("Open VSX returned malformed theme details.");
  }

  const namespace = Predicate.isString(value.namespace) ? value.namespace.trim() : "";
  const extensionName = Predicate.isString(value.name) ? value.name.trim() : "";

  const displayName =
    (Predicate.isString(value.displayName) ? value.displayName.trim() : "") || extensionName;

  const version = Predicate.isString(value.version) ? value.version.trim() : "";
  const license = Predicate.isString(value.license) ? value.license.trim() : "";
  const manifestUrl = trustedOpenVsxUrl(value.files.manifest);
  const sha256Url = trustedOpenVsxUrl(value.files.sha256);
  const vsixUrl = trustedOpenVsxUrl(value.files.download);

  if (!namespace || !extensionName || !version || !manifestUrl || !sha256Url || !vsixUrl) {
    throw new Error("Open VSX returned malformed theme details.");
  }

  if (!SUPPORTED_LICENSES.has(license)) return null;
  const id = `${namespace}.${extensionName}`;

  return {
    id,
    collectionId: openVsxCollectionId(id),
    name: displayName,
    publisher: namespace,
    description: Predicate.isString(value.description) ? value.description : "",
    downloadCount:
      Predicate.isNumber(value.downloadCount) && Number.isFinite(value.downloadCount)
        ? value.downloadCount
        : 0,
    iconUrl: trustedOpenVsxUrl(value.files.icon),
    sourceUrl:
      publicSourceUrl(value.repository) ??
      publicSourceUrl(value.homepage) ??
      publicSourceUrl(value.url),
    manifestUrl,
    sha256Url,
    vsixUrl,
    version,
    license,
  };
}

async function withSearchTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);

  try {
    return await operation(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error("Open VSX took too long to respond.", { cause });
    }

    throw cause;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

export async function searchOpenVsxThemes(
  query: string,
  { signal, sortBy = "downloadCount" }: OpenVsxThemeSearchOptions = {},
): Promise<OpenVsxThemeExtension[]> {
  const searchText = query.trim();

  if (!searchText) return [];
  const url = new URL(OPEN_VSX_SEARCH_URL);
  url.searchParams.set("query", searchText);
  url.searchParams.set("category", "Themes");
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", "desc");
  // Ask for a few extras because results without a supported SPDX license
  // are intentionally omitted.
  url.searchParams.set("size", "16");

  const value = await withSearchTimeout(async (requestSignal) => {
    const response = await fetch(url, { signal: requestSignal });

    if (!response.ok) throw new Error("Open VSX search is unavailable right now.");

    const searchBytes = await readCappedResponse(
      response,
      MAX_SEARCH_BYTES,
      "Open VSX returned an unexpectedly large response.",
    );

    try {
      return JSON.parse(new TextDecoder().decode(searchBytes)) as unknown;
    } catch {
      throw new Error("Open VSX returned an unreadable response.");
    }
  }, signal);

  if (!isRecord(value) || !Array.isArray(value.extensions)) {
    throw new Error("Open VSX returned an unreadable search response.");
  }

  const identities = value.extensions.flatMap((candidate): Array<[string, string]> => {
    if (!isRecord(candidate)) return [];
    const namespace = Predicate.isString(candidate.namespace) ? candidate.namespace : "";
    const name = Predicate.isString(candidate.name) ? candidate.name : "";

    return namespace && name ? [[namespace, name]] : [];
  });

  const details = await Promise.allSettled(
    identities.slice(0, 16).map(([namespace, name]) =>
      withSearchTimeout(async (requestSignal) => {
        const detailUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        const detailResponse = await fetch(detailUrl, { signal: requestSignal });

        if (!detailResponse.ok) throw new Error("Open VSX theme details are unavailable.");

        const detailBytes = await readCappedResponse(
          detailResponse,
          MAX_DETAIL_BYTES,
          "Open VSX returned an unexpectedly large detail response.",
        );

        try {
          const extension = extensionFromDetail(JSON.parse(new TextDecoder().decode(detailBytes)));

          if (!extension) return null;

          const [manifestResponse, packageResponse] = await Promise.all([
            fetch(extension.manifestUrl, { signal: requestSignal }),
            fetch(extension.vsixUrl, { method: "HEAD", signal: requestSignal }),
          ]);

          if (!manifestResponse.ok) throw new Error("manifest unavailable");

          if (!packageResponse.ok) return null;
          const packageLength = Number(packageResponse.headers.get("content-length"));

          if (Number.isFinite(packageLength) && packageLength > MAX_VSIX_BYTES) {
            return null;
          }

          const manifestBytes = await readCappedResponse(
            manifestResponse,
            MAX_MANIFEST_BYTES,
            "Open VSX returned an unexpectedly large manifest.",
          );

          const manifest = parseJsoncObject(
            new TextDecoder().decode(manifestBytes),
            "Extension manifest",
          );

          return themeContributions(manifest).length > 0 &&
            manifestLicenseMatches(manifest, extension.license)
            ? extension
            : null;
        } catch {
          throw new Error("Open VSX returned unreadable theme details.");
        }
      }, signal),
    ),
  );

  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const completedDetails = details.filter((result) => result.status === "fulfilled");

  if (identities.length > 0 && completedDetails.length === 0) {
    throw new Error("Open VSX theme details are unavailable right now.");
  }

  return completedDetails.flatMap((result) => (result.value ? [result.value] : [])).slice(0, 8);
}
