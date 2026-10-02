import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WsRpcGroup } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

export class TransferHttpRequestError extends Schema.TaggedErrorClass<TransferHttpRequestError>()(
  "TransferHttpRequestError",
  {
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface HttpTransferMeasurement {
  readonly status: number;
  readonly contentEncoding: string | null;
  readonly encodedBody: Uint8Array;
  readonly encodedBodyBytes: number;
  readonly decodedBody: Uint8Array;
  readonly decodedBodyBytes: number;
  /** HTTP response bytes read from the socket, including status line and headers. */
  readonly wireBytes: number;
}

export const measureHttpGet = Effect.fn("TransferBudget.measureHttpGet")(function* (input: {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}) {
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<HttpTransferMeasurement>((resolve, reject) => {
        let socketBytesBeforeResponse = 0;

        const request = NodeHttp.get(
          input.url,
          {
            agent: false,
            headers: {
              "accept-encoding": "gzip",
              connection: "close",
              ...input.headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () => {
              try {
                const encodedBody = Buffer.concat(chunks);
                const header = response.headers["content-encoding"];

                const contentEncoding = Array.isArray(header)
                  ? (header[0] ?? null)
                  : (header ?? null);

                const decodedBody =
                  contentEncoding === "gzip" ? NodeZlib.gunzipSync(encodedBody) : encodedBody;

                resolve({
                  status: response.statusCode ?? 0,
                  contentEncoding,
                  encodedBody,
                  encodedBodyBytes: encodedBody.byteLength,
                  decodedBody,
                  decodedBodyBytes: decodedBody.byteLength,
                  wireBytes: Math.max(0, response.socket.bytesRead - socketBytesBeforeResponse),
                });
              } catch (cause) {
                reject(cause);
              }
            });
          },
        );

        request.once("socket", (socket) => {
          socketBytesBeforeResponse = socket.bytesRead;
        });
        request.once("error", reject);
        request.setTimeout(10_000, () => {
          request.destroy(new Error(`Timed out reading ${input.url}`));
        });
      }),
    catch: (cause) => new TransferHttpRequestError({ url: input.url, cause }),
  });
});

export interface WebSocketTransferTotals {
  readonly wireBytes: number;
  readonly decodedBytes: number;
  readonly messages: number;
}

export interface WebSocketTransferRecorder {
  readonly connect: (
    url: string,
    protocols: string | string[] | undefined,
    cookie: string,
  ) => globalThis.WebSocket;
  readonly totals: () => WebSocketTransferTotals;
  readonly negotiatedExtensions: () => string;
}

interface NodeWebSocketWithTransport extends NodeSocket.NodeWS.WebSocket {
  readonly _socket?: {
    readonly bytesRead: number;
  };
}

class TransportCloseEvent extends Event implements CloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  constructor(code: number, reason: string, wasClean: boolean) {
    super("close");
    this.code = code;
    this.reason = reason;
    this.wasClean = wasClean;
  }
}

class BrowserWebSocketTransport extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  onopen: WebSocket["onopen"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  private readonly socket: NodeSocket.NodeWS.WebSocket;
  private selectedBinaryType: WebSocket["binaryType"] = "arraybuffer";
  constructor(socket: NodeSocket.NodeWS.WebSocket) {
    super();
    this.socket = socket;
    socket.on("open", () => {
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    });
    socket.on("message", (data, binary) => {
      const chunks = Array.isArray(data) ? data : [data];

      const bytes = Buffer.concat(
        chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
      );

      const payload = binary
        ? this.selectedBinaryType === "nodebuffer"
          ? bytes
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes.toString();

      const event = new MessageEvent("message", { data: payload });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    });
    socket.on("error", () => {
      const event = new Event("error");
      this.onerror?.(event);
      this.dispatchEvent(event);
    });
    socket.on("close", (code, reason) => {
      const event = new TransportCloseEvent(code, reason.toString(), code === 1000);
      this.onclose?.(event);
      this.dispatchEvent(event);
    });
  }
  get binaryType(): WebSocket["binaryType"] {
    return this.selectedBinaryType;
  }
  set binaryType(value: WebSocket["binaryType"]) {
    this.selectedBinaryType = value;
    this.socket.binaryType = "arraybuffer";
  }
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  get extensions() {
    return this.socket.extensions;
  }
  get protocol() {
    return this.socket.protocol;
  }
  get readyState() {
    return this.socket.readyState;
  }
  get url() {
    return this.socket.url;
  }
  get URL() {
    return this.socket.url;
  }
  ping(data?: string | ArrayBufferView | ArrayBufferLike) {
    this.socket.ping(data);
  }
  pong(data?: string | ArrayBufferView | ArrayBufferLike) {
    this.socket.pong(data);
  }
  terminate() {
    this.socket.terminate();
  }
  close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }
  send(data: Parameters<WebSocket["send"]>[0]) {
    this.socket.send(data);
  }
}

function rawDataBytes(data: NodeSocket.NodeWS.RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  return data.byteLength;
}

export function makeWebSocketTransferRecorder(): WebSocketTransferRecorder {
  let socket: NodeWebSocketWithTransport | null = null;
  let decodedBytes = 0;
  let messages = 0;

  return {
    connect: (url, protocols, cookie) => {
      // SAFETY: ws owns this optional native socket handle; only its bytesRead counter is inspected for integration transport measurement.
      const nextSocket = new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { cookie },
        perMessageDeflate: true,
      }) as NodeWebSocketWithTransport;

      socket = nextSocket;
      nextSocket.on("message", (data) => {
        const bytes = rawDataBytes(data);
        decodedBytes += bytes;
        messages += 1;
      });

      return new BrowserWebSocketTransport(nextSocket);
    },
    totals: () => ({
      wireBytes: socket?._socket?.bytesRead ?? 0,
      decodedBytes,
      messages,
    }),
    negotiatedExtensions: () => socket?.extensions ?? "",
  };
}

export function transferDelta(
  start: WebSocketTransferTotals,
  end: WebSocketTransferTotals,
): WebSocketTransferTotals {
  return {
    wireBytes: Math.max(0, end.wireBytes - start.wireBytes),
    decodedBytes: Math.max(0, end.decodedBytes - start.decodedBytes),
    messages: Math.max(0, end.messages - start.messages),
  };
}

export function countingWsRpcProtocolLayer(input: {
  readonly url: string;
  readonly cookie: string;
  readonly recorder: WebSocketTransferRecorder;
}) {
  const webSocketConstructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url, protocols) =>
    input.recorder.connect(url, protocols, input.cookie),
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(input.url, { openTimeout: "10 seconds" }).pipe(
        Layer.provide(webSocketConstructorLayer),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
}

export const makeCountingWsRpcClient = RpcClient.make(WsRpcGroup);

export type CountingWsRpcClient = Effect.Success<typeof makeCountingWsRpcClient>;
