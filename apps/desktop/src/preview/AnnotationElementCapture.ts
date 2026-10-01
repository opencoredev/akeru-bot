// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import { getElementContext } from "react-grab/primitives";

import type { PickedElementPayload, PickedElementStackFrame } from "@akeru/contracts";

function toStackFrame(frame: {
  functionName?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}): PickedElementStackFrame {
  return {
    functionName: frame.functionName ?? null,
    fileName: frame.fileName ?? null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  };
}

export async function captureElement(element: Element): Promise<PickedElementPayload | null> {
  try {
    const context = await getElementContext(element);
    const stack = (context.stack ?? []).map(toStackFrame);
    return {
      pageUrl: location.href,
      pageTitle: document.title?.trim() || null,
      tagName: element.tagName.toLowerCase(),
      selector: context.selector,
      htmlPreview: context.htmlPreview ?? "",
      componentName: context.componentName,
      source: stack[0] ?? null,
      stack,
      styles: context.styles ?? "",
      pickedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
