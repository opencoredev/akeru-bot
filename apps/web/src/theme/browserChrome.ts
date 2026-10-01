const THEME_COLOR_META_NAME = "theme-color";

const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);

  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);

  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();

  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);

  const themeChromeColor = document.documentElement.dataset.themeId
    ? normalizeThemeColor(rootStyles.getPropertyValue("--app-chrome-background"))
    : null;

  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );

  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = themeChromeColor ?? surfaceColor ?? fallbackColor;

  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;

  // Update every theme-color meta so any element another layer added (for
  // example a media-scoped one) carries the resolved color too.
  const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );

  if (themeColorMetas.length === 0) {
    ensureThemeColorMetaTag().setAttribute("content", backgroundColor);

    return;
  }

  for (const element of themeColorMetas) {
    element.setAttribute("content", backgroundColor);
  }
}
