// Inspector-owned DOM: the hover outline with its role label and the SVG
// spotlight that dims the app around matched elements. Everything here is
// created on demand and removed by the clear functions.

export const THEME_INSPECTOR_MATCH_ATTRIBUTE = "data-theme-inspector-match";

export const THEME_SPOTLIGHT_ID = "theme-inspector-spotlight";

const THEME_SPOTLIGHT_MASK_ID = "theme-inspector-spotlight-mask";

const THEME_SPOTLIGHT_GLOW_ID = "theme-inspector-spotlight-glow";

export const THEME_HOVER_ID = "theme-inspector-hover";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

type SpotlightRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

export function clearThemeInspectorAttribute(attribute: string): void {
  document
    .querySelectorAll(`[${attribute}]`)
    .forEach((element) => element.removeAttribute(attribute));
}

export function clearThemeInspectorHighlights(): void {
  clearThemeInspectorAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE);
  document.getElementById(THEME_SPOTLIGHT_ID)?.remove();
}

export function clearThemeInspectorHover(): void {
  document.getElementById(THEME_HOVER_ID)?.remove();
}

function svgElement<Name extends keyof SVGElementTagNameMap>(
  name: Name,
): SVGElementTagNameMap[Name] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function spotlightRect(element: Element): SpotlightRectangle | null {
  const bounds = element.getBoundingClientRect();

  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.right < 0 ||
    bounds.bottom < 0 ||
    bounds.left > window.innerWidth ||
    bounds.top > window.innerHeight
  ) {
    return null;
  }

  const padding = 5;
  // Keep the true bounds when an element is partially offscreen. Clamping its
  // rectangle to the viewport would draw a fake glow edge along the crop.
  const x = bounds.left - padding;
  const y = bounds.top - padding;

  const elementRadius =
    Number.parseFloat(window.getComputedStyle(element).borderTopLeftRadius) || 0;

  return {
    x,
    y,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
    radius: Math.min(18, Math.max(7, elementRadius + padding)),
  };
}

/** Outlines the inspected element and labels it with its role. */
export function showThemeInspectorHover(
  inspection: Readonly<{ element: Element }>,
  label: string,
): void {
  const rectangle = spotlightRect(inspection.element);

  if (!rectangle) {
    clearThemeInspectorHover();

    return;
  }

  let hover = document.getElementById(THEME_HOVER_ID);

  if (!hover) {
    hover = document.createElement("div");
    hover.id = THEME_HOVER_ID;
    hover.setAttribute("aria-hidden", "true");
    const tokenLabel = document.createElement("span");
    tokenLabel.dataset.themeInspectorHoverLabel = "";
    hover.append(tokenLabel);
    document.body.append(hover);
  }

  hover.style.left = `${rectangle.x}px`;
  hover.style.top = `${rectangle.y}px`;
  hover.style.width = `${rectangle.width}px`;
  hover.style.height = `${rectangle.height}px`;
  hover.style.borderRadius = `${rectangle.radius}px`;
  hover.dataset.placement = rectangle.y < 32 ? "below" : "above";
  const tokenLabel = hover.querySelector<HTMLElement>("[data-theme-inspector-hover-label]");

  if (tokenLabel) tokenLabel.textContent = label;
}

function spotlightRectElement(rectangle: SpotlightRectangle): SVGRectElement {
  const element = svgElement("rect");
  element.setAttribute("x", String(rectangle.x));
  element.setAttribute("y", String(rectangle.y));
  element.setAttribute("width", String(rectangle.width));
  element.setAttribute("height", String(rectangle.height));
  element.setAttribute("rx", String(rectangle.radius));

  return element;
}

function existingSpotlight(): SVGSVGElement | null {
  const element = document.getElementById(THEME_SPOTLIGHT_ID);

  return element instanceof SVGSVGElement ? element : null;
}

export function renderThemeInspectorSpotlight(elements: ReadonlyArray<Element>): void {
  const rectangles = new Map<string, SpotlightRectangle>();

  for (const element of elements) {
    const rectangle = spotlightRect(element);

    if (!rectangle) continue;

    const key = [rectangle.x, rectangle.y, rectangle.width, rectangle.height]
      .map((value) => Math.round(value))
      .join(":");

    rectangles.set(key, rectangle);
  }

  if (rectangles.size === 0) {
    document.getElementById(THEME_SPOTLIGHT_ID)?.remove();

    return;
  }

  let spotlight = existingSpotlight();

  if (!spotlight) {
    spotlight = svgElement("svg");
    spotlight.id = THEME_SPOTLIGHT_ID;
    spotlight.setAttribute("aria-hidden", "true");
    spotlight.setAttribute("focusable", "false");
    document.body.append(spotlight);
  }

  spotlight.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);

  const definitions = svgElement("defs");
  const mask = svgElement("mask");
  mask.id = THEME_SPOTLIGHT_MASK_ID;
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  const maskSurface = svgElement("rect");
  maskSurface.setAttribute("width", String(window.innerWidth));
  maskSurface.setAttribute("height", String(window.innerHeight));
  maskSurface.setAttribute("fill", "white");
  mask.append(maskSurface);

  const glowFilter = svgElement("filter");
  glowFilter.id = THEME_SPOTLIGHT_GLOW_ID;
  glowFilter.setAttribute("x", "-50%");
  glowFilter.setAttribute("y", "-50%");
  glowFilter.setAttribute("width", "200%");
  glowFilter.setAttribute("height", "200%");
  const blur = svgElement("feGaussianBlur");
  blur.setAttribute("stdDeviation", "5");
  blur.setAttribute("result", "blur");
  const merge = svgElement("feMerge");
  const blurredGlow = svgElement("feMergeNode");
  blurredGlow.setAttribute("in", "blur");
  const crispGlow = svgElement("feMergeNode");
  crispGlow.setAttribute("in", "SourceGraphic");
  merge.append(blurredGlow, crispGlow);
  glowFilter.append(blur, merge);
  definitions.append(mask, glowFilter);

  const glowGroup = svgElement("g");

  for (const rectangle of rectangles.values()) {
    const hole = spotlightRectElement(rectangle);
    hole.setAttribute("fill", "black");
    mask.append(hole);

    const glow = spotlightRectElement(rectangle);
    glow.setAttribute("class", "theme-inspector-spotlight-glow");
    glow.setAttribute("filter", `url(#${THEME_SPOTLIGHT_GLOW_ID})`);
    glowGroup.append(glow);
  }

  const dimmer = svgElement("rect");
  dimmer.setAttribute("class", "theme-inspector-spotlight-dimmer");
  dimmer.setAttribute("width", String(window.innerWidth));
  dimmer.setAttribute("height", String(window.innerHeight));
  dimmer.setAttribute("mask", `url(#${THEME_SPOTLIGHT_MASK_ID})`);
  spotlight.replaceChildren(definitions, dimmer, glowGroup);
}

export function refreshThemeInspectorSpotlight(): void {
  renderThemeInspectorSpotlight([
    ...document.querySelectorAll(`[${THEME_INSPECTOR_MATCH_ATTRIBUTE}]`),
  ]);
}
