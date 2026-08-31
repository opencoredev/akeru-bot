// @effect-diagnostics globalDate:off cryptoRandomUUID:off
import {
  PRODUCT_FEEDBACK_BODY_MAX_BYTES,
  ProductFeedbackSubmission,
  type ProductFeedbackReceipt,
  type ProductFeedbackRejection,
  type ProductFeedbackSubmission as ProductFeedbackSubmissionValue,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const PRODUCT_FEEDBACK_COOLDOWN_SECONDS = 30;
export const PRODUCT_FEEDBACK_NETWORK_COOLDOWN_SECONDS = 5;
export const PRODUCT_FEEDBACK_DUPLICATE_WINDOW_SECONDS = 86_400;
export const PRODUCT_FEEDBACK_IP_WINDOW_SECONDS = 3_600;
export const PRODUCT_FEEDBACK_IP_LIMIT = 20;
export const PRODUCT_FEEDBACK_SUSPICIOUS_AFTER = 5;
export const PRODUCT_FEEDBACK_RETENTION_DAYS = 90;

export interface StoredProductFeedback {
  readonly feedbackId: string;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly installHash: string;
  readonly coarseIpHash: string;
  readonly contentHash: string;
  readonly submission: Omit<
    ProductFeedbackSubmissionValue,
    "installToken" | "turnstileToken" | "website"
  >;
}

export interface ProductFeedbackRepository {
  readonly countByCoarseIpHashSince: (coarseIpHash: string, since: string) => Promise<number>;
  readonly findLatestByInstallHash: (installHash: string) => Promise<StoredProductFeedback | null>;
  readonly hasDuplicateSince: (
    coarseIpHash: string,
    contentHash: string,
    since: string,
  ) => Promise<boolean>;
  readonly tryInsert: (
    feedback: StoredProductFeedback,
    constraints: {
      readonly coarseIpSince: string;
      readonly coarseIpCooldownSince: string;
      readonly installSince: string;
      readonly duplicateSince: string;
      readonly coarseIpLimit: number;
    },
  ) => Promise<"accepted" | "cooldown" | "duplicate" | "rate_limited">;
  readonly deleteExpired: (now: string) => Promise<void>;
}

export interface ProductFeedbackEndpointOptions {
  readonly repository: ProductFeedbackRepository;
  readonly hmacSecret: string;
  readonly resolveIp?: (request: Request) => string;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly turnstile?: {
    readonly siteKey: string;
    readonly verify: (token: string, remoteIp: string) => Promise<boolean>;
  };
}

const decodeSubmission = Schema.decodeUnknownExit(ProductFeedbackSubmission, {
  onExcessProperty: "error",
});
const encoder = new TextEncoder();

function rejection(
  status: number,
  body: ProductFeedbackRejection,
  headers?: HeadersInit,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function receipt(body: ProductFeedbackReceipt): Response {
  return Response.json(body, {
    status: 201,
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
}

function secondsBetween(later: Date, earlierIso: string): number {
  return Math.floor((later.getTime() - new Date(earlierIso).getTime()) / 1_000);
}

function isoSecondsBefore(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1_000).toISOString();
}

function normalizedIpv4(ip: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets.join(".") : null;
}

function normalizedIpv6(ip: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return normalizedIpv4(mapped[1]);
  if (!/^[0-9a-f:]+$/i.test(ip) || ip.split("::").length > 2) return null;
  const [left = "", right = ""] = ip.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 0 || (!ip.includes("::") && missing !== 0)) return null;
  const groups = [...leftGroups, ...Array.from({ length: missing }, () => "0"), ...rightGroups];
  if (groups.length !== 8 || groups.some((group) => group.length > 4)) return null;
  return groups.map((group) => group.padStart(4, "0").toLowerCase()).join(":");
}

export function coarseIpAddress(ip: string): string {
  const value = ip.trim().toLowerCase();
  const ipv4 = normalizedIpv4(value);
  if (ipv4) return `${ipv4.split(".").slice(0, 3).join(".")}.0/24`;
  const ipv6 = normalizedIpv6(value);
  if (!ipv6) return "unknown";
  const mappedIpv4 = normalizedIpv4(ipv6);
  if (mappedIpv4) return `${mappedIpv4.split(".").slice(0, 3).join(".")}.0/24`;
  return `${ipv6.split(":").slice(0, 4).join(":")}::/64`;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function contentFingerprint(submission: ProductFeedbackSubmissionValue): string {
  return JSON.stringify({
    feedback: submission.feedback,
    element: submission.element,
  });
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > PRODUCT_FEEDBACK_BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function makeProductFeedbackEndpoint(options: ProductFeedbackEndpointOptions) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const resolveIp =
    options.resolveIp ?? ((request) => request.headers.get("cf-connecting-ip") ?? "unknown");

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === "OPTIONS") return optionsResponse();
      if (request.method !== "POST") {
        return rejection(405, { reason: "malformed", message: "Use POST for feedback." });
      }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return rejection(400, { reason: "malformed", message: "Send feedback as JSON." });
      }

      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > PRODUCT_FEEDBACK_BODY_MAX_BYTES) {
        return rejection(413, {
          reason: "oversized",
          message: "The feedback payload is too large.",
        });
      }

      let text: string | null;
      try {
        text = await readBoundedBody(request);
      } catch {
        return rejection(400, { reason: "malformed", message: "The feedback body is invalid." });
      }
      if (text === null) {
        return rejection(413, {
          reason: "oversized",
          message: "The feedback payload is too large.",
        });
      }

      let untrusted: unknown;
      try {
        untrusted = JSON.parse(text);
      } catch {
        return rejection(400, {
          reason: "malformed",
          message: "The feedback payload is not JSON.",
        });
      }
      if (
        typeof untrusted === "object" &&
        untrusted !== null &&
        "website" in untrusted &&
        typeof untrusted.website === "string" &&
        untrusted.website.length > 0
      ) {
        return rejection(400, {
          reason: "honeypot",
          message: "The feedback payload was rejected.",
        });
      }

      const decoded = decodeSubmission(untrusted);
      if (Exit.isFailure(decoded)) {
        return rejection(400, { reason: "malformed", message: "The feedback fields are invalid." });
      }

      const submission = decoded.value;
      const current = now();
      const ip = resolveIp(request);
      const [installHash, coarseIpHash, contentHash] = await Promise.all([
        hmac(options.hmacSecret, `install:${submission.installToken}`),
        hmac(options.hmacSecret, `ip:${coarseIpAddress(ip)}`),
        hmac(options.hmacSecret, `content:${contentFingerprint(submission)}`),
      ]);
      const ipCount = await options.repository.countByCoarseIpHashSince(
        coarseIpHash,
        isoSecondsBefore(current, PRODUCT_FEEDBACK_IP_WINDOW_SECONDS),
      );
      if (ipCount >= PRODUCT_FEEDBACK_IP_LIMIT) {
        return rejection(
          429,
          {
            reason: "rate_limited",
            message: "Too many feedback submissions came from this network. Try again later.",
            retryAfterSeconds: PRODUCT_FEEDBACK_IP_WINDOW_SECONDS,
          },
          { "Retry-After": String(PRODUCT_FEEDBACK_IP_WINDOW_SECONDS) },
        );
      }

      if (ipCount >= PRODUCT_FEEDBACK_SUSPICIOUS_AFTER && options.turnstile) {
        if (!submission.turnstileToken) {
          return rejection(429, {
            reason: "challenge_required",
            message: "Complete the verification challenge before sending feedback.",
            challengeSiteKey: options.turnstile.siteKey,
          });
        }
        if (!(await options.turnstile.verify(submission.turnstileToken, ip))) {
          return rejection(400, {
            reason: "challenge_failed",
            message: "The verification challenge failed. Try again.",
          });
        }
      }

      const latest = await options.repository.findLatestByInstallHash(installHash);
      if (latest) {
        const elapsed = secondsBetween(current, latest.receivedAt);
        if (elapsed < PRODUCT_FEEDBACK_COOLDOWN_SECONDS) {
          const retryAfterSeconds = PRODUCT_FEEDBACK_COOLDOWN_SECONDS - Math.max(0, elapsed);
          return rejection(
            429,
            {
              reason: "cooldown",
              message: "Wait before sending more feedback from this installation.",
              retryAfterSeconds,
            },
            { "Retry-After": String(retryAfterSeconds) },
          );
        }
      }

      const duplicate = await options.repository.hasDuplicateSince(
        coarseIpHash,
        contentHash,
        isoSecondsBefore(current, PRODUCT_FEEDBACK_DUPLICATE_WINDOW_SECONDS),
      );
      if (duplicate) {
        return rejection(409, {
          reason: "duplicate",
          message: "This feedback was already received.",
        });
      }

      const feedbackId = `fb_${randomId()}`;
      const receivedAt = current.toISOString();
      const expiresAt = new Date(
        current.getTime() + PRODUCT_FEEDBACK_RETENTION_DAYS * 86_400_000,
      ).toISOString();
      const { installToken: _, turnstileToken: __, website: ___, ...safeSubmission } = submission;
      const acceptance = await options.repository.tryInsert(
        {
          feedbackId,
          receivedAt,
          expiresAt,
          installHash,
          coarseIpHash,
          contentHash,
          submission: safeSubmission,
        },
        {
          coarseIpSince: isoSecondsBefore(current, PRODUCT_FEEDBACK_IP_WINDOW_SECONDS),
          coarseIpCooldownSince: isoSecondsBefore(
            current,
            PRODUCT_FEEDBACK_NETWORK_COOLDOWN_SECONDS,
          ),
          installSince: isoSecondsBefore(current, PRODUCT_FEEDBACK_COOLDOWN_SECONDS),
          duplicateSince: isoSecondsBefore(current, PRODUCT_FEEDBACK_DUPLICATE_WINDOW_SECONDS),
          coarseIpLimit: PRODUCT_FEEDBACK_IP_LIMIT,
        },
      );
      if (acceptance === "rate_limited") {
        return rejection(429, {
          reason: "rate_limited",
          message: "Too many feedback submissions came from this network. Try again later.",
          retryAfterSeconds: PRODUCT_FEEDBACK_IP_WINDOW_SECONDS,
        });
      }
      if (acceptance === "cooldown") {
        return rejection(429, {
          reason: "cooldown",
          message: "Wait before sending more feedback from this installation.",
          retryAfterSeconds: PRODUCT_FEEDBACK_COOLDOWN_SECONDS,
        });
      }
      if (acceptance === "duplicate") {
        return rejection(409, {
          reason: "duplicate",
          message: "This feedback was already received.",
        });
      }
      await options.repository.deleteExpired(receivedAt).catch(() => undefined);
      return receipt({ feedbackId, receivedAt });
    } catch {
      return rejection(500, {
        reason: "internal",
        message: "Akeru could not store the feedback. The draft is still available.",
      });
    }
  };
}
