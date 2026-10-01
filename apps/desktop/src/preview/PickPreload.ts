import { installGuestInputListeners } from "./GuestInput.ts";
import {
  createAnnotationOverlay,
  applyAnnotationTheme,
  PRIMARY_FILL,
} from "./AnnotationOverlay.ts";
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

import { selectMarqueeElements } from "./MarqueeSelection.ts";

import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";

import { PRIMARY, createButton } from "./AnnotationStyleControls.ts";

import {
  OVERLAY_ATTRIBUTE,
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

const MAX_MARQUEE_ELEMENTS = 20;

type AnnotationTool = "select" | "marquee" | "draw" | "erase";

interface AnnotationSession {
  teardown: (notifyMain: boolean) => void;
  applyTheme: (theme: DesktopPreviewAnnotationTheme) => void;
}

let activeSession: AnnotationSession | null = null;

let idSequence = 0;

let annotationTheme: DesktopPreviewAnnotationTheme | null = null;

installGuestInputListeners();

const nextId = (prefix: string): string => {
  idSequence += 1;

  return `${prefix}_${idSequence.toString(36)}`;
};

function startAnnotation(): void {
  activeSession?.teardown(false);
  let finished = false;

  const {
    host,
    root,
    cursorStyle,
    hoverOutline,
    marqueeBox,
    svg,
    toolbar,
    editor,
    adjust,
    comment,
    dragHandle,
    submit,
    stylePanel,
  } = createAnnotationOverlay(annotationTheme);

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

  const clampEditorPosition = (left: number, top: number) => {
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
    if (isAnnotationNode(event.target)) {
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
    if (event.button !== 0 || isAnnotationNode(event.target)) return;
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
    if (isAnnotationNode(event.target)) return;
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
    if (isAnnotationNode(event.target) && event.key !== "Escape") return;

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
