import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import * as CodexRpc from "./rpc.ts";

export const encodeUnknownJsonString = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown),
);

export const encoder = new TextEncoder();

export const encodeJsonl = flow(encodeUnknownJsonString, (encoded) =>
  encoder.encode(`${encoded}\n`),
);

export const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const decodeAccountTokenUsageResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
);

export const decodeAccountRateLimitsResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
);

export const decodeConsumeRateLimitResetCreditParams = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
);

export const decodeConsumeRateLimitResetCreditResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
);
