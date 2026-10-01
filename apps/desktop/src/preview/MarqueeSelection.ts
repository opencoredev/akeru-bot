import type { PreviewAnnotationRect } from "@akeru/contracts";

interface ElementBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export function selectMarqueeElements<ElementType>(input: {
  readonly elements: Iterable<ElementType>;
  readonly rect: PreviewAnnotationRect;
  readonly limit: number;
  readonly eligible: (element: ElementType) => boolean;
  readonly measure: (element: ElementType) => ElementBounds;
}): ElementType[] {
  const candidates: { element: ElementType; area: number }[] = [];
  if (input.limit <= 0) return [];

  for (const element of input.elements) {
    if (!input.eligible(element)) continue;
    const bounds = input.measure(element);
    if (bounds.width < 2 || bounds.height < 2) continue;
    if (
      bounds.right < input.rect.x ||
      bounds.left > input.rect.x + input.rect.width ||
      bounds.bottom < input.rect.y ||
      bounds.top > input.rect.y + input.rect.height
    )
      continue;

    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    if (
      centerX < input.rect.x ||
      centerX > input.rect.x + input.rect.width ||
      centerY < input.rect.y ||
      centerY > input.rect.y + input.rect.height
    )
      continue;

    const area = bounds.width * bounds.height;
    const insertionIndex = candidates.findIndex((candidate) => candidate.area > area);
    if (insertionIndex < 0) {
      if (candidates.length < input.limit) candidates.push({ element, area });
    } else {
      candidates.splice(insertionIndex, 0, { element, area });
      if (candidates.length > input.limit) candidates.pop();
    }
  }

  return candidates.map((candidate) => candidate.element);
}
