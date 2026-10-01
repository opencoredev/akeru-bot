import { resolveDownloadLink } from "./downloadLinks";
import { detectDownloadTarget, fetchLatestRelease } from "./releases";

export async function initHomeDownloads() {
  const button = document.querySelector<HTMLAnchorElement>("#download-btn");
  const label = document.getElementById("download-label");
  const cards = document.querySelectorAll<HTMLAnchorElement>("a[data-asset]");

  // Macs always get the arm64 build. Browsers cannot reliably tell Apple Silicon
  // from Intel (the UA lies, GPU strings lie), and the release workflow ships no
  // Intel build. Do NOT add arch detection here.
  // The markup ships with href={RELEASES_URL}, so the button works before this
  // script runs and when no platform is detected.
  const platform = detectDownloadTarget(navigator.userAgent);

  if (platform) {
    if (label) label.textContent = platform.label;

    if (button) {
      button.dataset.os = platform.os;
      button.dataset.asset = platform.assetSuffix;
    }
  } else if (label) {
    label.textContent = "All downloads";
  }

  const release = fetchLatestRelease();

  const cardDownloads = Array.from(cards, async (card) => {
    const suffix = card.dataset.asset;

    if (!suffix || card === button) return;
    await resolveDownloadLink(card, suffix, release);
  });

  if (button && platform) {
    const asset = await resolveDownloadLink(button, platform.assetSuffix, release);

    if (!asset && label) label.textContent = "All downloads";
  }

  await Promise.all(cardDownloads);
}
