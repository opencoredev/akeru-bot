// @effect-diagnostics globalFetch:off globalDate:off
import { StoredProductFeedbackSubmission } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { FeedbackWorkerEnv } from "../alchemy.run.ts";
import {
  makeProductFeedbackEndpoint,
  productFeedbackOptionsResponse,
  type ProductFeedbackRepository,
} from "./endpoint.ts";

interface FeedbackRow {
  readonly feedback_id: string;
  readonly received_at: string;
  readonly expires_at: string;
  readonly install_hash: string;
  readonly coarse_ip_hash: string;
  readonly content_hash: string;
  readonly payload_json: string;
}

const TurnstileResponse = Schema.Struct({ success: Schema.Boolean });
const decodeStoredProductFeedbackSubmission = Schema.decodeUnknownExit(
  StoredProductFeedbackSubmission,
  { onExcessProperty: "error" },
);
const decodeTurnstileResponse = Schema.decodeUnknownExit(TurnstileResponse);

export function makeRepository(database: FeedbackWorkerEnv["DB"]): ProductFeedbackRepository {
  return {
    countByCoarseIpHashSince: async (hash, since) => {
      const row = await database
        .prepare(
          "SELECT COUNT(*) AS count FROM akeru_feedback_inbox WHERE coarse_ip_hash = ? AND received_at >= ?",
        )
        .bind(hash, since)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    findLatestByInstallHash: async (hash) => {
      const row = await database
        .prepare(
          "SELECT * FROM akeru_feedback_inbox WHERE install_hash = ? ORDER BY received_at DESC LIMIT 1",
        )
        .bind(hash)
        .first<FeedbackRow>();
      if (!row) return null;
      const decoded = decodeStoredProductFeedbackSubmission(JSON.parse(row.payload_json));
      if (Exit.isFailure(decoded)) {
        throw new Error("Stored feedback payload is invalid.");
      }
      return {
        feedbackId: row.feedback_id,
        receivedAt: row.received_at,
        expiresAt: row.expires_at,
        installHash: row.install_hash,
        coarseIpHash: row.coarse_ip_hash,
        contentHash: row.content_hash,
        submission: decoded.value,
      };
    },
    tryInsert: async (feedback, constraints) => {
      const result = await database
        .prepare(
          `INSERT INTO akeru_feedback_inbox
            (feedback_id, received_at, expires_at, install_hash, coarse_ip_hash, content_hash, payload_json)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM akeru_feedback_inbox
                  WHERE coarse_ip_hash = ? AND received_at >= ?) < ?
             AND NOT EXISTS (SELECT 1 FROM akeru_feedback_inbox
                             WHERE coarse_ip_hash = ? AND received_at >= ?)
             AND NOT EXISTS (SELECT 1 FROM akeru_feedback_inbox
                             WHERE install_hash = ? AND received_at >= ?)
             AND NOT EXISTS (SELECT 1 FROM akeru_feedback_inbox
                             WHERE coarse_ip_hash = ? AND content_hash = ? AND received_at >= ?)`,
        )
        .bind(
          feedback.feedbackId,
          feedback.receivedAt,
          feedback.expiresAt,
          feedback.installHash,
          feedback.coarseIpHash,
          feedback.contentHash,
          JSON.stringify(feedback.submission),
          feedback.coarseIpHash,
          constraints.coarseIpSince,
          constraints.coarseIpLimit,
          feedback.coarseIpHash,
          constraints.coarseIpCooldownSince,
          feedback.installHash,
          constraints.installSince,
          feedback.coarseIpHash,
          feedback.contentHash,
          constraints.duplicateSince,
        )
        .run();
      if (result.meta.changes === 1) return "accepted";
      if (
        ((
          await database
            .prepare(
              "SELECT COUNT(*) AS count FROM akeru_feedback_inbox WHERE coarse_ip_hash = ? AND received_at >= ?",
            )
            .bind(feedback.coarseIpHash, constraints.coarseIpSince)
            .first<{ count: number }>()
        )?.count ?? 0) >= constraints.coarseIpLimit
      ) {
        return "rate_limited";
      }
      if (
        (await database
          .prepare(
            "SELECT feedback_id FROM akeru_feedback_inbox WHERE coarse_ip_hash = ? AND received_at >= ? LIMIT 1",
          )
          .bind(feedback.coarseIpHash, constraints.coarseIpCooldownSince)
          .first()) !== null
      ) {
        return "cooldown";
      }
      if (
        (await database
          .prepare(
            "SELECT feedback_id FROM akeru_feedback_inbox WHERE install_hash = ? AND received_at >= ? LIMIT 1",
          )
          .bind(feedback.installHash, constraints.installSince)
          .first()) !== null
      ) {
        return "cooldown";
      }
      return "duplicate";
    },
    deleteExpired: async (now) => {
      await database
        .prepare("DELETE FROM akeru_feedback_inbox WHERE expires_at <= ?")
        .bind(now)
        .run();
    },
  };
}

function makeTurnstile(env: FeedbackWorkerEnv) {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return undefined;
  return {
    siteKey: env.TURNSTILE_SITE_KEY,
    verify: async (token: string, remoteIp: string) => {
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: remoteIp,
        }),
      });
      if (!response.ok) return false;
      const decoded = decodeTurnstileResponse(await response.json());
      return Exit.isSuccess(decoded) && decoded.value.success;
    },
  };
}

function validHmacSecret(secret: string): boolean {
  return new TextEncoder().encode(secret).byteLength >= 32;
}

export default {
  async fetch(request: Request, env: FeedbackWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/feedback") {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "OPTIONS") return productFeedbackOptionsResponse();
    if (!validHmacSecret(env.HMAC_SECRET)) {
      return Response.json(
        { reason: "disabled", message: "Product feedback is not configured." },
        {
          status: 503,
          headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        },
      );
    }
    // Without Turnstile keys the endpoint still runs, but the suspicious-traffic
    // threshold becomes a hard network limit instead of a challenge.
    const turnstile = makeTurnstile(env);
    return makeProductFeedbackEndpoint({
      repository: makeRepository(env.DB),
      hmacSecret: env.HMAC_SECRET,
      ...(turnstile ? { turnstile } : {}),
    })(request);
  },
  async scheduled(
    _controller: ScheduledController,
    env: FeedbackWorkerEnv,
    _context: ExecutionContext,
  ): Promise<void> {
    await makeRepository(env.DB).deleteExpired(new Date().toISOString());
  },
};
