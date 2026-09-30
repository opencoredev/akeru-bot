import {
  readHashParams,
  readHostedPairingRequest,
  resolveRemotePairingTarget,
  type HostedPairingRequest,
} from "@t3tools/shared/remote";

import type { PairingPanelStatus } from "./components/auth/PairingPanel";

/**
 * Whether a URL is a hosted pairing link: `/pair?host=…#token=…` opened on any
 * Akeru web origin, such as a tunnel, to save the remote server named by `host`
 * in this browser. A link with a host but no token still counts, so the page
 * can say what is missing instead of pairing with the origin that served it.
 * A link whose host is the page's own origin is ordinary pairing: the browser
 * signs in to this origin and the app opens here.
 */
export function isHostedPairingLink(href: string): boolean {
  const url = new URL(href);
  return url.pathname === "/pair" && url.searchParams.has("host") && !namesPageOrigin(url);
}

function namesPageOrigin(url: URL): boolean {
  const host = url.searchParams.get("host")?.trim() ?? "";
  if (!host) return false;
  try {
    // A scheme-free host would default to HTTPS; on an HTTP LAN origin it
    // still names this page, so resolve it against the page's protocol.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `${url.protocol}//${host}`;
    const { httpBaseUrl } = resolveRemotePairingTarget({
      host: withScheme,
      pairingCode: "origin-check",
    });
    return new URL(httpBaseUrl).origin === url.origin;
  } catch {
    return false;
  }
}

/**
 * The server and token a hosted pairing link carries, or null when either is
 * missing. The token must sit in the fragment: a `?token=` query value already
 * reached the page-serving origin in the request, so it is never submitted.
 */
export function readHostedPairingLink(href: string): HostedPairingRequest | null {
  const url = new URL(href);
  if (url.pathname !== "/pair" || url.searchParams.has("token")) return null;
  const request = readHostedPairingRequest(url);
  return request && readHashParams(url).get("token")?.trim() === request.token ? request : null;
}

export type HostedPairingOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * Hands a hosted link's host and token to `connect` once, and reports the page
 * state that follows. An incomplete link never reaches `connect`.
 */
export async function runHostedPairing(
  request: HostedPairingRequest | null,
  connect: (input: {
    readonly host: string;
    readonly pairingCode: string;
  }) => Promise<HostedPairingOutcome>,
): Promise<PairingPanelStatus> {
  if (!request) return { kind: "incomplete" };
  const outcome = await connect({ host: request.host, pairingCode: request.token });
  return outcome.ok ? { kind: "paired" } : { kind: "failed", message: outcome.message };
}
