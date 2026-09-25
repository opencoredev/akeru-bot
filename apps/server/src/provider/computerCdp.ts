import { Schema } from "effect";
import type { AkeruBrowserEndpoint } from "./botWorkspace.ts";

const Targets = Schema.Array(
  Schema.Struct({ type: Schema.String, webSocketDebuggerUrl: Schema.optional(Schema.String) }),
);
const Message = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const Document = Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Number }) });
const Node = Schema.Struct({ nodeId: Schema.Number });
const Box = Schema.Struct({ model: Schema.Struct({ content: Schema.Array(Schema.Number) }) });
const AXTree = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      ignored: Schema.optional(Schema.Boolean),
      role: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
      name: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
      backendDOMNodeId: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeTargets = Schema.decodeUnknownSync(Targets);
const decodeMessage = Schema.decodeUnknownSync(Message);
const decodeDocument = Schema.decodeUnknownSync(Document);
const decodeNode = Schema.decodeUnknownSync(Node);
const decodeBox = Schema.decodeUnknownSync(Box);
const decodeAXTree = Schema.decodeUnknownSync(AXTree);

/** Direct CDP connection to the workspace's existing graphical Chromium, never a second browser. */
export class ComputerCdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const message = decodeMessage(JSON.parse(String(event.data)));
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined)
          pending?.reject(new Error("Graphical browser command failed."));
        else pending?.resolve(message.result);
      } catch {
        this.close();
      }
    });
    socket.addEventListener("close", () => this.rejectPending());
    socket.addEventListener("error", () => this.rejectPending());
  }

  static async connect(endpoint: AkeruBrowserEndpoint) {
    const url = new URL(
      "json/list",
      endpoint.url.endsWith("/") ? endpoint.url : `${endpoint.url}/`,
    );
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(url, {
      headers: endpoint.requestHeaders,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Graphical browser discovery failed.");
    const targets = decodeTargets(await response.json());
    const target = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("Graphical browser page is unavailable.");
    const address = new URL(endpoint.url);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    address.pathname = new URL(target.webSocketDebuggerUrl).pathname;
    const token = endpoint.requestHeaders["x-daytona-preview-token"];
    if (token) address.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", token);
    const socket = new WebSocket(address);
    const client = new ComputerCdp(socket);
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(30_000);
      const abort = () => {
        client.close();
        reject(new Error("Graphical browser connection timed out."));
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener(
        "open",
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          signal.removeEventListener("abort", abort);
          reject(new Error("Graphical browser connection failed."));
        },
        { once: true },
      );
    });
    return client;
  }

  private rejectPending() {
    for (const pending of this.pending.values())
      pending.reject(new Error("Graphical browser disconnected."));
    this.pending.clear();
  }

  close() {
    this.rejectPending();
    this.socket.close();
  }

  private request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Graphical browser disconnected."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(30_000);
      const abort = () => {
        this.close();
        reject(new Error("Graphical browser command timed out."));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async call(name: string, input: Readonly<Record<string, unknown>>) {
    if (name === "goto") {
      await this.request("Page.navigate", { url: input.url });
      return "Navigated.";
    }
    if (name === "tree") {
      const tree = decodeAXTree(await this.request("Accessibility.getFullAXTree"));
      return tree.nodes
        .filter((node) => !node.ignored)
        .map(
          (node) =>
            `${String(node.role?.value ?? "")} ${String(node.name?.value ?? "")} [backendNodeId=${node.backendDOMNodeId ?? ""}]`,
        )
        .join("\n")
        .slice(0, 50 * 1024);
    }
    if (name !== "click" && name !== "fill")
      throw new Error("Unsupported graphical browser operation.");
    let target: { nodeId: number } | { backendNodeId: number };
    if (typeof input.selector === "string") {
      const document = decodeDocument(await this.request("DOM.getDocument"));
      target = decodeNode(
        await this.request("DOM.querySelector", {
          nodeId: document.root.nodeId,
          selector: input.selector,
        }),
      );
      if (target.nodeId === 0) throw new Error("Graphical browser selector did not match.");
    } else if (typeof input.backendNodeId === "number")
      target = { backendNodeId: input.backendNodeId };
    else throw new Error("Graphical browser target is required.");
    await this.request("DOM.scrollIntoViewIfNeeded", target);
    if (name === "click") {
      const box = decodeBox(await this.request("DOM.getBoxModel", target));
      const points = box.model.content;
      if (points.length !== 8) throw new Error("Graphical browser target has no bounds.");
      const x = (points[0]! + points[4]!) / 2;
      const y = (points[1]! + points[5]!) / 2;
      await this.request("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await this.request("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    } else {
      await this.request("DOM.focus", target);
      await this.request("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      });
      await this.request("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      });
      await this.request("Input.insertText", { text: input.value });
    }
    return "Completed.";
  }
}
