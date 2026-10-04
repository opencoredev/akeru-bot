import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import type { ThemeDefinition } from "./themePalette";
import {
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "./vscodeThemeImport";
import {
  MAX_MANIFEST_BYTES,
  MAX_THEMES_PER_EXTENSION,
  openVsxThemeId,
  themeContributions,
  manifestLicenseMatches,
  parseJsoncObject,
  readCappedResponse,
} from "./theme/openVsxMetadata";
import { type OpenVsxThemeExtension } from "./theme/openVsxSearch";
import {
  normalizePackagePath,
  contributionType,
  inspectZipDirectory,
  inspectZip,
  readZipText,
  loadThemeObject,
  fetchPackage,
} from "./theme/openVsxPackage";

export async function importOpenVsxThemeExtension(
  extension: OpenVsxThemeExtension,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  const manifestResponse = await fetch(extension.manifestUrl, signal ? { signal } : {});

  if (!manifestResponse.ok) throw new Error("That Open VSX extension has no readable manifest.");

  const manifestBytes = await readCappedResponse(
    manifestResponse,
    MAX_MANIFEST_BYTES,
    "That Open VSX extension manifest is too large.",
  );

  const manifest = parseJsoncObject(new TextDecoder().decode(manifestBytes), "Extension manifest");
  const advertisedContributions = themeContributions(manifest);

  if (advertisedContributions.length === 0) {
    throw new Error("That extension does not contain color themes.");
  }

  if (advertisedContributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many color themes to import safely.");
  }

  const packageBytes = await fetchPackage(extension.vsixUrl, signal);
  signal?.throwIfAborted();
  const checksumResponse = await fetch(extension.sha256Url, signal ? { signal } : {});

  if (!checksumResponse.ok) throw new Error("That Open VSX theme has no readable checksum.");

  const expectedChecksum = new TextDecoder()
    .decode(
      await readCappedResponse(
        checksumResponse,
        256,
        "That Open VSX checksum response is invalid.",
      ),
    )
    .trim()
    .split(/\s+/)[0];

  if (!expectedChecksum || !/^[a-f\d]{64}$/i.test(expectedChecksum)) {
    throw new Error("That Open VSX theme has an invalid checksum.");
  }

  signal?.throwIfAborted();

  const actualChecksum = [...sha256(packageBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error("That Open VSX theme failed its integrity check.");
  }

  signal?.throwIfAborted();
  let zip: JSZip;

  try {
    const inspectedPackageBytes = inspectZipDirectory(packageBytes);
    zip = await JSZip.loadAsync(inspectedPackageBytes);
    signal?.throwIfAborted();
    inspectZip(zip);
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();

    if (cause instanceof Error && cause.message.startsWith("That extension package")) throw cause;
    throw new Error("That Open VSX extension package could not be opened.", { cause });
  }

  const packagedManifest = parseJsoncObject(
    await readZipText(zip, "extension/package.json", "Extension manifest", signal),
    "Extension manifest",
  );

  if (
    !Predicate.isString(packagedManifest.publisher) ||
    packagedManifest.publisher.toLowerCase() !== extension.publisher.toLowerCase() ||
    !Predicate.isString(packagedManifest.name) ||
    `${packagedManifest.publisher}.${packagedManifest.name}`.toLowerCase() !==
      extension.id.toLowerCase() ||
    packagedManifest.version !== extension.version
  ) {
    throw new Error("That extension package does not match the selected Open VSX theme.");
  }

  if (!manifestLicenseMatches(packagedManifest, extension.license)) {
    throw new Error("That extension package does not match its advertised license.");
  }

  const contributions = themeContributions(packagedManifest);

  if (contributions.length === 0) throw new Error("That extension does not contain color themes.");

  if (contributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many color themes to import safely.");
  }

  const parsed: Array<{ theme: ThemeDefinition; sourceName: string; sourcePath: string }> = [];
  const failures: string[] = [];
  const themeCache = new Map<string, Schema.JsonObject>();
  const themeBudget = { files: 0 };

  for (const contribution of contributions) {
    signal?.throwIfAborted();

    if (!Predicate.isString(contribution.path)) {
      failures.push("theme path is missing");
      continue;
    }

    try {
      const path = normalizePackagePath(contribution.path);

      const themeValue = await loadThemeObject(
        zip,
        path,
        themeCache,
        themeBudget,
        new Set(),
        signal,
      );

      const type = contributionType(contribution.uiTheme);

      const label =
        Predicate.isString(contribution.label) && contribution.label.trim()
          ? contribution.label.trim()
          : extension.name;

      const decorated = {
        ...themeValue,
        displayName: label,
        ...(type ? { type } : {}),
      };

      if (!isVsCodeThemeFile(decorated)) throw new Error("not a VS Code color theme");
      parsed.push({
        theme: parseVsCodeThemeFile(decorated),
        sourceName: path.split("/").at(-1)!,
        sourcePath: path,
      });
    } catch (cause) {
      signal?.throwIfAborted();
      failures.push(cause instanceof Error ? cause.message : "theme could not be read");
    }
  }

  if (failures.length > 0) {
    throw new Error("One or more color themes in that extension could not be imported safely.");
  }

  if (parsed.length === 0) {
    throw new Error("That extension has no compatible color themes.");
  }

  const extensionId = extension.id.toLowerCase();
  const sourcePathCounts = new Map<string, number>();

  for (const { sourcePath } of parsed) {
    sourcePathCounts.set(sourcePath, (sourcePathCounts.get(sourcePath) ?? 0) + 1);
  }

  const sourcePathOccurrences = new Map<string, number>();

  const sourceIdentities = parsed.map(({ sourcePath }) => {
    if (sourcePathCounts.get(sourcePath) === 1) return sourcePath;
    const occurrence = sourcePathOccurrences.get(sourcePath) ?? 0;
    sourcePathOccurrences.set(sourcePath, occurrence + 1);

    return occurrence === 0 ? sourcePath : `${sourcePath}\0${occurrence}`;
  });

  const resolved = resolveThemeLabelCollisions(parsed).map((theme, index) => ({
    ...theme,
    id: openVsxThemeId(extensionId, sourceIdentities[index]!),
  }));

  const paired = pairVsCodeThemes(resolved, {
    pairedId: (light, dark) => openVsxThemeId(extensionId, [light.id, dark.id].sort().join(":")),
  });

  const themes = resolveThemeLabelCollisions(paired.map((theme) => ({ theme })));

  const collection = {
    id: extension.collectionId,
    label: extension.name.slice(0, 48),
  };

  return themes.map((theme) => ({ ...theme, collection }));
}

export {
  type OpenVsxThemeSort,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSearchOptions,
  searchOpenVsxThemes,
} from "./theme/openVsxSearch";
