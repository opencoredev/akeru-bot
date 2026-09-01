const REPO = "opencoredev/akeru-bot";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "akeru-latest-release";

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

export function detectDownloadTarget(userAgent: string): DownloadTarget | null {
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
  return assetSuffix === TARGETS.win.assetSuffix || assetSuffix === TARGETS.linux.assetSuffix;
}

type DownloadLink = EventTarget & {
  href: string;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
};

export function blockDownloadUntilResolved(link: DownloadLink): (url: string) => void {
  const blockClick = (event: Event) => event.preventDefault();
  link.removeAttribute("href");
  link.setAttribute("aria-disabled", "true");
  link.addEventListener("click", blockClick);

  return (url) => {
    link.href = url;
    link.removeAttribute("aria-disabled");
    link.removeEventListener("click", blockClick);
  };
}

export async function resolveAssetDownload(
  link: DownloadLink,
  assetSuffix: string,
  release: Promise<Release> = fetchLatestRelease(),
): Promise<ReleaseAsset | null> {
  const resolve = blockDownloadUntilResolved(link);

  try {
    const asset = selectReleaseAsset(await release, assetSuffix);
    resolve(asset?.browser_download_url ?? RELEASES_URL);
    return asset;
  } catch {
    resolve(RELEASES_URL);
    return null;
  }
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const data: unknown = JSON.parse(cached);
      if (isRelease(data)) return data;
      sessionStorage.removeItem(CACHE_KEY);
    } catch {
      sessionStorage.removeItem(CACHE_KEY);
    }
  }

  const response = await fetch(API_URL);
  if (!response.ok) throw new Error(`GitHub release request failed: ${response.status}`);

  const data: unknown = await response.json();
  if (!isRelease(data)) throw new Error("GitHub returned an invalid release");

  sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));

  return data;
}

function isRelease(value: unknown): value is Release {
  if (!value || typeof value !== "object") return false;
  const release = value as Record<string, unknown>;
  return (
    typeof release.tag_name === "string" &&
    /^v\d+\.\d+\.\d+$/.test(release.tag_name) &&
    typeof release.html_url === "string" &&
    Array.isArray(release.assets) &&
    release.assets.every(
      (asset) =>
        asset &&
        typeof asset === "object" &&
        typeof asset.name === "string" &&
        typeof asset.browser_download_url === "string",
    )
  );
}
