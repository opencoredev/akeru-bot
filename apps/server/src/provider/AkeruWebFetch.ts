// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Public-web backends for the WebFetch and WebSearch catalog tools.
 *
 * WebFetch resolves each hop's hostname once, rejects the hop if any resolved
 * address is private, and pins the socket to the validated address through a
 * custom `lookup`. The connection therefore never performs a second DNS query,
 * which closes the rebinding window between validation and connect. Bodies are
 * streamed with a byte cap and truncated with a visible marker.
 */
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

export const AKERU_WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const AKERU_WEB_FETCH_TIMEOUT_MS = 15_000;
export const AKERU_WEB_FETCH_MAX_REDIRECTS = 5;
export const AKERU_WEB_FETCH_TRUNCATION_MARKER = "\n\n[WebFetch truncated the response at";

// Separate lists because a BlockList also matches IPv4 addresses against
// IPv4-mapped IPv6 rules, which would block every public IPv4 address.
const PRIVATE_IPV4 = (() => {
  const list = new NodeNet.BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  return list;
})();

const PRIVATE_IPV6 = (() => {
  const list = new NodeNet.BlockList();
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    // IPv4-mapped and IPv4-compatible forms can smuggle any IPv4 address.
    ["::ffff:0:0", 96],
    ["::", 96],
    // NAT64 and 6to4 prefixes also embed an IPv4 address the network can reach.
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    // Deprecated site-local space is still routed on some internal networks.
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
})();

/** True for loopback, private, link-local, CGNAT, multicast, and mapped addresses. */
export function isAkeruPrivateAddress(address: string): boolean {
  const family = NodeNet.isIP(address);
  if (family === 4) return PRIVATE_IPV4.check(address, "ipv4");
  if (family === 6) return PRIVATE_IPV6.check(address, "ipv6");
  return false;
}

/**
 * Shape check for a WebFetch URL. It rejects non-HTTP(S) schemes, embedded
 * credentials, local hostnames, and private literal addresses. DNS validation
 * happens only in the fetch backend, against the address it connects to.
 */
export function parseAkeruPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WebFetch URL must be valid HTTP or HTTPS.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("WebFetch only accepts public HTTP(S) URLs without credentials.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isAkeruPrivateAddress(host)
  ) {
    throw new Error("WebFetch rejects private, loopback, and local addresses.");
  }
  return url;
}

export type AkeruWebFetchLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

export interface AkeruWebFetchOptions {
  readonly lookup?: AkeruWebFetchLookup;
  /** Tests allow loopback here. Production rejects every private address. */
  readonly allowAddress?: (address: string) => boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export interface AkeruWebFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
  readonly truncated: boolean;
}

interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

async function resolvePinnedAddress(
  url: URL,
  lookup: AkeruWebFetchLookup,
  allowAddress: (address: string) => boolean,
): Promise<PinnedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = NodeNet.isIP(host);
  const records = literal !== 0 ? [{ address: host, family: literal }] : await lookup(host);
  if (records.length === 0) throw new Error(`WebFetch could not resolve ${host}.`);
  if (records.some((record) => !allowAddress(record.address))) {
    throw new Error("WebFetch rejects private, loopback, and local addresses.");
  }
  const first = records[0]!;
  return { address: first.address, family: NodeNet.isIP(first.address) === 6 ? 6 : 4 };
}

function pinnedLookup(pinned: PinnedAddress): NodeHttp.RequestOptions["lookup"] {
  return ((
    _hostname: string,
    options: { readonly all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options?.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  }) as NodeHttp.RequestOptions["lookup"];
}

interface HopResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly contentType: string | null;
  readonly body: Buffer;
  readonly truncated: boolean;
}

function requestHop(
  url: URL,
  pinned: PinnedAddress,
  maxBytes: number,
  timeoutMs: number,
): Promise<HopResponse> {
  const transport = url.protocol === "https:" ? NodeHttps : NodeHttp;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        // A dedicated agent never picks up an environment proxy, which would
        // resolve the hostname itself and bypass the pinned address.
        agent: false,
        lookup: pinnedLookup(pinned),
        timeout: timeoutMs,
        headers: {
          "accept-encoding": "identity",
          "user-agent": "akeru-bot WebFetch",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        const contentType = response.headers["content-type"] ?? null;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location, contentType, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const remaining = maxBytes - received;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            received = maxBytes;
            truncated = true;
            resolve({ status, location, contentType, body: Buffer.concat(chunks), truncated });
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
          received += chunk.length;
        });
        response.on("end", () =>
          resolve({ status, location, contentType, body: Buffer.concat(chunks), truncated }),
        );
        response.on("error", (error) => {
          if (!truncated) reject(error);
        });
        response.on("close", () => {
          if (!truncated && !response.complete) {
            reject(new Error("WebFetch lost the connection before the response finished."));
          }
        });
      },
    );
    // `timeout` only covers idle sockets. The deadline also bounds a server
    // that trickles bytes to hold the request open.
    const deadline = setTimeout(() => request.destroy(new Error("WebFetch timed out.")), timeoutMs);
    request.on("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("WebFetch timed out.")));
    request.on("error", reject);
    request.end();
  });
}

// A stalled resolver must not hold the tool call open past the fetch deadline.
function lookupWithDeadline(lookup: AkeruWebFetchLookup, timeoutMs: number): AkeruWebFetchLookup {
  return (hostname) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`WebFetch timed out resolving ${hostname}.`)),
        timeoutMs,
      );
      lookup(hostname).then(
        (records) => {
          clearTimeout(deadline);
          resolve(records);
        },
        (cause: unknown) => {
          clearTimeout(deadline);
          reject(cause);
        },
      );
    });
}

export function createAkeruWebFetch(options: AkeruWebFetchOptions = {}) {
  const timeoutMs = options.timeoutMs ?? AKERU_WEB_FETCH_TIMEOUT_MS;
  const lookup = lookupWithDeadline(
    options.lookup ?? ((hostname) => NodeDnsPromises.lookup(hostname, { all: true })),
    timeoutMs,
  );
  const allowAddress = options.allowAddress ?? ((address) => !isAkeruPrivateAddress(address));
  const maxBytes = options.maxBytes ?? AKERU_WEB_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? AKERU_WEB_FETCH_MAX_REDIRECTS;

  return async (input: { readonly url: string }): Promise<AkeruWebFetchResult> => {
    let url = parseAkeruPublicUrl(input.url);
    for (let redirects = 0; ; redirects += 1) {
      const pinned = await resolvePinnedAddress(url, lookup, allowAddress);
      const hop = await requestHop(url, pinned, maxBytes, timeoutMs);
      if (hop.status >= 300 && hop.status < 400) {
        if (!hop.location) throw new Error("WebFetch received a redirect without a location.");
        if (redirects >= maxRedirects) throw new Error("WebFetch followed too many redirects.");
        url = parseAkeruPublicUrl(new URL(hop.location, url).toString());
        continue;
      }
      if (hop.status < 200 || hop.status >= 300) {
        throw new Error(`WebFetch failed with HTTP ${hop.status}.`);
      }
      const text = new TextDecoder().decode(hop.body);
      return {
        url: url.toString(),
        status: hop.status,
        contentType: hop.contentType,
        text: hop.truncated
          ? `${text}${AKERU_WEB_FETCH_TRUNCATION_MARKER} ${maxBytes} bytes.]`
          : text,
        truncated: hop.truncated,
      };
    }
  };
}

/**
 * WebSearch has no search index of its own. Mastra-driven providers do not
 * expose a native search call Akeru can invoke, so the tool reports that plainly
 * instead of inventing results.
 */
export async function akeruWebSearchUnavailable(input: {
  readonly query: string;
  readonly domains?: readonly string[];
}) {
  return {
    status: "unavailable" as const,
    query: input.query,
    results: [],
    reason: "Web search is not available for this bot's provider in Akeru yet.",
    suggestion: "Use WebFetch with a URL you already know.",
  };
}
