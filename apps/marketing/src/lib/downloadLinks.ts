import {
  detectDownloadTarget,
  fetchLatestRelease,
  requiresUnsignedInstall,
  resolveAssetDownload,
} from "./releases";

export const UNSIGNED_INSTALL_PROMPT =
  "This build is unsigned. Your system may ask you to confirm the install. Continue?";

const guardedLinks = new WeakSet<EventTarget>();

// Asks before an unsigned build downloads. A link is guarded at most once, so running
// the page script again never stacks prompts.
export function guardUnsignedDownload(
  link: EventTarget,
  assetSuffix: string,
  confirmInstall: (prompt: string) => boolean = (prompt) => window.confirm(prompt),
) {
  if (!requiresUnsignedInstall(assetSuffix) || guardedLinks.has(link)) return;
  guardedLinks.add(link);
  link.addEventListener("click", (event) => {
    if (!confirmInstall(UNSIGNED_INSTALL_PROMPT)) event.preventDefault();
  });
}

// Wires every download link on the page. Links ship with a direct asset URL baked
// in at build time, so they work before this runs.
//
// `data-download-auto` links pick the visitor's platform. Macs always get the arm64
// build: browsers cannot reliably tell Apple Silicon from Intel, and the release
// workflow ships no Intel build. Do NOT add arch detection here.
// `data-asset` links name a fixed asset and are upgraded if GitHub has a newer release.
export function initDownloadLinks() {
  const target = detectDownloadTarget(navigator.userAgent);

  document.querySelectorAll<HTMLAnchorElement>("a[data-download-auto]").forEach((link) => {
    if (!target) return;
    const url = link.dataset[`url${target.os[0]?.toUpperCase()}${target.os.slice(1)}`];

    if (!url) return;
    link.href = url;
    link.dataset.os = target.os;
    link.dataset.asset = target.assetSuffix;
    link.removeAttribute("target");
    const label = link.querySelector("[data-download-label]");

    if (label && link.dataset.downloadAuto !== "short") label.textContent = target.label;
  });

  const links = document.querySelectorAll<HTMLAnchorElement>("a[data-asset]");

  if (links.length === 0) return;
  const release = fetchLatestRelease();
  links.forEach((link) => {
    const suffix = link.dataset.asset;

    if (!suffix) return;
    void resolveAssetDownload(link, suffix, release);
    guardUnsignedDownload(link, suffix);
  });
}
