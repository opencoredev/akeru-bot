import { createAnnotationStyleControls } from "./AnnotationStyleControls.ts";

// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import { ipcRenderer } from "electron";

import type {
  DesktopPreviewAnnotationTheme,
  PreviewAnnotationPayload,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
  PreviewAnnotationStyleChange,
  PreviewAnnotationSubmission,
} from "@akeru/contracts";

import { resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";

import { previewAnnotationStyles } from "./AnnotationStyles.generated.ts";

import { selectMarqueeElements } from "./MarqueeSelection.ts";

import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  MOUSE_NAVIGATE_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";

import { PRIMARY, createButton } from "./AnnotationStyleControls.ts";

import {
  OVERLAY_ATTRIBUTE,
  CONTENT_LAYER_Z_INDEX,
  type SelectedElement,
  rectFromDomRect,
  normalizeRect,
  isUsableRect,
  unionRects,
  isAnnotationNode,
  pickFromPoint,
  createBox,
  positionBox,
  createLabel,
  updateSelectedVisual,
  pathFromPoints,
  strokeBounds,
} from "./AnnotationGeometry.ts";

import { captureElement } from "./AnnotationElementCapture.ts";

const Z_INDEX_OVERLAY = 2147483646;

const PRIMARY_FILL = "color-mix(in srgb, var(--t3-primary) 10%, transparent)";

const MAX_MARQUEE_ELEMENTS = 20;

const CHROME_LAYER_Z_INDEX = 10;

type AnnotationTool = "select" | "marquee" | "draw" | "erase";

interface AnnotationSession {
  teardown: (notifyMain: boolean) => void;
  applyTheme: (theme: DesktopPreviewAnnotationTheme) => void;
}

let activeSession: AnnotationSession | null = null;

let idSequence = 0;

let annotationTheme: DesktopPreviewAnnotationTheme | null = null;

const applyAnnotationTheme = (
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void => {
  if (!theme) return;
  host.style.colorScheme = theme.colorScheme;

  const variables = {
    "--t3-radius": theme.radius,
    "--t3-background": theme.background,
    "--t3-foreground": theme.foreground,
    "--t3-popover": theme.popover,
    "--t3-popover-foreground": theme.popoverForeground,
    "--t3-primary": theme.primary,
    "--t3-primary-foreground": theme.primaryForeground,
    "--t3-muted": theme.muted,
    "--t3-muted-foreground": theme.mutedForeground,
    "--t3-accent": theme.accent,
    "--t3-accent-foreground": theme.accentForeground,
    "--t3-border": theme.border,
    "--t3-input": theme.input,
    "--t3-ring": theme.ring,
    "--t3-font-sans": theme.fontSans,
    "--t3-font-mono": theme.fontMono,
  };

  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }
};

const reportHumanPointerInput = (event: PointerEvent): void => {
  if (!event.isTrusted) return;
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
    kind: "pointer",
    x: event.clientX,
    y: event.clientY,
    button: event.button,
  });
};

const reportHumanKeyInput = (event: KeyboardEvent): void => {
  if (!event.isTrusted) return;
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
    kind: "key",
    key: event.key,
    code: event.code,
  });
};

window.addEventListener("pointerdown", reportHumanPointerInput, true);

window.addEventListener("keydown", reportHumanKeyInput, true);

// Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward.
const MOUSE_BUTTON_BACK = 3;

const MOUSE_BUTTON_FORWARD = 4;

const navigationDirectionForButton = (button: number): "back" | "forward" | null => {
  if (button === MOUSE_BUTTON_BACK) return "back";

  if (button === MOUSE_BUTTON_FORWARD) return "forward";

  return null;
};

// Chromium routes thumb-button history navigation to the *focused* WebContents,
// so hovering this guest without focusing it sends the host app's router back
// instead of the preview. Suppress Chromium's default here and drive this tab's
// history explicitly so the buttons always navigate the browser the pointer is
// over — never the host app.
const suppressNavigationButton = (event: MouseEvent): void => {
  if (!event.isTrusted || navigationDirectionForButton(event.button) === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};

const requestNavigationForButton = (event: MouseEvent): void => {
  if (!event.isTrusted) return;
  const direction = navigationDirectionForButton(event.button);

  if (direction === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send(MOUSE_NAVIGATE_CHANNEL, { direction });
};

window.addEventListener("mousedown", suppressNavigationButton, true);

window.addEventListener("mouseup", requestNavigationForButton, true);

window.addEventListener("auxclick", suppressNavigationButton, true);

const nextId = (prefix: string): string => {
  idSequence += 1;

  return `${prefix}_${idSequence.toString(36)}`;
};

function startAnnotation(): void {
  activeSession?.teardown(false);
  let finished = false;
  const host = document.createElement("div");
  host.setAttribute(OVERLAY_ATTRIBUTE, "");
  host.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX_OVERLAY};pointer-events:none`;
  applyAnnotationTheme(host, annotationTheme);
  const shadowRoot = host.attachShadow({ mode: "closed" });
  const themeStyle = document.createElement("style");
  themeStyle.textContent = previewAnnotationStyles;
  shadowRoot.appendChild(themeStyle);

  const root = document.createElement("div");
  root.setAttribute(OVERLAY_ATTRIBUTE, "");
  root.className = "fixed inset-0 font-sans text-foreground";
  root.style.cssText = "pointer-events:none";
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute(OVERLAY_ATTRIBUTE, "");
  cursorStyle.textContent = `html[data-t3code-annotation-tool] body, html[data-t3code-annotation-tool] body * { cursor: crosshair !important; } [${OVERLAY_ATTRIBUTE}], [${OVERLAY_ATTRIBUTE}] * { cursor: default !important; } [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-inner-spin-button, [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-outer-spin-button { appearance:none; margin:0; }`;
  document.documentElement.appendChild(cursorStyle);
  shadowRoot.appendChild(root);

  const hoverOutline = createBox(PRIMARY, PRIMARY_FILL);
  const marqueeBox = createBox(PRIMARY, PRIMARY_FILL);
  root.append(hoverOutline, marqueeBox);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute(OVERLAY_ATTRIBUTE, "");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.style.cssText = "position:fixed;inset:0;overflow:visible;pointer-events:none";
  svg.style.zIndex = String(CONTENT_LAYER_Z_INDEX);
  root.appendChild(svg);

  const toolbar = document.createElement("div");
  toolbar.setAttribute(OVERLAY_ATTRIBUTE, "");
  toolbar.className =
    "pointer-events-auto fixed top-2.5 left-1/2 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl";
  toolbar.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  root.appendChild(toolbar);

  const editor = document.createElement("div");
  editor.setAttribute(OVERLAY_ATTRIBUTE, "");
  editor.className =
    "pointer-events-auto fixed hidden max-h-[calc(100vh-16px)] w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-popover/96 text-popover-foreground shadow-2xl backdrop-blur-xl";
  editor.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  root.appendChild(editor);

  const composerRow = document.createElement("div");
  composerRow.className = "flex items-start gap-2 p-2";

  const adjust = createButton("", "Expand annotation editor");
  adjust.setAttribute("aria-label", "Expand annotation editor");
  adjust.setAttribute("aria-expanded", "false");
  adjust.className +=
    " h-8 w-8 shrink-0 bg-muted p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  adjust.innerHTML =
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12M7 3v4M13 8v4M9 13v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  composerRow.appendChild(adjust);

  const comment = document.createElement("textarea");
  comment.placeholder = "Describe the change…";
  comment.rows = 1;
  comment.className =
    "min-h-8 max-h-24 min-w-0 flex-1 resize-none overflow-y-hidden border-0 border-b border-b-transparent bg-transparent px-0 py-1.5 font-sans text-sm leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-b-primary focus:outline-none focus:ring-0";
  composerRow.appendChild(comment);

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.textContent = "⠿";
  dragHandle.title = "Drag annotation editor";
  dragHandle.className =
    "hidden h-8 w-6 shrink-0 cursor-grab select-none border-0 bg-transparent p-0 font-sans text-lg font-bold leading-5 text-muted-foreground";
  composerRow.appendChild(dragHandle);

  const submit = createButton("Attach", "Attach annotation and screenshot (Enter)");
  submit.className +=
    " h-8 shrink-0 border-primary bg-primary px-3 text-primary-foreground shadow-sm hover:bg-primary/90";
  composerRow.appendChild(submit);
  editor.appendChild(composerRow);

  const stylePanel = document.createElement("div");
  stylePanel.className =
    "hidden max-h-[min(176px,calc(100vh-180px))] overflow-auto border-t border-border bg-muted/40 px-3";
  editor.appendChild(stylePanel);

  const selected = new Map<Element, SelectedElement>();
  const regions: PreviewAnnotationRegionTarget[] = [];
  const strokes: PreviewAnnotationStrokeTarget[] = [];
  const styleChanges = new Map<string, PreviewAnnotationStyleChange>();
  const toolButtons = new Map<AnnotationTool, HTMLButtonElement>();
  let tool: AnnotationTool = "select";
  let dragStart: PreviewAnnotationPoint | null = null;
  let activeStroke: { target: PreviewAnnotationStrokeTarget; path: SVGPathElement } | null = null;
  let pendingCapture = false;
  let editorExpanded = false;
  let editorWasShown = false;
  let editorPosition: { left: number; top: number } | null = null;
  let editorDrag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  let editorLayoutFrame: number | null = null;

  const resizeComment = (): void => {
    const maxHeight = 96;
    comment.style.height = "auto";
    const nextHeight = Math.min(comment.scrollHeight, maxHeight);
    comment.style.height = `${nextHeight}px`;
    comment.style.overflowY = comment.scrollHeight > maxHeight ? "auto" : "hidden";
    queueEditorLayout();
  };

  comment.addEventListener("input", resizeComment);

  const updateStatus = (): void => {
    const hasTargets = selected.size > 0 || regions.length > 0 || strokes.length > 0;
    editor.style.display = hasTargets ? "flex" : "none";
    submit.disabled = !hasTargets;
    submit.style.opacity = hasTargets ? "1" : "0.45";
    adjust.disabled = !hasTargets;
    stylePanel.style.display = editorExpanded && selected.size > 0 ? "grid" : "none";
    queueEditorLayout();

    if (hasTargets && !editorWasShown) {
      editorWasShown = true;
      window.setTimeout(() => comment.focus({ preventScroll: true }), 0);
    }
  };

  const refreshToolButtons = (): void => {
    for (const [candidate, button] of toolButtons) {
      const active = candidate === tool;
      button.classList.toggle("bg-primary/10", active);
      button.classList.toggle("text-primary", active);
      button.classList.toggle("text-foreground", !active);
    }

    if (tool !== "select") hoverOutline.style.display = "none";

    if (tool !== "marquee") marqueeBox.style.display = "none";
    document.documentElement.setAttribute("data-t3code-annotation-tool", tool);
  };

  const removeSelected = (target: SelectedElement): void => {
    if (target.element instanceof HTMLElement || target.element instanceof SVGElement) {
      for (const [property, baseline] of target.baselineStyles) {
        if (baseline) target.element.style.setProperty(property, baseline);
        else target.element.style.removeProperty(property);
      }
    }

    selected.delete(target.element);
    target.outline.remove();
    target.label.remove();

    for (const [key, change] of styleChanges) {
      if (change.targetId === target.id) styleChanges.delete(key);
    }

    updateStatus();
  };

  const addSelected = (element: Element): void => {
    if (selected.has(element)) return;

    const target: SelectedElement = {
      id: nextId("element"),
      element,
      outline: createBox(PRIMARY, PRIMARY_FILL),
      label: createLabel(),
      baselineStyles: new Map(),
    };

    selected.set(element, target);
    root.append(target.outline, target.label);
    updateSelectedVisual(target);
    updateStatus();

    if (editorExpanded) {
      stylePanel.style.display = "grid";
      syncStyleControls();
    }
  };

  const toggleSelected = (element: Element, additive: boolean): void => {
    const existing = selected.get(element);

    if (existing) {
      removeSelected(existing);

      return;
    }

    if (!additive) {
      for (const target of Array.from(selected.values())) removeSelected(target);
    }

    addSelected(element);
  };

  const setStyleForSelected = (property: string, value: string): void => {
    for (const target of selected.values()) {
      if (!(target.element instanceof HTMLElement || target.element instanceof SVGElement))
        continue;

      if (!target.baselineStyles.has(property)) {
        target.baselineStyles.set(property, target.element.style.getPropertyValue(property));
      }

      const key = `${target.id}:${property}`;

      const previousValue =
        styleChanges.get(key)?.previousValue ??
        getComputedStyle(target.element).getPropertyValue(property).trim();

      target.element.style.setProperty(property, value, "important");
      styleChanges.set(key, {
        targetId: target.id,
        selector: null,
        property,
        previousValue,
        value,
      });
      updateSelectedVisual(target);
    }
  };

  const syncStyleControls = createAnnotationStyleControls({
    panel: stylePanel,
    selected,
    setStyleForSelected,
  });

  const tools: ReadonlyArray<[AnnotationTool, string, string]> = [
    ["select", "Select", "Select elements (V)"],
    ["marquee", "Region", "Draw a region or marquee-select elements (R)"],
    ["draw", "Draw", "Draw freehand (D)"],
    ["erase", "Erase", "Remove an annotation target (E)"],
  ];

  for (const [candidate, label, title] of tools) {
    const button = createButton(label, title);
    button.className += " h-8 px-2.5 text-sm";
    button.addEventListener("click", () => {
      tool = candidate;
      refreshToolButtons();
    });
    toolButtons.set(candidate, button);
    toolbar.appendChild(button);
  }

  const clampEditorPosition = (left: number, top: number): { left: number; top: number } => {
    const margin = 8;
    const rect = editor.getBoundingClientRect();

    return {
      left: Math.min(
        Math.max(margin, left),
        Math.max(margin, window.innerWidth - rect.width - margin),
      ),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, window.innerHeight - rect.height - margin),
      ),
    };
  };

  const applyEditorPosition = (position: { left: number; top: number }): void => {
    const clamped = clampEditorPosition(position.left, position.top);
    editor.style.left = `${clamped.left}px`;
    editor.style.top = `${clamped.top}px`;
    editor.style.right = "auto";
    editor.style.bottom = "auto";

    if (editorExpanded) editorPosition = clamped;
  };

  const getAnnotationBounds = (): PreviewAnnotationRect | null =>
    unionRects(
      [
        ...Array.from(selected.values(), (target) =>
          rectFromDomRect(target.element.getBoundingClientRect()),
        ),
        ...regions.map((region) => region.rect),
        ...strokes.map((stroke) => stroke.bounds),
      ],
      0,
    );

  const positionCompactEditor = (): void => {
    const bounds = getAnnotationBounds();

    if (!bounds) return;
    const editorRect = editor.getBoundingClientRect();
    const gap = 8;

    const candidates = [
      { left: bounds.x + bounds.width + gap, top: bounds.y },
      { left: bounds.x - editorRect.width - gap, top: bounds.y },
      {
        left: bounds.x + bounds.width - editorRect.width,
        top: bounds.y + bounds.height + gap,
      },
      {
        left: bounds.x + bounds.width - editorRect.width,
        top: bounds.y - editorRect.height - gap,
      },
    ];

    const overflow = (position: { left: number; top: number }): number =>
      Math.max(0, -position.left) +
      Math.max(0, -position.top) +
      Math.max(0, position.left + editorRect.width - window.innerWidth) +
      Math.max(0, position.top + editorRect.height - window.innerHeight);

    const best = candidates.reduce((current, candidate) =>
      overflow(candidate) < overflow(current) ? candidate : current,
    );

    applyEditorPosition(best);
  };

  function queueEditorLayout(): void {
    if (editorLayoutFrame !== null) window.cancelAnimationFrame(editorLayoutFrame);
    editorLayoutFrame = window.requestAnimationFrame(() => {
      editorLayoutFrame = null;

      if (editor.style.display === "none") return;

      if (editorExpanded && editorPosition) applyEditorPosition(editorPosition);
      else positionCompactEditor();
    });
  }

  adjust.addEventListener("click", () => {
    if (selected.size === 0) return;

    if (!editorExpanded) {
      const rect = editor.getBoundingClientRect();
      editorExpanded = true;
      editorPosition = { left: rect.left, top: rect.top };
      stylePanel.style.display = selected.size > 0 ? "grid" : "none";
      dragHandle.style.display = "block";
      adjust.setAttribute("aria-expanded", "true");
      adjust.title = "Collapse annotation editor";
      adjust.setAttribute("aria-label", "Collapse annotation editor");

      if (selected.size > 0) syncStyleControls();
    } else {
      editorExpanded = false;
      editorPosition = null;
      stylePanel.style.display = "none";
      dragHandle.style.display = "none";
      adjust.setAttribute("aria-expanded", "false");
      adjust.title = "Expand annotation editor";
      adjust.setAttribute("aria-label", "Expand annotation editor");
    }

    queueEditorLayout();
  });

  const onEditorPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !editorExpanded) return;
    const rect = editor.getBoundingClientRect();
    editorDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    dragHandle.setPointerCapture(event.pointerId);
    dragHandle.style.cursor = "grabbing";
    event.preventDefault();
    event.stopPropagation();
  };

  const onEditorPointerMove = (event: PointerEvent): void => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId) return;
    applyEditorPosition({
      left: event.clientX - editorDrag.offsetX,
      top: event.clientY - editorDrag.offsetY,
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const onEditorPointerUp = (event: PointerEvent): void => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId) return;
    editorDrag = null;
    dragHandle.style.cursor = "grab";

    if (dragHandle.hasPointerCapture(event.pointerId))
      dragHandle.releasePointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  dragHandle.addEventListener("pointerdown", onEditorPointerDown);
  dragHandle.addEventListener("pointermove", onEditorPointerMove);
  dragHandle.addEventListener("pointerup", onEditorPointerUp);
  dragHandle.addEventListener("pointercancel", onEditorPointerUp);

  const repaint = (): void => {
    for (const target of selected.values()) updateSelectedVisual(target);
    queueEditorLayout();
  };

  const removeTargetAtPoint = (x: number, y: number): boolean => {
    for (const target of Array.from(selected.values()).toReversed()) {
      const rect = target.element.getBoundingClientRect();

      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        removeSelected(target);

        return true;
      }
    }

    const regionIndex = regions.findIndex(
      (region) =>
        x >= region.rect.x &&
        x <= region.rect.x + region.rect.width &&
        y >= region.rect.y &&
        y <= region.rect.y + region.rect.height,
    );

    if (regionIndex >= 0) {
      const [removed] = regions.splice(regionIndex, 1);
      root.querySelector(`[data-region-id="${removed?.id}"]`)?.remove();
      updateStatus();

      return true;
    }

    const strokeIndex = strokes.findIndex(
      (stroke) =>
        x >= stroke.bounds.x &&
        x <= stroke.bounds.x + stroke.bounds.width &&
        y >= stroke.bounds.y &&
        y <= stroke.bounds.y + stroke.bounds.height,
    );

    if (strokeIndex >= 0) {
      const [removed] = strokes.splice(strokeIndex, 1);
      svg.querySelector(`[data-stroke-id="${removed?.id}"]`)?.remove();
      updateStatus();

      return true;
    }

    return false;
  };

  const selectElementsInRect = (rect: PreviewAnnotationRect): number => {
    const candidates = selectMarqueeElements({
      elements: document.querySelectorAll("body *"),
      rect,
      limit: MAX_MARQUEE_ELEMENTS,
      eligible: (element) =>
        !isAnnotationNode(element) &&
        (element.children.length === 0 ||
          element instanceof HTMLButtonElement ||
          element instanceof HTMLAnchorElement ||
          element.getAttribute("role") === "button"),
      measure: (element) => element.getBoundingClientRect(),
    });

    for (const candidate of candidates) addSelected(candidate);

    return candidates.length;
  };

  const clearHoverOutline = (): void => {
    hoverOutline.style.display = "none";
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (isAnnotationNode(event.target as Element)) {
      clearHoverOutline();

      return;
    }

    if (tool === "select" && dragStart === null) {
      const target = pickFromPoint(event.clientX, event.clientY);

      if (target) positionBox(hoverOutline, rectFromDomRect(target.getBoundingClientRect()));
      else clearHoverOutline();

      return;
    }

    clearHoverOutline();

    if (tool === "marquee" && dragStart) {
      positionBox(
        marqueeBox,
        normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY),
      );

      return;
    }

    if (tool === "draw" && activeStroke) {
      activeStroke.target.points = [
        ...activeStroke.target.points,
        { x: event.clientX, y: event.clientY },
      ];
      activeStroke.target.bounds = strokeBounds(
        activeStroke.target.points,
        activeStroke.target.width,
      );
      activeStroke.path.setAttribute("d", pathFromPoints(activeStroke.target.points));
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isAnnotationNode(event.target as Element)) return;
    event.preventDefault();
    event.stopPropagation();

    if (tool === "select") {
      const target = pickFromPoint(event.clientX, event.clientY);

      if (target) toggleSelected(target, event.shiftKey);

      return;
    }

    if (tool === "erase") {
      removeTargetAtPoint(event.clientX, event.clientY);

      return;
    }

    dragStart = { x: event.clientX, y: event.clientY };

    if (tool === "draw") {
      const stroke: PreviewAnnotationStrokeTarget = {
        id: nextId("stroke"),
        color: annotationTheme?.primary ?? "#2563eb",
        width: 4,
        points: [dragStart],
        bounds: { x: dragStart.x, y: dragStart.y, width: 1, height: 1 },
      };

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(OVERLAY_ATTRIBUTE, "");
      path.setAttribute("data-stroke-id", stroke.id);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke.color);
      path.setAttribute("stroke-width", String(stroke.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      activeStroke = { target: stroke, path };
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();

    if (tool === "marquee") {
      const rect = normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY);
      marqueeBox.style.display = "none";

      if (isUsableRect(rect)) {
        const found = selectElementsInRect(rect);

        if (found === 0) {
          const region: PreviewAnnotationRegionTarget = { id: nextId("region"), rect };
          regions.push(region);

          const regionBox = createBox(
            PRIMARY,
            "color-mix(in srgb, var(--t3-primary) 6%, transparent)",
          );

          regionBox.setAttribute("data-region-id", region.id);
          positionBox(regionBox, rect);
          root.appendChild(regionBox);
        }
      }
    } else if (tool === "draw" && activeStroke) {
      if (activeStroke.target.points.length > 1) strokes.push(activeStroke.target);
      else activeStroke.path.remove();
      activeStroke = null;
    }

    dragStart = null;
    updateStatus();
  };

  const onClick = (event: MouseEvent): void => {
    if (isAnnotationNode(event.target as Element)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) clearHoverOutline();
  };

  const onWindowBlur = (): void => {
    clearHoverOutline();
  };

  const restoreStyles = (): void => {
    for (const target of selected.values()) {
      if (!(target.element instanceof HTMLElement || target.element instanceof SVGElement))
        continue;

      for (const [property, baseline] of target.baselineStyles) {
        if (baseline) target.element.style.setProperty(property, baseline);
        else target.element.style.removeProperty(property);
      }
    }
  };

  const teardown = (notifyMain: boolean): void => {
    if (finished) return;
    finished = true;
    restoreStyles();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointerout", onPointerOut, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", repaint, true);
    window.removeEventListener("resize", repaint);
    dragHandle.removeEventListener("pointerdown", onEditorPointerDown);
    dragHandle.removeEventListener("pointermove", onEditorPointerMove);
    dragHandle.removeEventListener("pointerup", onEditorPointerUp);
    dragHandle.removeEventListener("pointercancel", onEditorPointerUp);

    if (editorLayoutFrame !== null) window.cancelAnimationFrame(editorLayoutFrame);
    ipcRenderer.off(CANCEL_PICK_CHANNEL, onCancel);
    ipcRenderer.off(ANNOTATION_CAPTURED_CHANNEL, onCaptured);
    document.documentElement.removeAttribute("data-t3code-annotation-tool");
    cursorStyle.remove();
    host.remove();
    activeSession = null;

    if (notifyMain) ipcRenderer.send(ELEMENT_PICKED_CHANNEL, null);
  };

  const onCancel = (): void => teardown(false);
  const onCaptured = (): void => teardown(false);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isAnnotationNode(event.target as Element) && event.key !== "Escape") return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      teardown(true);

      return;
    }

    if (event.key === "v") tool = "select";
    else if (event.key === "r") tool = "marquee";
    else if (event.key === "d") tool = "draw";
    else if (event.key === "e") tool = "erase";
    else return;
    refreshToolButtons();
  };

  const submitAnnotation = (submission: PreviewAnnotationSubmission): void => {
    if (pendingCapture || (selected.size === 0 && regions.length === 0 && strokes.length === 0))
      return;
    pendingCapture = true;
    submit.disabled = true;
    submit.textContent = "Capturing…";
    void Promise.all(
      Array.from(selected.values()).map(async (target) => {
        const element = await captureElement(target.element);

        if (!element) return null;

        for (const change of styleChanges.values()) {
          if (change.targetId === target.id) change.selector = element.selector;
        }

        return {
          id: target.id,
          element,
          rect: rectFromDomRect(target.element.getBoundingClientRect()),
        };
      }),
    ).then((captured) => {
      const elements = captured.filter((target) => target !== null);

      const annotation: PreviewAnnotationPayload = {
        id: nextId("annotation"),
        pageUrl: location.href,
        pageTitle: document.title?.trim() || null,
        comment: comment.value.trim(),
        elements,
        regions: [...regions],
        strokes: [...strokes],
        styleChanges: Array.from(styleChanges.values()),
        screenshot: null,
        createdAt: new Date().toISOString(),
      };

      editor.style.display = "none";
      toolbar.style.display = "none";
      hoverOutline.style.display = "none";

      const screenshotRect = unionRects([
        ...elements.map((target) => target.rect),
        ...regions.map((region) => region.rect),
        ...strokes.map((stroke) => stroke.bounds),
      ]);

      ipcRenderer.send(ELEMENT_PICKED_CHANNEL, annotation, screenshotRect, submission);
    });
  };

  submit.addEventListener("click", () => submitAnnotation("attach"));
  root.addEventListener("keydown", (event) => {
    const submission = event.target === comment ? resolveAnnotationSubmission(event) : null;
    // Keep this in the bubble phase so editor inputs receive the event before
    // it is isolated from listeners installed by the inspected page.
    event.stopImmediatePropagation();

    if (!submission) return;
    event.preventDefault();
    submitAnnotation(submission);
  });

  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  window.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  window.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
  window.addEventListener("click", onClick, { capture: true, passive: false });
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("scroll", repaint, { capture: true, passive: true });
  window.addEventListener("resize", repaint, { passive: true });
  ipcRenderer.on(CANCEL_PICK_CHANNEL, onCancel);
  ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, onCaptured);
  document.documentElement.appendChild(host);
  refreshToolButtons();
  updateStatus();
  activeSession = {
    teardown,
    applyTheme: (theme) => applyAnnotationTheme(host, theme),
  };
}

ipcRenderer.on(START_PICK_CHANNEL, (_event, theme: DesktopPreviewAnnotationTheme | undefined) => {
  if (theme) annotationTheme = theme;
  startAnnotation();
});

ipcRenderer.on(ANNOTATION_THEME_CHANNEL, (_event, theme: DesktopPreviewAnnotationTheme) => {
  annotationTheme = theme;
  activeSession?.applyTheme(theme);
});

ipcRenderer.on(CANCEL_PICK_CHANNEL, () => activeSession?.teardown(false));
