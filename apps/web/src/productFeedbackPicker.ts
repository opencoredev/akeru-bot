import {
  PRODUCT_FEEDBACK_ELEMENT_LABEL_MAX_CHARS,
  type ProductFeedbackElement,
} from "@t3tools/contracts";

const EXCLUDED_SELECTOR = [
  "input",
  "textarea",
  "select",
  "option",
  "[contenteditable]",
  "[data-akeru-feedback-ui]",
  "[data-feedback-private]",
  "[data-sensitive]",
  "[aria-label*='password' i]",
  "[aria-label*='secret' i]",
  "[aria-label*='token' i]",
].join(",");

const SAFE_NAME_PATTERN = /^[a-z0-9_.:-]{1,128}$/i;
const TOKEN_PATTERN = /(?:[a-z0-9_-]{24,}|(?:sk|pk)_[a-z0-9_-]+)/gi;
const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const PATH_PATTERN = /(?:[a-z]:\\|\/)[^\s]+/gi;

function safeName(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && SAFE_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

function safeLabel(element: Element): string | undefined {
  const explicit = element.getAttribute("aria-label") ?? element.getAttribute("title");
  const tagName = element.tagName.toLowerCase();
  const fallback = tagName === "button" || tagName === "a" ? element.textContent : null;
  const normalized = (explicit ?? fallback ?? "")
    .replace(TOKEN_PATTERN, "[redacted]")
    .replace(URL_PATTERN, "[url]")
    .replace(PATH_PATTERN, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PRODUCT_FEEDBACK_ELEMENT_LABEL_MAX_CHARS);
  return normalized || undefined;
}

function elementRole(element: Element): string | undefined {
  const explicit = safeName(element.getAttribute("role"));
  if (explicit) return explicit;
  switch (element.tagName.toLowerCase()) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    default:
      return undefined;
  }
}

function selectorSegment(element: Element): string {
  const component = safeName(element.getAttribute("data-component"));
  const target = safeName(element.getAttribute("data-feedback-target"));
  if (target) return `${element.tagName.toLowerCase()}[data-feedback-target="${target}"]`;
  if (component) return `${element.tagName.toLowerCase()}[data-component="${component}"]`;
  const explicitRole = safeName(element.getAttribute("role"));
  if (explicitRole) return `${element.tagName.toLowerCase()}[role="${explicitRole}"]`;
  const parent = element.parentElement;
  if (!parent) return element.tagName.toLowerCase();
  const sameTag = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  const position = sameTag.indexOf(element) + 1;
  return `${element.tagName.toLowerCase()}:nth-of-type(${Math.max(1, position)})`;
}

function stableSelector(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && segments.length < 4) {
    segments.unshift(selectorSegment(current));
    if (current.hasAttribute("data-feedback-target") || current.hasAttribute("data-component")) {
      break;
    }
    current = current.parentElement;
  }
  return segments.join(" > ").slice(0, 256);
}

export function isProductFeedbackPickable(element: Element): boolean {
  return element.closest(EXCLUDED_SELECTOR) === null;
}

export function productFeedbackElementDescriptor(element: Element): ProductFeedbackElement | null {
  if (!isProductFeedbackPickable(element)) return null;
  if (element === document.body || element === document.documentElement) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const owner = element.closest("[data-component]");
  const component = safeName(owner?.getAttribute("data-component") ?? null);
  const source = safeName(owner?.getAttribute("data-source") ?? null);
  const role = elementRole(element);
  const label = safeLabel(element);
  return {
    selector: stableSelector(element),
    ...(component ? { component } : {}),
    ...(source ? { source } : {}),
    ...(role ? { role } : {}),
    ...(label ? { label } : {}),
  };
}

export interface ProductFeedbackPickerSession {
  readonly stop: () => void;
}

export function startProductFeedbackElementPicker(input: {
  readonly onPick: (element: ProductFeedbackElement) => void;
  readonly onCancel: () => void;
}): ProductFeedbackPickerSession {
  const outline = document.createElement("div");
  const label = document.createElement("div");
  const instructions = document.createElement("div");
  const instructionText = document.createElement("span");
  const cancelButton = document.createElement("button");
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  outline.dataset.akeruFeedbackUi = "picker-outline";
  label.dataset.akeruFeedbackUi = "picker-label";
  instructions.dataset.akeruFeedbackUi = "picker-instructions";
  outline.setAttribute("aria-hidden", "true");
  label.setAttribute("aria-hidden", "true");
  Object.assign(outline.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483646",
    border: "2px solid var(--primary)",
    background: "color-mix(in srgb, var(--primary) 10%, transparent)",
    display: "none",
  });
  Object.assign(label.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    borderRadius: "4px",
    padding: "3px 6px",
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    font: "12px system-ui, sans-serif",
    display: "none",
  });
  Object.assign(instructions.style, {
    position: "fixed",
    zIndex: "2147483647",
    left: "50%",
    bottom: "20px",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    maxWidth: "calc(100vw - 24px)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    padding: "8px 10px 8px 12px",
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.2)",
    font: "13px system-ui, sans-serif",
  });
  instructionText.textContent = "Choose an element. Press Escape to cancel.";
  instructions.setAttribute("role", "status");
  instructions.setAttribute("aria-live", "polite");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.dataset.akeruFeedbackUi = "picker-cancel";
  Object.assign(cancelButton.style, {
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "4px 8px",
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
  });
  instructions.append(instructionText, cancelButton);
  document.body.append(outline, label, instructions);
  let hovered: Element | null = null;
  let stopped = false;

  const hide = () => {
    outline.style.display = "none";
    label.style.display = "none";
  };
  const meaningfulTarget = (element: Element): Element =>
    element.closest("button, a, [role], [data-feedback-target], [data-component]") ?? element;
  const show = (target: Element) => {
    const element = meaningfulTarget(target);
    const descriptor = productFeedbackElementDescriptor(element);
    if (!descriptor) {
      hovered = null;
      hide();
      return;
    }
    hovered = element;
    const rect = element.getBoundingClientRect();
    Object.assign(outline.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    label.textContent = descriptor.label ?? descriptor.role ?? element.tagName.toLowerCase();
    Object.assign(label.style, {
      display: "block",
      left: `${Math.max(4, rect.left)}px`,
      top: `${Math.max(4, rect.top - 25)}px`,
    });
  };
  const onPointerMove = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target === hovered) return;
    show(target);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", reposition, true);
    window.removeEventListener("scroll", reposition, true);
    outline.remove();
    label.remove();
    instructions.remove();
    previousFocus?.focus();
  };
  const isPickerUi = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-akeru-feedback-ui]") !== null;
  const onPointerDown = (event: PointerEvent) => {
    if (isPickerUi(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onClick = (event: MouseEvent) => {
    if (isPickerUi(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    const descriptor =
      target instanceof Element ? productFeedbackElementDescriptor(meaningfulTarget(target)) : null;
    if (!descriptor) return;
    stop();
    input.onPick(descriptor);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stop();
    input.onCancel();
  };
  const reposition = () => {
    if (hovered) show(hovered);
  };
  cancelButton.addEventListener("click", () => {
    stop();
    input.onCancel();
  });
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", reposition, true);
  window.addEventListener("scroll", reposition, true);
  cancelButton.focus();
  return { stop };
}
