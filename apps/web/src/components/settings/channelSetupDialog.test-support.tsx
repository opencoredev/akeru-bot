import { BotId, ChannelConnectionId, EnvironmentId, ProjectId } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { expect } from "vite-plus/test";

export // This node-only suite gives ReactDOM a host without a browser DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  readonly tagName: string;
  readonly nodeName: string;
  private text = "";

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.tagName = name.toUpperCase();
    this.nodeName = this.tagName;
  }
  get textContent(): string {
    return this.text + this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.childNodes = [];
  }
  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);

    return child;
  }
  insertBefore(child: TestNode, before: TestNode) {
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);

    return child;
  }
  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;

    return child;
  }
  createElement(name: string) {
    return new TestNode(name, this);
  }
  createElementNS(_namespace: string, name: string) {
    return new TestNode(name, this);
  }
  createTextNode(text: string) {
    const node = new TestNode("#text", this, 3);
    node.textContent = text;

    return node;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

export const firstProject = ProjectId.make("project-first");

export const botProject = ProjectId.make("project-bot");

export const conflict = {
  _tag: "Failure" as const,
  cause: Cause.fail(new Error("This channel connection is already connected to another bot.")),
};

export function createChannelSetupActions(mocks: {
  buttons: Map<string, { onClick?: () => void; disabled?: boolean }>;
  inputs: Map<string, { onChange: (event: { currentTarget: { value: string } }) => void }>;
}) {
  async function click(label: string) {
    const button = mocks.buttons.get(label);
    expect(button).toBeDefined();
    expect(button?.disabled).not.toBe(true);
    await act(async () => {
      button?.onClick?.();
    });
  }

  async function fill(label: string, value: string) {
    const input = mocks.inputs.get(label);
    expect(input).toBeDefined();
    await act(() => input?.onChange({ currentTarget: { value } }));
  }

  async function completeSetup() {
    await click("Continue");
    await fill("Telegram Bot token", "test-token");
    await click("Continue");
    await fill("Connection name", "Test line");
  }

  return { click, fill, completeSetup };
}

export function createChannelSetupProps(
  onSaved: (connectionId: ChannelConnectionId) => void,
  onOpenChange: (open: boolean) => void,
) {
  return {
    environmentId: EnvironmentId.make("test-environment"),
    provider: "telegram" as const,
    bots: [{ id: BotId.make("test-bot"), name: "Test bot" }],
    open: true,
    onSaved,
    onOpenChange,
  };
}
