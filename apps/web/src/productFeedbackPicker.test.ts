import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  productFeedbackElementDescriptor,
  startProductFeedbackElementPicker,
} from "./productFeedbackPicker";

class TestElement {
  readonly attributes = new Map<string, string>();
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  parentElement: TestElement | null = null;
  textContent: string | null = null;
  ownerDocument: TestDocument | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly tagName: string) {}

  append(...children: TestElement[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  getAttribute(name: string) {
    if (name === "data-component") return this.dataset.component ?? null;
    if (name === "data-source") return this.dataset.source ?? null;
    if (name === "data-feedback-target") return this.dataset.feedbackTarget ?? null;
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  hasAttribute(name: string) {
    return this.getAttribute(name) !== null;
  }

  closest(selector: string): TestElement | null {
    let current: TestElement | null = this;
    while (current) {
      if (selector === "[data-component]" && current.dataset.component) return current;
      if (
        selector === "[data-akeru-feedback-ui]" &&
        current.dataset.akeruFeedbackUi !== undefined
      ) {
        return current;
      }
      if (
        selector === "button, a, [role], [data-feedback-target], [data-component]" &&
        (current.tagName === "BUTTON" ||
          current.tagName === "A" ||
          current.attributes.has("role") ||
          current.dataset.feedbackTarget !== undefined ||
          current.dataset.component !== undefined)
      ) {
        return current;
      }
      if (
        selector.includes(",") &&
        (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(current.tagName) ||
          current.attributes.has("contenteditable") ||
          current.dataset.akeruFeedbackUi !== undefined ||
          current.dataset.feedbackPrivate !== undefined ||
          current.dataset.sensitive !== undefined)
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  getBoundingClientRect() {
    return { left: 10, top: 20, width: 100, height: 30 } as DOMRect;
  }
}

class TestDocument {
  readonly documentElement = new TestElement("HTML");
  readonly body = new TestElement("BODY");
  private readonly listeners = new Map<string, Set<(event: never) => void>>();
  activeElement: TestElement | null = null;

  constructor() {
    this.documentElement.append(this.body);
  }

  createElement(tagName: string) {
    const element = new TestElement(tagName.toUpperCase());
    element.ownerDocument = this;
    return element;
  }

  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: never) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  querySelector() {
    return this.body.children.find((child) => child.dataset.akeruFeedbackUi !== undefined) ?? null;
  }
}

let testDocument: TestDocument;

beforeEach(() => {
  testDocument = new TestDocument();
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal("document", testDocument);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

describe("product feedback element picker", () => {
  it("selects a privacy-safe descriptor and cleans up", () => {
    const button = testDocument.createElement("button");
    button.dataset.component = "ComposerSendButton";
    button.dataset.source = "chat.composer";
    button.textContent = "Send";
    testDocument.body.append(button);
    const onPick = vi.fn();
    const session = startProductFeedbackElementPicker({ onPick, onCancel: vi.fn() });

    testDocument.emit("click", {
      target: button,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    });

    expect(onPick).toHaveBeenCalledWith({
      selector: 'button[data-component="ComposerSendButton"]',
      component: "ComposerSendButton",
      source: "chat.composer",
      role: "button",
      label: "Send",
    });
    session.stop();
    expect(testDocument.querySelector()).toBeNull();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    startProductFeedbackElementPicker({ onPick: vi.fn(), onCancel });
    testDocument.emit("keydown", {
      key: "Escape",
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("promotes nested labels and builds a valid native button selector", () => {
    const button = testDocument.createElement("button");
    const label = testDocument.createElement("span");
    label.textContent = "Send";
    button.textContent = "Send";
    button.append(label);
    testDocument.body.append(button);
    const onPick = vi.fn();
    startProductFeedbackElementPicker({ onPick, onCancel: vi.fn() });

    testDocument.emit("click", {
      target: label,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    });

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: "body:nth-of-type(1) > button:nth-of-type(1)",
        role: "button",
      }),
    );
  });

  it("never captures form values, private UI, tokens, or paths", () => {
    const input = testDocument.createElement("input");
    expect(productFeedbackElementDescriptor(input as unknown as Element)).toBeNull();

    const privateNode = testDocument.createElement("button");
    privateNode.dataset.feedbackPrivate = "true";
    privateNode.textContent = "Private";
    expect(productFeedbackElementDescriptor(privateNode as unknown as Element)).toBeNull();

    const button = testDocument.createElement("button");
    button.textContent =
      "Open sk_abcdefghijklmnopqrstuvwxyz /Users/alice/private/file.ts https://private.example/path";
    const descriptor = productFeedbackElementDescriptor(button as unknown as Element);
    expect(descriptor?.label).toContain("[redacted]");
    expect(descriptor?.label).toContain("[path]");
    expect(descriptor?.label).toContain("[url]");
    expect(JSON.stringify(descriptor)).not.toContain("alice");
  });
});
