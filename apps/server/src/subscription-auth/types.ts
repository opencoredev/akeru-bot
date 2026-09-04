/**
 * Subscription provider OAuth types.
 *
 * Ported from Mastra Code (mastra-ai/mastra, `mastracode/sdk/src/auth`),
 * Apache-2.0. A provider here is a consumer subscription (Claude Pro/Max,
 * ChatGPT, Cursor, Kimi For Coding, X Premium, or OpenCode Go) that the agent
 * runtime uses. Most providers use OAuth. OpenCode Go uses an API key.
 */

export interface OAuthCredentials {
  refresh: string;
  access: string;
  /** ms epoch after which `access` must be refreshed. */
  expires: number;
  [key: string]: unknown;
}

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export interface ApiKeyCredential {
  readonly type: "api-key";
  readonly access: string;
  readonly baseUrl?: string;
}

export type SubscriptionCredential = OAuthCredential | ApiKeyCredential;

export type SubscriptionAuthData = Record<string, SubscriptionCredential>;
