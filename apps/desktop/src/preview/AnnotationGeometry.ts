import type { PreviewAnnotationPoint, PreviewAnnotationRect } from "@akeru/contracts";

export const OVERLAY_ATTRIBUTE = "data-t3code-annotation-ui";

export const CONTENT_LAYER_Z_INDEX = 1;

export interface SelectedElement {
  id: string;
  element: Element;
  outline: HTMLDivElement;
  label: HTMLDivElement;
  baselineStyles: Map<string, string>;
}

export const rectFromDomRect = (rect: DOMRect): PreviewAnnotationRect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

export const normalizeRect = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PreviewAnnotationRect => ({
  x: Math.min(startX, endX),
  y: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

export const isUsableRect = (rect: PreviewAnnotationRect): boolean =>
  rect.width >= 3 && rect.height >= 3;

export function unionRects(
  rects: ReadonlyArray<PreviewAnnotationRect>,
  padding = 20,
): PreviewAnnotationRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  const maxWidth = Math.max(1, window.innerWidth - x);
  const maxHeight = Math.max(1, window.innerHeight - y);

  return {
    x,
    y,
    width: Math.min(maxWidth, right - left + padding * 2),
    height: Math.min(maxHeight, bottom - top + padding * 2),
  };
}

export function isAnnotationNode(element: EventTarget | null): boolean {
  return element instanceof Element && element.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null;
}

export function pickFromPoint(clientX: number, clientY: number): Element | null {
  for (const candidate of document.elementsFromPoint(clientX, clientY)) {
    if (!(candidate instanceof Element)) continue;

    if (isAnnotationNode(candidate)) continue;

    if (candidate === document.documentElement || candidate === document.body) continue;

    return candidate;
  }

  return null;
}

function describeRawElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";

  const classes =
    element instanceof HTMLElement
      ? element.className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join("")
      : "";

  return `${tag}${id}${classes}`;
}

export function createBox(color: string, fill: string): HTMLDivElement {
  const node = document.createElement("div");
  node.setAttribute(OVERLAY_ATTRIBUTE, "");
  node.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    `border:2px solid ${color}`,
    `background:${fill}`,
    "border-radius:3px",
    "box-sizing:border-box",
    "display:none",
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(";");

  return node;
}

export function positionBox(node: HTMLElement, rect: PreviewAnnotationRect): void {
  node.style.display = "block";
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

export function createLabel(): HTMLDivElement {
  const label = document.createElement("div");
  label.setAttribute(OVERLAY_ATTRIBUTE, "");
  label.className =
    "fixed z-1 max-w-70 overflow-hidden rounded-md bg-primary px-2 py-1 font-sans text-xs font-semibold text-primary-foreground shadow-md";
  label.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "white-space:nowrap",
    "text-overflow:ellipsis",
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(";");

  return label;
}

export function updateSelectedVisual(target: SelectedElement): void {
  if (!target.element.isConnected) {
    target.outline.style.display = "none";
    target.label.style.display = "none";

    return;
  }

  const rect = target.element.getBoundingClientRect();
  positionBox(target.outline, rectFromDomRect(rect));
  target.label.textContent = describeRawElement(target.element);
  target.label.style.display = "block";
  target.label.style.transform = `translate(${Math.max(4, rect.left)}px, ${Math.max(4, rect.top - 22)}px)`;
}

export function pathFromPoints(points: ReadonlyArray<PreviewAnnotationPoint>): string {
  if (points.length === 0) return "";

  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} l 0.01 0.01`;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }

  const last = points[points.length - 1]!;
  path += ` L ${last.x} ${last.y}`;

  return path;
}

export function strokeBounds(
  points: ReadonlyArray<PreviewAnnotationPoint>,
  width: number,
): PreviewAnnotationRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  const right = Math.max(...xs) + padding;
  const bottom = Math.max(...ys) + padding;

  return { x: left, y: top, width: right - left, height: bottom - top };
}
