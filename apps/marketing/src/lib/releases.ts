import { isJsonObject, isJsonString } from "../../../../plugins/json.ts";

const REPO = "opencoredev/akeru-bot";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

// Used only when the build cannot reach GitHub. The client script still upgrades links.
export const FALLBACK_VERSION = "0.2.1";

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

const CACHE_KEY = "akeru-latest-release";

export const RELEASE_REQUEST_TIMEOUT_MS = 5_000;

let latestRelease: Release | undefined;

let releaseRequest: Promise<Release> | undefined;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export type DownloadTarget = {
  os: "mac" | "win" | "linux";
  label: string;
  assetSuffix: string;
  unsigned: boolean;
};

const TARGETS = {
  mac: {
    os: "mac",
    label: "Download for macOS",
    assetSuffix: "arm64.dmg",
    unsigned: false,
  },
  win: {
    os: "win",
    label: "Download for Windows",
    assetSuffix: "x64.exe",
    unsigned: true,
  },
  linux: {
    os: "linux",
    label: "Download for Linux",
    assetSuffix: "x64.AppImage",
    unsigned: true,
  },
} as const satisfies Record<string, DownloadTarget>;

export const DOWNLOAD_TARGETS = Object.values(TARGETS);

export function releaseAssetUrl(version: string, assetSuffix: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/Akeru-Bot-${version}-${assetSuffix}`;
}

// Build-time lookup. The /releases/latest page redirects to the newest stable tag
// and, unlike the REST API, is not rate limited for anonymous build machines.
let buildVersion: Promise<string> | undefined;

export function resolveBuildVersion(): Promise<string> {
  buildVersion ??= lookupBuildVersion();

  return buildVersion;
}

async function lookupBuildVersion(): Promise<string> {
  try {
    const response = await fetch(`${RELEASES_URL}/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
    });

    const version = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(
      response.headers.get("location") ?? "",
    )?.[1];

    return version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export function detectDownloadTarget(userAgent: string): DownloadTarget | null {
  // Phones and tablets have no desktop build. Their user agents also claim Linux or
  // Mac OS X, so check them first.
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;

  if (/Windows/i.test(userAgent)) return TARGETS.win;

  if (/Macintosh|Mac OS X/i.test(userAgent)) return TARGETS.mac;

  if (/Linux/i.test(userAgent)) return TARGETS.linux;

  return null;
}

export function selectReleaseAsset(release: Release, assetSuffix: string): ReleaseAsset | null {
  const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];

  if (!version) return null;

  const assetName = `Akeru-Bot-${version}-${assetSuffix}`;

  return release.assets.find((asset) => asset.name === assetName) ?? null;
}

export function requiresUnsignedInstall(assetSuffix: string): boolean {
  return Object.values(TARGETS).some(
    (target) => target.assetSuffix === assetSuffix && target.unsigned,
  );
}

type DownloadLink = { href: string };

// Pages bake a direct asset URL in at build time, so a link always downloads. This
// only upgrades the link when GitHub reports a newer release than the build saw.
export async function resolveAssetDownload(
  link: DownloadLink,
  assetSuffix: string,
  release: Promise<Release> = fetchLatestRelease(),
): Promise<ReleaseAsset | null> {
  try {
    const latest = await release;
    const asset = selectReleaseAsset(latest, assetSuffix);

    if (asset && isNewerVersion(latest.tag_name, versionInUrl(link.href))) {
      link.href = asset.browser_download_url;
    }

    return asset;
  } catch {
    return null;
  }
}

type ReleaseVersionLabel = { textContent: string | null };

type ReleaseNotesLink = { href: string };

// Version text and release-notes links are baked at build time too. When the links
// above move to a newer release, these follow so the page names what it downloads.
export function upgradeReleaseInfo(
  latest: Release,
  labels: Iterable<ReleaseVersionLabel>,
  notesLinks: Iterable<ReleaseNotesLink>,
) {
  for (const label of labels) {
    if (isNewerVersion(latest.tag_name, label.textContent ?? undefined)) {
      label.textContent = latest.tag_name.slice(1);
    }
  }

  for (const link of notesLinks) {
    if (isNewerVersion(latest.tag_name, /\/tag\/(v[\d.]+)$/.exec(link.href)?.[1])) {
      link.href = latest.html_url;
    }
  }
}

function versionInUrl(url: string): string | undefined {
  return /\/download\/(v\d+\.\d+\.\d+)\//.exec(url)?.[1];
}

// A stale cache or a lagging API must never move a link back to an older build.
function isNewerVersion(candidate: string, current: string | undefined): boolean {
  if (!current) return true;
  const parse = (tag: string) => tag.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parse(candidate), parse(current)];

  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }

  return false;
}

export function fetchLatestRelease(): Promise<Release> {
  if (latestRelease) return Promise.resolve(latestRelease);

  if (releaseRequest) return releaseRequest;

  const cached = readCachedRelease();

  if (cached) {
    latestRelease = cached;

    return Promise.resolve(cached);
  }

  releaseRequest = requestLatestRelease()
    .then((data) => {
      latestRelease = data;

      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch {
        // Downloads still work when session storage is unavailable or full.
      }

      return data;
    })
    .finally(() => {
      releaseRequest = undefined;
    });

  return releaseRequest;
}

function readCachedRelease(): Release | undefined {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);

    if (!cached) return undefined;

    try {
      const data: unknown = JSON.parse(cached);

      if (isRelease(data)) return data;
    } catch {
      // Invalid cached data is replaced by the next successful request.
    }

    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage access can be denied independently of network access.
  }

  return undefined;
}

async function requestLatestRelease(): Promise<Release> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("GitHub release request timed out"));
      controller.abort();
    }, RELEASE_REQUEST_TIMEOUT_MS);
  });

  const request = async () => {
    const response = await fetch(API_URL, { signal: controller.signal });

    if (!response.ok) throw new Error(`GitHub release request failed: ${response.status}`);
    const data: unknown = await response.json();

    if (!isRelease(data)) throw new Error("GitHub returned an invalid release");

    return data;
  };

  try {
    // The deadline covers the response body as well as headers, even if abort is ignored.
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function isRelease(value: unknown): value is Release {
  if (!isJsonObject(value)) return false;
  const release = value;

  return (
    "tag_name" in release &&
    isJsonString(release.tag_name) &&
    /^v\d+\.\d+\.\d+$/.test(release.tag_name) &&
    "html_url" in release &&
    isJsonString(release.html_url) &&
    "assets" in release &&
    Array.isArray(release.assets) &&
    release.assets.every(isReleaseAsset)
  );
}

function isReleaseAsset(asset: unknown): asset is ReleaseAsset {
  return (
    isJsonObject(asset) &&
    "name" in asset &&
    isJsonString(asset.name) &&
    "browser_download_url" in asset &&
    isJsonString(asset.browser_download_url)
  );
}
