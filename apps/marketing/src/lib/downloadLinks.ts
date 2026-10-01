import {
  blockDownloadUntilResolved,
  fetchLatestRelease,
  RELEASES_URL,
  requiresUnsignedInstall,
  selectReleaseAsset,
  type Release,
} from "./releases";

export const UNSIGNED_INSTALL_PROMPT =
  "This build is unsigned. Your system may ask you to confirm the install. Continue?";

type DownloadLink = EventTarget &
  Pick<HTMLAnchorElement, "href" | "removeAttribute" | "setAttribute" | "getAttribute">;

const guardedLinks = new WeakSet<DownloadLink>();

export async function resolveDownloadLink(
  link: DownloadLink,
  assetSuffix: string,
  release: Promise<Release> = fetchLatestRelease(),
  confirmInstall: (prompt: string) => boolean = (prompt) => window.confirm(prompt),
) {
  const enableDownload = blockDownloadUntilResolved(link);
  link.removeAttribute("data-unsigned");

  const releaseInfo = await release.catch(() => null);
  const asset = releaseInfo ? selectReleaseAsset(releaseInfo, assetSuffix) : null;
  if (asset && requiresUnsignedInstall(assetSuffix)) {
    link.setAttribute("data-unsigned", "true");
    if (!guardedLinks.has(link)) {
      link.addEventListener("click", (event) => {
        if (
          link.getAttribute("data-unsigned") === "true" &&
          !confirmInstall(UNSIGNED_INSTALL_PROMPT)
        ) {
          event.preventDefault();
        }
      });
      guardedLinks.add(link);
    }
  }

  enableDownload(asset?.browser_download_url ?? RELEASES_URL);
  return asset;
}
